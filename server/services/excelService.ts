import zlib from 'node:zlib';
import ExcelJS from 'exceljs';

export const MAX_XLSX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB raw .xlsx upload limit
export const MAX_XLSX_BASE64_CHARS = Math.ceil((MAX_XLSX_UPLOAD_BYTES * 4) / 3) + 1024;
export const MAX_ZIP_ENTRIES = 200;
export const MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES = 15 * 1024 * 1024; // 15 MB per XML entry
export const MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES = 30 * 1024 * 1024; // 30 MB total decompressed
export const MAX_XLSX_IMPORT_ROWS = 5000;
export const MAX_XLSX_IMPORT_COLS = 50;

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP_LOCAL_HEADER_SIG = 0x04034b50;
const ZIP_CENTRAL_HEADER_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;

export function isSafeSpreadsheetKey(key: string): boolean {
  const trimmed = key.trim();
  if (!trimmed) return false;
  return !FORBIDDEN_KEYS.has(trimmed) && !FORBIDDEN_KEYS.has(trimmed.toLowerCase());
}

export function sanitizeCellForExport(value: unknown): string | number | boolean | Date | null {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : '';
  }
  if (typeof value === 'boolean') return value;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value;
  }
  const str = typeof value === 'string' ? value : String(value);
  // Neutralize spreadsheet formula prefixes (=, @, tab, CR, or +/- followed by non-numeric formula expressions)
  if (/^[=@\t\r]|^[+-](?!\d+(?:\.\d+)?$)/.test(str)) {
    return `'${str}`;
  }
  return str;
}

function findZipEocdOffset(buffer: Buffer): number {
  const minOffset = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= minOffset; i--) {
    if (buffer.readUInt32LE(i) === ZIP_EOCD_SIG) {
      return i;
    }
  }
  return -1;
}

/**
 * Defensive pre-parse inspection of untrusted .xlsx (OOXML ZIP) uploads.
 * Rejects non-XLSX formats, legacy .xls, macros/ActiveX/OLE embeddings, path traversal,
 * forged headers, and DEFLATE ZIP bombs before ExcelJS loads the archive.
 */
