import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, LICENSE_PATH, getDb, nowIso, todayDate, uuid, withTransaction } from './db.ts';
import { hashPassword } from './auth.ts';
import { recordAudit } from './audit.ts';
import { canonicalLicensePayload, type LicensePayload } from './licensing.ts';

const PERMISSIONS: Array<{ code: string; module: string; label: string }> = [
  { code: 'pos.sell', module: 'POS & Sales', label: 'Complete POS Sales' },
  { code: 'pos.discount', module: 'POS & Sales', label: 'Apply Line & Invoice Discounts' },
  { code: 'pos.manual_batch', module: 'POS & Sales', label: 'Override FEFO Batch Selection' },
  { code: 'sales.view', module: 'POS & Sales', label: 'View Sales & Reprint Invoices' },
  { code: 'sales.return', module: 'Returns', label: 'Process Sales Returns & Inspection' },
  { code: 'sales.reverse', module: 'POS & Sales', label: 'Reverse Completed Sales' },
  { code: 'medicines.view', module: 'Medicines', label: 'View Medicines & Units' },
  { code: 'medicines.manage', module: 'Medicines', label: 'Create/Edit Medicines & Import Excel' },
  { code: 'medicines.units', module: 'Medicines', label: 'Configure Manual Medicine Units & Ratios' },
  { code: 'inventory.view', module: 'Inventory', label: 'View Batches, Stock & Ledger' },
  { code: 'inventory.adjust', module: 'Inventory', label: 'Perform Stock Adjustments & Write-Offs' },
  { code: 'inventory.expiry', module: 'Inventory', label: 'Manage Quarantine & Expired Stock' },
  { code: 'purchases.view', module: 'Purchasing', label: 'View Purchases & Returns' },
  { code: 'purchases.create', module: 'Purchasing', label: 'Create Purchase Drafts' },
  { code: 'purchases.receive', module: 'Purchasing', label: 'Receive Purchases into Batches' },
  { code: 'purchases.return', module: 'Purchasing', label: 'Process Purchase Returns' },
  { code: 'purchases.reverse', module: 'Purchasing', label: 'Reverse Received Purchases' },
  { code: 'parties.view', module: 'Customers & Suppliers', label: 'View Customers, Suppliers & Dues' },
  { code: 'parties.manage', module: 'Customers & Suppliers', label: 'Manage Customers & Suppliers' },
  { code: 'payments.record', module: 'Finance', label: 'Record Customer & Supplier Payments' },
  { code: 'payments.reverse', module: 'Finance', label: 'Reverse Posted Payments' },
  { code: 'cash.open', module: 'Cash Session', label: 'Open Cash Session' },
  { code: 'cash.close', module: 'Cash Session', label: 'Close Cash Session' },
  { code: 'cash.force_close', module: 'Cash Session', label: 'Force-Close Forgotten Cash Session' },
  { code: 'expenses.manage', module: 'Finance', label: 'Record Expenses' },
  { code: 'expenses.reverse', module: 'Finance', label: 'Reverse Posted Expenses' },
  { code: 'reports.view', module: 'Reports', label: 'View Sales, Stock & Financial Reports' },
  { code: 'reports.profit', module: 'Reports', label: 'View COGS & Profit Reports' },
  { code: 'admin.users', module: 'Administration', label: 'Manage Users & Roles' },
  { code: 'admin.permissions', module: 'Administration', label: 'Configure Global & Individual Permissions' },
  { code: 'admin.settings', module: 'Administration', label: 'Edit Pharmacy Settings & Setup' },
  { code: 'admin.backup', module: 'Administration', label: 'Create, Verify & Restore Backups' },
  { code: 'admin.license', module: 'Administration', label: 'Manage Offline License' },
  { code: 'admin.audit', module: 'Administration', label: 'View & Verify Audit Log' },
];