export function validateXlsxBufferSafety(buffer: Buffer): void {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('Excel file payload is empty');
  }
  if (buffer.length > MAX_XLSX_UPLOAD_BYTES) {
    throw new Error(`Excel file exceeds maximum upload size of ${Math.round(MAX_XLSX_UPLOAD_BYTES / (1024 * 1024))} MB`);
  }
  if (buffer.length < 22) {
    throw new Error('Invalid Excel file: file is too small or corrupted');
  }
  if (buffer.subarray(0, 8).equals(OLE2_MAGIC)) {
    throw new Error('Legacy binary .xls files are not supported. Please save as .xlsx and re-upload.');
  }
  if (buffer.readUInt32LE(0) !== ZIP_LOCAL_HEADER_SIG) {
    throw new Error('Invalid file format: expected a valid .xlsx Excel workbook');
  }

  const eocdOffset = findZipEocdOffset(buffer);
  if (eocdOffset < 0) {
    throw new Error('Malformed .xlsx workbook: missing ZIP central directory');
  }

  const diskNumber = buffer.readUInt16LE(eocdOffset + 4);
  const cdDisk = buffer.readUInt16LE(eocdOffset + 6);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const cdSize = buffer.readUInt32LE(eocdOffset + 12);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);

  if (
    diskNumber !== 0 ||
    cdDisk !== 0 ||
    entryCount === 0xffff ||
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff
  ) {
    throw new Error('Unsupported or malformed .xlsx archive structure');
  }
  if (entryCount === 0) {
    throw new Error('Malformed .xlsx workbook: archive contains no entries');
  }
  if (entryCount > MAX_ZIP_ENTRIES) {
    throw new Error(`Excel archive exceeds maximum allowed structure entries (${MAX_ZIP_ENTRIES})`);
  }
  if (cdOffset + cdSize > eocdOffset) {
    throw new Error('Malformed .xlsx workbook: central directory bounds are invalid');
  }

  let cursor = cdOffset;
  let totalUncompressed = 0;
  let hasContentTypes = false;
  let hasWorkbookXml = false;

  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > cdOffset + cdSize) {
      throw new Error('Malformed .xlsx workbook: truncated central directory entry');
    }
    if (buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_HEADER_SIG) {
      throw new Error('Malformed .xlsx workbook: invalid central directory signature');
    }

    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const declaredUncompressed = buffer.readUInt32LE(cursor + 24);
    const fileNameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);

    const nameStart = cursor + 46;
    const nextCursor = nameStart + fileNameLen + extraLen + commentLen;
    if (nextCursor > cdOffset + cdSize) {
      throw new Error('Malformed .xlsx workbook: entry metadata exceeds directory bounds');
    }

    const rawName = buffer.subarray(nameStart, nameStart + fileNameLen).toString('utf8');
    if (rawName.includes('\0') || rawName.length > 512) {
      throw new Error('Malformed .xlsx workbook: unsafe internal entry name');
    }
    const normalizedName = rawName.replace(/\\/g, '/');
    if (normalizedName.startsWith('/') || normalizedName.split('/').includes('..')) {
      throw new Error('Malformed .xlsx workbook: path traversal detected in archive');
    }

    const lowerName = normalizedName.toLowerCase();
    if (
      /(^|\/)vbaproject[^/]*\.bin$/i.test(lowerName) ||
      /^xl\/(activex|embeddings|macrosheets)\//i.test(lowerName) ||
      /^xl\/.*\.bin$/i.test(lowerName)
    ) {
      throw new Error('Macro-enabled or embedded-script workbooks (.xlsm/.bin/ActiveX) are blocked for security');
    }

    if (lowerName === '[content_types].xml') hasContentTypes = true;
    if (lowerName === 'xl/workbook.xml') hasWorkbookXml = true;

    if (declaredUncompressed > MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES) {
      throw new Error('Excel workbook contains an oversized entry');
    }

    // Verify local file header bounds and bound-checked inflate to block forged-size ZIP bombs
    if (localHeaderOffset + 30 > cdOffset) {
      throw new Error('Malformed .xlsx workbook: invalid local file offset');
    }
    if (buffer.readUInt32LE(localHeaderOffset) !== ZIP_LOCAL_HEADER_SIG) {
      throw new Error('Malformed .xlsx workbook: invalid local entry signature');
    }
    const localNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > cdOffset) {
      throw new Error('Malformed .xlsx workbook: compressed entry exceeds archive bounds');
    }

    let actualUncompressed = declaredUncompressed;
    if (compressionMethod === 8 && compressedSize > 0) {
      let inflated: Buffer;
      try {
        inflated = zlib.inflateRawSync(buffer.subarray(dataStart, dataEnd), {
          maxOutputLength: MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES,
        });
      } catch (err) {
        const code = (err as { code?: string })?.code;
        if (code === 'ERR_BUFFER_TOO_LARGE') {
          throw new Error('Excel workbook rejected: decompressed entry exceeds safety limit');
        }
        throw new Error('Malformed .xlsx workbook: corrupted compressed entry');
      }
      actualUncompressed = inflated.length;
      if (actualUncompressed > 1024 * 1024 && actualUncompressed / Math.max(compressedSize, 1) > 100) {
        throw new Error('Excel workbook rejected: suspicious compression ratio detected');
      }
    } else if (compressionMethod !== 0 && compressedSize > 0) {
      throw new Error('Unsupported compression method inside .xlsx workbook');
    }

    totalUncompressed += actualUncompressed;
    if (totalUncompressed > MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES) {
      throw new Error('Excel workbook rejected: total decompressed size exceeds safety limit');
    }

    cursor = nextCursor;
  }

  if (!hasContentTypes || !hasWorkbookXml) {
    throw new Error('Invalid .xlsx workbook: missing required Excel workbook metadata');
  }
}

function cellValueToPlain(value: ExcelJS.CellValue): unknown {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return typeof value === 'number' && !Number.isFinite(value) ? '' : value;
  }
  if (typeof value === 'object') {
    if ('error' in value) return '';
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part?.text || '').join('');
    }
    if ('text' in value && typeof value.text === 'string') {
      return value.text;
    }
    if ('result' in value) {
      return cellValueToPlain(value.result as ExcelJS.CellValue);
    }
  }
  return '';
}