function addDays(baseIsoDate: string, days: number): string {
  const dt = new Date(`${baseIsoDate}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function seedDatabaseIfEmpty(): void {
  const db = getDb();
  const existingUser = db.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number };
  if (existingUser.cnt > 0) {
    ensureSeedLicense();
    return;
  }

  const ts = nowIso();
  const today = todayDate();
  const datePart = today.replace(/-/g, '');

  withTransaction((tx) => {
    // 1. Pharmacy settings (MediNest English defaults, Official A5 standard)
    tx.prepare(
      `INSERT OR IGNORE INTO pharmacy_settings (id, pharmacy_name, pharmacy_name_bn, printer_type, updated_at)
       VALUES (1, 'MediNest', '', 'A5', ?)`
    ).run(ts);

    // 2. Permissions
    const insertPerm = tx.prepare(
      'INSERT OR IGNORE INTO permissions (code, module, label, description) VALUES (?, ?, ?, ?)'
    );
    for (const p of PERMISSIONS) {
      insertPerm.run(p.code, p.module, p.label, p.label);
    }

    // 3. Roles
    const adminRoleId = uuid();
    const managerRoleId = uuid();
    const cashierRoleId = uuid();

    tx.prepare('INSERT INTO roles (id, name, description, is_system, created_at) VALUES (?, ?, ?, ?, ?)').run(
      adminRoleId,
      'Super Admin',
      'Full pharmacy administrative and operational control',
      1,
      ts
    );
    tx.prepare('INSERT INTO roles (id, name, description, is_system, created_at) VALUES (?, ?, ?, ?, ?)').run(
      managerRoleId,
      'Pharmacy Manager',
      'Inventory, purchasing, returns, cash sessions, and operational reports',
      1,
      ts
    );
    tx.prepare('INSERT INTO roles (id, name, description, is_system, created_at) VALUES (?, ?, ?, ?, ?)').run(
      cashierRoleId,
      'POS Cashier',
      'Front-counter POS sales, customer lookup, and receipt printing',
      1,
      ts
    );

    const insertRP = tx.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_code) VALUES (?, ?)');
    for (const p of PERMISSIONS) {
      insertRP.run(adminRoleId, p.code);
    }

    const managerPerms = PERMISSIONS.map((p) => p.code).filter(
      (c) => !['admin.users', 'admin.permissions', 'admin.backup', 'admin.license'].includes(c)
    );
    for (const c of managerPerms) {
      insertRP.run(managerRoleId, c);
    }

    const cashierPerms = [
      'pos.sell',
      'pos.discount',
      'sales.view',
      'medicines.view',
      'inventory.view',
      'parties.view',
      'payments.record',
      'cash.open',
      'cash.close',
    ];
    for (const c of cashierPerms) {
      insertRP.run(cashierRoleId, c);
    }

    // 4. Users
    const adminId = uuid();
    const managerId = uuid();
    const cashierId = uuid();

    tx.prepare(
      `INSERT INTO users (id, username, full_name, phone, email, password_hash, role_id, is_super_admin, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(adminId, 'admin', 'Tariqul Islam', '+1 (555) 010-0111', 'admin@medinest.local', hashPassword('Admin@123'), adminRoleId, 1, 1, ts, ts);

    tx.prepare(
      `INSERT INTO users (id, username, full_name, phone, email, password_hash, role_id, is_super_admin, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(managerId, 'manager', 'Farhana Yasmin', '+1 (555) 010-0222', 'manager@medinest.local', hashPassword('Manager@123'), managerRoleId, 0, 1, ts, ts);

    tx.prepare(
      `INSERT INTO users (id, username, full_name, phone, email, password_hash, role_id, is_super_admin, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(cashierId, 'cashier', 'Rakibul Hasan', '+1 (555) 010-0333', 'cashier@medinest.local', hashPassword('Cashier@123'), cashierRoleId, 0, 1, ts, ts);

    tx.prepare(
      `INSERT INTO user_permission_overrides (user_id, permission_code, effect, reason, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(cashierId, 'sales.return', 'ALLOW', 'Senior counter cashier authorized for returns', adminId, ts);

    // 5. Categories & Manufacturers
    const categories = [
      { id: uuid(), name: 'Analgesic & Antipyretic', description: 'Pain and fever relief' },
      { id: uuid(), name: 'Proton Pump Inhibitor', description: 'Gastric & acid control' },
      { id: uuid(), name: 'Antibiotic', description: 'Prescription antibacterial therapy' },
      { id: uuid(), name: 'Respiratory & Anti-Allergic', description: 'Asthma & rhinitis management' },
      { id: uuid(), name: 'Antidiabetic', description: 'Blood glucose management' },
      { id: uuid(), name: 'Vitamin & Mineral', description: 'Nutritional supplements' },
    ];
    for (const c of categories) {
      tx.prepare('INSERT INTO categories (id, name, description) VALUES (?, ?, ?)').run(c.id, c.name, c.description);
    }

    const manufacturers = [
      { id: uuid(), name: 'Beximco Pharmaceuticals Ltd.', country: 'Bangladesh', phone: '+880-2-58611001' },
      { id: uuid(), name: 'Square Pharmaceuticals PLC', country: 'Bangladesh', phone: '+880-2-8833047' },
      { id: uuid(), name: 'Healthcare Pharmaceuticals Ltd.', country: 'Bangladesh', phone: '+880-2-9886394' },
      { id: uuid(), name: 'Incepta Pharmaceuticals Ltd.', country: 'Bangladesh', phone: '+880-2-8891688' },
      { id: uuid(), name: 'ACME Laboratories Ltd.', country: 'Bangladesh', phone: '+880-2-9004194' },
    ];
    for (const m of manufacturers) {
      tx.prepare('INSERT INTO manufacturers (id, name, country, phone) VALUES (?, ?, ?, ?)').run(m.id, m.name, m.country, m.phone);
    }

    // 6. Suppliers
    const sup1 = uuid();
    const sup2 = uuid();
    tx.prepare(
      `INSERT INTO suppliers (id, code, name, contact_person, phone, address, return_policy_days, return_policy_notes, opening_balance, current_balance, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      sup1,
      'SUP-001',
      'Central Pharma Distributors',
      'Kamrul Ahsan',
      '+1 (555) 201-9001',
      '45 Wholesale Medical Plaza',
      45,
      'Unopened strips/boxes accepted up to 45 days before expiry',
      '0.00',
      '0.00',
      ts,
      ts
    );
    tx.prepare(
      `INSERT INTO suppliers (id, code, name, contact_person, phone, address, return_policy_days, return_policy_notes, opening_balance, current_balance, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      sup2,
      'SUP-002',
      'Metro Regional Depot',
      'Nazmul Huda',
      '+1 (555) 201-9002',
      '88 North Distribution Way',
      30,
      'Damaged transit & near-expiry replacement within 30 days',
      '0.00',
      '0.00',
      ts,
      ts
    );

    // 7. Customers
    const custWalkIn = uuid();
    const cust1 = uuid();
    const cust2 = uuid();
    tx.prepare(
      `INSERT INTO customers (id, code, name, phone, address, opening_balance, current_balance, credit_limit, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(custWalkIn, 'CUST-WALKIN', 'Walk-in Customer', '', '', '0.00', '0.00', '0.00', 'Default cash counter customer', ts, ts);
    tx.prepare(
      `INSERT INTO customers (id, code, name, phone, address, opening_balance, current_balance, credit_limit, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(cust1, 'CUST-001', 'Shafiqul Alam', '+1 (555) 302-8811', '14 Oakridge Lane', '0.00', '450.00', '5000.00', 'Regular monthly patient account', ts, ts);
    tx.prepare(
      `INSERT INTO customers (id, code, name, phone, address, opening_balance, current_balance, credit_limit, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(cust2, 'CUST-002', 'Dr. Nasrin Sultana', '+1 (555) 302-7744', 'Greenway Medical Clinic', '0.00', '0.00', '10000.00', 'Clinic account', ts, ts);

    // 8. Medicines with NON-UNIFORM manual units (100% English, MED codes, barcodes, 6-decimal quantities)
    const medDefs = [
      {
        id: uuid(),
        code: 'MED-0001',
        barcode: '8901001000011',
        brand: 'Napa Extend',
        generic: 'Paracetamol Extended Release',
        strength: '665 mg',
        form: 'Tablet',
        storage: 'Shelf A1 • Room Temp (<25°C)',
        catId: categories[0].id,
        mfgId: manufacturers[0].id,
        baseUnit: 'Tablet',
        minStock: '120.000000',
        rx: 0,
        units: [
          { name: 'Tablet', ratio: '1.000000', isBase: 1, buy: 0, sell: 1 },
          { name: 'Strip', ratio: '12.000000', isBase: 0, buy: 1, sell: 1 },
          { name: 'Box', ratio: '120.000000', isBase: 0, buy: 1, sell: 1 },
        ],
        batches: [
          { num: 'NEX-26A', exp: addDays(today, 42), cost: '1.450000', price: '2.00', qty: '144.000000' },
          { num: 'NEX-26B', exp: addDays(today, 420), cost: '1.500000', price: '2.00', qty: '360.000000' },
        ],
      },
      {
        id: uuid(),
        code: 'MED-0002',
        barcode: '8901001000028',
        brand: 'Sergel 20',
        generic: 'Esomeprazole',
        strength: '20 mg',
        form: 'Capsule',
        storage: 'Shelf B2 • Dry Place',
        catId: categories[1].id,
        mfgId: manufacturers[2].id,
        baseUnit: 'Capsule',
        minStock: '100.000000',
        rx: 0,
        units: [
          { name: 'Capsule', ratio: '1.000000', isBase: 1, buy: 0, sell: 1 },
          { name: 'Strip', ratio: '10.000000', isBase: 0, buy: 1, sell: 1 },
          { name: 'Box', ratio: '100.000000', isBase: 0, buy: 1, sell: 1 },
        ],
        batches: [
          { num: 'SRG-901', exp: addDays(today, 310), cost: '5.100000', price: '7.00', qty: '250.000000' },
        ],
      },
      {
        id: uuid(),
        code: 'MED-0003',
        barcode: '8901001000035',
        brand: 'Zimax 500',
        generic: 'Azithromycin',
        strength: '500 mg',
        form: 'Tablet',
        storage: 'Rx Cabinet C1 • Room Temp',
        catId: categories[2].id,
        mfgId: manufacturers[1].id,
        baseUnit: 'Tablet',
        minStock: '36.000000',
        rx: 1,
        units: [
          { name: 'Tablet', ratio: '1.000000', isBase: 1, buy: 0, sell: 1 },
          { name: 'Strip', ratio: '6.000000', isBase: 0, buy: 1, sell: 1 },
          { name: 'Box', ratio: '30.000000', isBase: 0, buy: 1, sell: 1 },
        ],
        batches: [
          { num: 'ZMX-441', exp: addDays(today, 275), cost: '26.500000', price: '35.00', qty: '90.000000' },
        ],
      },
      {
        id: uuid(),
        code: 'MED-0004',
        barcode: '8901001000042',
        brand: 'Monas 10',
        generic: 'Montelukast Sodium',
        strength: '10 mg',
        form: 'Tablet',
        storage: 'Rx Cabinet C2 • Protect from Light',
        catId: categories[3].id,
        mfgId: manufacturers[4].id,
        baseUnit: 'Tablet',
        minStock: '60.000000',
        rx: 1,
        units: [
          { name: 'Tablet', ratio: '1.000000', isBase: 1, buy: 0, sell: 1 },
          { name: 'Strip', ratio: '15.000000', isBase: 0, buy: 1, sell: 1 },
          { name: 'Box', ratio: '45.000000', isBase: 0, buy: 1, sell: 1 },
        ],
        batches: [
          { num: 'MNS-118', exp: addDays(today, 365), cost: '12.000000', price: '16.00', qty: '135.000000' },
        ],
      },
      {
        id: uuid(),
        code: 'MED-0005',
        barcode: '8901001000059',
        brand: 'Seclo 20',
        generic: 'Omeprazole',
        strength: '20 mg',
        form: 'Capsule',
        storage: 'Shelf B1 • Dry Place',
        catId: categories[1].id,
        mfgId: manufacturers[1].id,
        baseUnit: 'Capsule',
        minStock: '140.000000',
        rx: 0,
        units: [
          { name: 'Capsule', ratio: '1.000000', isBase: 1, buy: 0, sell: 1 },
          { name: 'Strip', ratio: '14.000000', isBase: 0, buy: 1, sell: 1 },
          { name: 'Box', ratio: '140.000000', isBase: 0, buy: 1, sell: 1 },
        ],
        batches: [
          { num: 'SCL-09X', exp: addDays(today, -15), cost: '3.600000', price: '5.00', qty: '28.000000' },
          { num: 'SCL-204', exp: addDays(today, 290), cost: '3.800000', price: '5.00', qty: '280.000000' },
        ],
      },
      {
        id: uuid(),
        code: 'MED-0006',
        barcode: '8901001000066',
        brand: 'Napa Syrup 60ml',
        generic: 'Paracetamol Suspension',
        strength: '120 mg/5ml',
        form: 'Bottle',
        storage: 'Liquid Rack L1 • Room Temp',
        catId: categories[0].id,
        mfgId: manufacturers[0].id,
        baseUnit: 'Bottle',
        minStock: '15.000000',
        rx: 0,
        units: [
          { name: 'Bottle', ratio: '1.000000', isBase: 1, buy: 1, sell: 1 },
          { name: 'Carton', ratio: '12.000000', isBase: 0, buy: 1, sell: 0 },
        ],
        batches: [
          { num: 'NSY-772', exp: addDays(today, 210), cost: '27.000000', price: '35.00', qty: '36.000000' },
        ],
      },
      {
        id: uuid(),
        code: 'MED-0007',
        barcode: '8901001000073',
        brand: 'Comet 500',
        generic: 'Metformin HCl',
        strength: '500 mg',
        form: 'Tablet',
        storage: 'Rx Cabinet D3 • Dry Place',
        catId: categories[4].id,
        mfgId: manufacturers[1].id,
        baseUnit: 'Tablet',
        minStock: '200.000000',
        rx: 1,
        units: [
          { name: 'Tablet', ratio: '1.000000', isBase: 1, buy: 0, sell: 1 },
          { name: 'Strip', ratio: '10.000000', isBase: 0, buy: 1, sell: 1 },
          { name: 'Box', ratio: '100.000000', isBase: 0, buy: 1, sell: 1 },
        ],
        batches: [
          { num: 'CMT-305', exp: addDays(today, 450), cost: '3.000000', price: '4.00', qty: '80.000000' },
        ],
      },
    ];

    const insertMed = tx.prepare(
      `INSERT INTO medicines (id, medicine_code, barcode, brand_name, generic_name, bangla_name, alternative_names, strength, dosage_form, category_id, manufacturer_id, storage_info, base_unit_name, min_stock_level, rx_required, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '', '', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    );
    const insertUnit = tx.prepare(
      `INSERT INTO medicine_units (id, medicine_id, unit_name, conversion_to_base, is_base, allow_purchase, allow_sale, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    );
    const insertBatch = tx.prepare(
      `INSERT INTO batches (id, medicine_id, batch_number, expiry_date, supplier_id, received_date, purchase_cost_per_base, selling_price_per_base, initial_qty_base, current_qty_base, base_unit_name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertMove = tx.prepare(
      `INSERT INTO stock_movements (id, medicine_id, batch_id, qty_change_base, movement_type, reference_type, reference_id, cost_per_base_snapshot, reason, created_by, created_at)
       VALUES (?, ?, ?, ?, 'OPENING_STOCK', 'OPENING', ?, ?, 'Initial pharmacy opening stock', ?, ?)`
    );

    const medIds: Record<string, { id: string; stripUnitId: string; firstBatchId: string }> = {};

    for (const m of medDefs) {
      insertMed.run(
        m.id,
        m.code,
        m.barcode,
        m.brand,
        m.generic,
        m.strength,
        m.form,
        m.catId,
        m.mfgId,
        m.storage,
        m.baseUnit,
        m.minStock,
        m.rx,
        ts,
        ts
      );
      let stripUnitId = '';
      for (const u of m.units) {
        const uid = uuid();
        if (u.name === 'Strip') stripUnitId = uid;
        insertUnit.run(uid, m.id, u.name, u.ratio, u.isBase, u.buy, u.sell, ts, ts);
      }
      let firstBatchId = '';
      for (const b of m.batches) {
        const bid = uuid();
        if (!firstBatchId) firstBatchId = bid;
        const status = b.exp <= today ? 'EXPIRED' : 'ACTIVE';
        insertBatch.run(bid, m.id, b.num, b.exp, sup1, today, b.cost, b.price, b.qty, b.qty, m.baseUnit, status, ts, ts);
        insertMove.run(uuid(), m.id, bid, b.qty, bid, b.cost, adminId, ts);
      }
      medIds[m.brand] = { id: m.id, stripUnitId, firstBatchId };
    }

    // 9. Expense Categories
    const expCat1 = uuid();
    const expCat2 = uuid();
    tx.prepare('INSERT INTO expense_categories (id, name) VALUES (?, ?)').run(expCat1, 'Utilities & Electricity');
    tx.prepare('INSERT INTO expense_categories (id, name) VALUES (?, ?)').run(expCat2, 'Staff Tea & Supplies');

    // 10. Open Cash Session
    const sessionId = uuid();
    tx.prepare(
      `INSERT INTO cash_sessions (id, session_number, status, opened_by, opened_at, opening_cash, notes)
       VALUES (?, ?, 'OPEN', ?, ?, ?, ?)`
    ).run(sessionId, `CSH-${datePart}-0001`, adminId, ts, '5000.00', 'Morning counter float');

    tx.prepare(
      `INSERT INTO cash_movements (id, cash_session_id, movement_type, amount_signed, reference_type, reference_id, notes, created_by, created_at)
       VALUES (?, ?, 'OPENING_CASH', ?, 'CASH_SESSION', ?, 'Opening counter cash', ?, ?)`
    ).run(uuid(), sessionId, '5000.00', sessionId, adminId, ts);

    // 11. Seed one completed Sale
    const saleId = uuid();
    const saleLineId = uuid();
    tx.prepare(
      `INSERT INTO sales (id, invoice_number, customer_id, sale_date, status, gross_subtotal, line_discount_total, invoice_discount, net_total, paid_amount, due_amount, total_cogs, notes, created_by, created_at)
       VALUES (?, ?, ?, ?, 'COMPLETED', ?, '0.00', '0.00', ?, ?, ?, ?, 'Initial seeded customer credit invoice', ?, ?)`
    ).run(saleId, `INV-${datePart}-0001`, cust1, today, '1050.00', '1050.00', '600.00', '450.00', '795.00', adminId, ts);

    tx.prepare(
      `INSERT INTO sale_lines (id, sale_id, medicine_id, unit_id, unit_name_snapshot, conversion_ratio_snapshot, qty_input, qty_base, unit_price, gross_total, line_discount, line_total, cogs_total)
       VALUES (?, ?, ?, ?, 'Strip', '6.000000', '5.000000', '30.000000', '210.00', '1050.00', '0.00', '1050.00', '795.00')`
    ).run(saleLineId, saleId, medIds['Zimax 500'].id, medIds['Zimax 500'].stripUnitId);

    tx.prepare(
      `INSERT INTO sale_batch_allocations (id, sale_line_id, batch_id, qty_base, cost_per_base_snapshot, cogs_total, is_manual_override, override_reason)
       VALUES (?, ?, ?, '30.000000', '26.500000', '795.00', 0, '')`
    ).run(uuid(), saleLineId, medIds['Zimax 500'].firstBatchId);

    tx.prepare(`UPDATE batches SET current_qty_base = '60.000000' WHERE id = ?`).run(medIds['Zimax 500'].firstBatchId);
    tx.prepare(
      `INSERT INTO stock_movements (id, medicine_id, batch_id, qty_change_base, movement_type, reference_type, reference_id, reference_line_id, cost_per_base_snapshot, reason, created_by, created_at)
       VALUES (?, ?, ?, '-30.000000', 'SALE', 'SALE', ?, ?, '26.500000', 'Seeded POS Sale', ?, ?)`
    ).run(uuid(), medIds['Zimax 500'].id, medIds['Zimax 500'].firstBatchId, saleId, saleLineId, adminId, ts);

    const payId = uuid();
    tx.prepare(
      `INSERT INTO payments (id, payment_number, party_type, party_id, direction, method, amount, reference_no, notes, status, created_by, created_at)
       VALUES (?, ?, 'CUSTOMER', ?, 'IN', 'CASH', '600.00', '', 'Partial cash payment on sale', 'POSTED', ?, ?)`
    ).run(payId, `PAY-${datePart}-0001`, cust1, adminId, ts);
    tx.prepare(
      `INSERT INTO payment_allocations (id, payment_id, target_type, target_id, amount_allocated)
       VALUES (?, ?, 'SALE', ?, '600.00')`
    ).run(uuid(), payId, saleId);
    tx.prepare(
      `INSERT INTO cash_movements (id, cash_session_id, movement_type, amount_signed, reference_type, reference_id, notes, created_by, created_at)
       VALUES (?, ?, 'CASH_SALE', '600.00', 'SALE', ?, 'Cash received on seeded invoice', ?, ?)`
    ).run(uuid(), sessionId, saleId, adminId, ts);

    // Seed atomic doc_sequences counters
    tx.prepare('INSERT OR REPLACE INTO doc_sequences (seq_key, current_val) VALUES (?, 1)').run(`CSH-${datePart}`);
    tx.prepare('INSERT OR REPLACE INTO doc_sequences (seq_key, current_val) VALUES (?, 1)').run(`INV-${datePart}`);
    tx.prepare('INSERT OR REPLACE INTO doc_sequences (seq_key, current_val) VALUES (?, 1)').run(`PAY-${datePart}`);

    recordAudit(tx, {
      userId: adminId,
      username: 'admin',
      action: 'SYSTEM_SEED',
      module: 'core',
      targetType: 'DATABASE',
      targetId: 'INITIAL',
      afterState: { seeded: true, medicines: medDefs.length },
      reason: 'Initial pharmacy setup & seed',
    });
  });

  ensureSeedLicense();
}

function ensureSeedLicense(): void {
  const pubPath = path.join(DATA_DIR, 'license_public.pem');
  if (fs.existsSync(LICENSE_PATH) && fs.existsSync(pubPath)) return;

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  fs.writeFileSync(pubPath, publicKey, 'utf8');

  const today = todayDate();
  const nextYear = addDays(today, 365);
  const payload: LicensePayload = {
    licenseId: 'LIC-MN-2026-0001',
    customerId: 'PHARM-MN-0001',
    pharmacyName: 'MediNest',
    licenseType: 'TIME_LIMITED',
    issueDate: today,
    expiryDate: nextYear,
    deviceFingerprint: '*',
  };
  const signature = crypto.sign(null, Buffer.from(canonicalLicensePayload(payload), 'utf8'), privateKey);
  fs.writeFileSync(
    LICENSE_PATH,
    JSON.stringify({ payload, signatureBase64: signature.toString('base64') }, null, 2),
    'utf8'
  );
}