export async function parseXlsxFirstSheetToRows(
  buffer: Buffer,
  options: {
    requiredHeaders?: string[];
    maxRows?: number;
    maxCols?: number;
  } = {}
): Promise<Array<Record<string, unknown>>> {
  validateXlsxBufferSafety(buffer);

  const maxRows = options.maxRows ?? MAX_XLSX_IMPORT_ROWS;
  const maxCols = options.maxCols ?? MAX_XLSX_IMPORT_COLS;

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unable to parse Excel workbook';
    throw new Error(`Malformed .xlsx workbook: ${msg}`);
  }

  const ws = wb.worksheets[0];
  if (!ws) {
    throw new Error('Excel workbook contains no sheets');
  }

  if (ws.actualRowCount > maxRows + 1 || ws.rowCount > maxRows * 4) {
    throw new Error(`Excel sheet exceeds maximum allowed limit of ${maxRows} rows`);
  }
  if (ws.actualColumnCount > maxCols || ws.columnCount > maxCols * 2) {
    throw new Error(`Excel sheet exceeds maximum allowed limit of ${maxCols} columns`);
  }

  const headerRow = ws.getRow(1);
  const colToHeader = new Map<number, string>();
  const seenHeaders = new Set<string>();

  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    if (colNumber > maxCols) return;
    const rawHeader = String(cellValueToPlain(cell.value) ?? '').trim();
    if (!rawHeader || !isSafeSpreadsheetKey(rawHeader)) return;
    if (!seenHeaders.has(rawHeader)) {
      colToHeader.set(colNumber, rawHeader);
      seenHeaders.add(rawHeader);
    }
  });

  if (colToHeader.size === 0 || ws.actualRowCount === 0) {
    throw new Error('Excel worksheet is empty (no header row found)');
  }

  if (options.requiredHeaders && options.requiredHeaders.length > 0) {
    const missing = options.requiredHeaders.filter((reqCol) => !seenHeaders.has(reqCol));
    if (missing.length > 0) {
      throw new Error(`Missing required column(s): ${missing.join(', ')}`);
    }
  }

  const result: Array<Record<string, unknown>> = [];
  const lastRow = Math.min(ws.rowCount, maxRows * 4);

  for (let rowIdx = 2; rowIdx <= lastRow; rowIdx++) {
    const row = ws.getRow(rowIdx);
    if (!row || !row.hasValues) continue;

    const record = Object.create(null) as Record<string, unknown>;
    let hasNonEmptyValue = false;

    for (const [colNumber, headerName] of colToHeader.entries()) {
      const val = cellValueToPlain(row.getCell(colNumber).value);
      const asStr = typeof val === 'string' ? val.trim() : String(val ?? '').trim();
      if (asStr !== '') hasNonEmptyValue = true;
      Object.defineProperty(record, headerName, {
        value: val,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }

    if (!hasNonEmptyValue) continue;

    if (result.length >= maxRows) {
      throw new Error(`Excel sheet exceeds maximum allowed limit of ${maxRows} data rows`);
    }
    result.push(record);
  }

  return result;
}

function sanitizeSheetName(name: string, index: number): string {
  const cleaned = name.replace(/[\[\]:*?/\\]/g, '_').trim().slice(0, 31);
  return cleaned || `Sheet${index + 1}`;
}

export async function writeSheetsToXlsxBuffer(
  sheets: Array<{ name: string; rows: Array<Record<string, unknown>> }>
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'MediNest';
  wb.created = new Date();

  sheets.forEach((sheetSpec, idx) => {
    const ws = wb.addWorksheet(sanitizeSheetName(sheetSpec.name, idx));
    const rows = sheetSpec.rows || [];
    if (rows.length === 0) return;

    const headerSet = new Set<string>();
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        if (isSafeSpreadsheetKey(key)) {
          headerSet.add(key);
        }
      }
    }
    const headers = Array.from(headerSet);
    if (headers.length === 0) return;

    const headerRow = ws.addRow(headers);
    headerRow.font = { bold: true };

    for (const row of rows) {
      ws.addRow(
        headers.map((key) =>
          sanitizeCellForExport(Object.prototype.hasOwnProperty.call(row, key) ? row[key] : '')
        )
      );
    }

    ws.columns = headers.map((header) => {
      let maxLen = header.length;
      const sampleCount = Math.min(rows.length, 50);
      for (let i = 0; i < sampleCount; i++) {
        const val = rows[i][header];
        const len = val === null || val === undefined ? 0 : String(val).length;
        if (len > maxLen) maxLen = len;
      }
      return { width: Math.min(48, Math.max(12, maxLen + 2)) };
    });
  });

  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}
