import { nowIso, todayDate, uuid, withTransaction } from './db.ts';
import { hashPassword } from './auth.ts';
import { recordAudit } from './audit.ts';

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
  { code: 'admin.audit', module: 'Administration', label: 'View & Verify Audit Log' },
];

function addDays(baseIsoDate: string, days: number): string {
  const dt = new Date(`${baseIsoDate}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export async function seedDatabaseIfEmpty(): Promise<void> {
  await withTransaction(async (tx) => {
    await tx.execute('SELECT pg_advisory_xact_lock(90421002)');
    const existingUser = await tx.queryOne<{ cnt: number }>('SELECT COUNT(*)::int AS cnt FROM users');
    if (Number(existingUser?.cnt ?? 0) > 0) {
      return;
    }

    const ts = nowIso();
    const today = todayDate();
    const datePart = today.replace(/-/g, '');

    // 1. Pharmacy settings
    await tx.execute(
      `INSERT INTO pharmacy_settings (id, pharmacy_name, pharmacy_name_bn, printer_type, updated_at)
       VALUES (1, 'MediNest', '', 'A5', $1)
       ON CONFLICT (id) DO NOTHING`,
      [ts]
    );

    // 2. Permissions
    for (const p of PERMISSIONS) {
      await tx.execute(
        `INSERT INTO permissions (code, module, label, description)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (code) DO NOTHING`,
        [p.code, p.module, p.label, p.label]
      );
    }

    // 3. Roles
    const adminRoleId = uuid();
    const managerRoleId = uuid();
    const cashierRoleId = uuid();

    await tx.execute('INSERT INTO roles (id, name, description, is_system, created_at) VALUES ($1, $2, $3, $4, $5)', [
      adminRoleId,
      'Super Admin',
      'Full pharmacy administrative and operational control',
      true,
      ts,
    ]);
    await tx.execute('INSERT INTO roles (id, name, description, is_system, created_at) VALUES ($1, $2, $3, $4, $5)', [
      managerRoleId,
      'Pharmacy Manager',
      'Inventory, purchasing, returns, cash sessions, and operational reports',
      true,
      ts,
    ]);
    await tx.execute('INSERT INTO roles (id, name, description, is_system, created_at) VALUES ($1, $2, $3, $4, $5)', [
      cashierRoleId,
      'POS Cashier',
      'Front-counter POS sales, customer lookup, and receipt printing',
      true,
      ts,
    ]);

    for (const p of PERMISSIONS) {
      await tx.execute(
        'INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [adminRoleId, p.code]
      );
    }

    const managerPerms = PERMISSIONS.map((p) => p.code).filter(
      (c) => !['admin.users', 'admin.permissions', 'admin.backup'].includes(c)
    );
    for (const c of managerPerms) {
      await tx.execute(
        'INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [managerRoleId, c]
      );
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
      await tx.execute(
        'INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [cashierRoleId, c]
      );
    }

    // 4. Users
    const adminId = uuid();
    const managerId = uuid();
    const cashierId = uuid();

    await tx.execute(
      `INSERT INTO users (id, username, full_name, phone, email, password_hash, role_id, is_super_admin, is_active, must_change_password, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, $10, $11)`,
      [adminId, 'admin', 'Tariqul Islam', '+1 (555) 010-0111', 'admin@medinest.local', hashPassword('Admin@123'), adminRoleId, true, true, ts, ts]
    );

    await tx.execute(
      `INSERT INTO users (id, username, full_name, phone, email, password_hash, role_id, is_super_admin, is_active, must_change_password, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, $10, $11)`,
      [managerId, 'manager', 'Farhana Yasmin', '+1 (555) 010-0222', 'manager@medinest.local', hashPassword('Manager@123'), managerRoleId, false, true, ts, ts]
    );

    await tx.execute(
      `INSERT INTO users (id, username, full_name, phone, email, password_hash, role_id, is_super_admin, is_active, must_change_password, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, $10, $11)`,
      [cashierId, 'cashier', 'Rakibul Hasan', '+1 (555) 010-0333', 'cashier@medinest.local', hashPassword('Cashier@123'), cashierRoleId, false, true, ts, ts]
    );

    await tx.execute(
      `INSERT INTO user_permission_overrides (user_id, permission_code, effect, reason, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [cashierId, 'sales.return', 'ALLOW', 'Senior counter cashier authorized for returns', adminId, ts]
    );

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
      await tx.execute('INSERT INTO categories (id, name, description) VALUES ($1, $2, $3)', [c.id, c.name, c.description]);
    }

    const manufacturers = [
      { id: uuid(), name: 'Beximco Pharmaceuticals Ltd.', country: 'Bangladesh', phone: '+880-2-58611001' },
      { id: uuid(), name: 'Square Pharmaceuticals PLC', country: 'Bangladesh', phone: '+880-2-8833047' },
      { id: uuid(), name: 'Healthcare Pharmaceuticals Ltd.', country: 'Bangladesh', phone: '+880-2-9886394' },
      { id: uuid(), name: 'Incepta Pharmaceuticals Ltd.', country: 'Bangladesh', phone: '+880-2-8891688' },
      { id: uuid(), name: 'ACME Laboratories Ltd.', country: 'Bangladesh', phone: '+880-2-9004194' },
    ];
    for (const m of manufacturers) {
      await tx.execute('INSERT INTO manufacturers (id, name, country, phone) VALUES ($1, $2, $3, $4)', [
        m.id,
        m.name,
        m.country,
        m.phone,
      ]);
    }

    // 6. Suppliers
    const sup1 = uuid();
    const sup2 = uuid();
    await tx.execute(
      `INSERT INTO suppliers (id, code, name, contact_person, phone, address, return_policy_days, return_policy_notes, opening_balance, current_balance, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
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
        ts,
      ]
    );
    await tx.execute(
      `INSERT INTO suppliers (id, code, name, contact_person, phone, address, return_policy_days, return_policy_notes, opening_balance, current_balance, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
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
        ts,
      ]
    );

    // 7. Customers
    const custWalkIn = uuid();
    const cust1 = uuid();
    const cust2 = uuid();
    await tx.execute(
      `INSERT INTO customers (id, code, name, phone, address, opening_balance, current_balance, credit_limit, notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [custWalkIn, 'CUST-WALKIN', 'Walk-in Customer', '', '', '0.00', '0.00', '0.00', 'Default cash counter customer', ts, ts]
    );
    await tx.execute(
      `INSERT INTO customers (id, code, name, phone, address, opening_balance, current_balance, credit_limit, notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [cust1, 'CUST-001', 'Shafiqul Alam', '+1 (555) 302-8811', '14 Oakridge Lane', '0.00', '450.00', '5000.00', 'Regular monthly patient account', ts, ts]
    );
    await tx.execute(
      `INSERT INTO customers (id, code, name, phone, address, opening_balance, current_balance, credit_limit, notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [cust2, 'CUST-002', 'Dr. Nasrin Sultana', '+1 (555) 302-7744', 'Greenway Medical Clinic', '0.00', '0.00', '10000.00', 'Clinic account', ts, ts]
    );

    // 8. Medicines with NON-UNIFORM manual units
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
        rx: false,
        units: [
          { name: 'Tablet', ratio: '1.000000', isBase: true, buy: false, sell: true },
          { name: 'Strip', ratio: '12.000000', isBase: false, buy: true, sell: true },
          { name: 'Box', ratio: '120.000000', isBase: false, buy: true, sell: true },
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
        rx: false,
        units: [
          { name: 'Capsule', ratio: '1.000000', isBase: true, buy: false, sell: true },
          { name: 'Strip', ratio: '10.000000', isBase: false, buy: true, sell: true },
          { name: 'Box', ratio: '100.000000', isBase: false, buy: true, sell: true },
        ],
        batches: [{ num: 'SRG-901', exp: addDays(today, 310), cost: '5.100000', price: '7.00', qty: '250.000000' }],
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
        rx: true,
        units: [
          { name: 'Tablet', ratio: '1.000000', isBase: true, buy: false, sell: true },
          { name: 'Strip', ratio: '6.000000', isBase: false, buy: true, sell: true },
          { name: 'Box', ratio: '30.000000', isBase: false, buy: true, sell: true },
        ],
        batches: [{ num: 'ZMX-441', exp: addDays(today, 275), cost: '26.500000', price: '35.00', qty: '90.000000' }],
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
        rx: true,
        units: [
          { name: 'Tablet', ratio: '1.000000', isBase: true, buy: false, sell: true },
          { name: 'Strip', ratio: '15.000000', isBase: false, buy: true, sell: true },
          { name: 'Box', ratio: '45.000000', isBase: false, buy: true, sell: true },
        ],
        batches: [{ num: 'MNS-118', exp: addDays(today, 365), cost: '12.000000', price: '16.00', qty: '135.000000' }],
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
        rx: false,
        units: [
          { name: 'Capsule', ratio: '1.000000', isBase: true, buy: false, sell: true },
          { name: 'Strip', ratio: '14.000000', isBase: false, buy: true, sell: true },
          { name: 'Box', ratio: '140.000000', isBase: false, buy: true, sell: true },
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
        rx: false,
        units: [
          { name: 'Bottle', ratio: '1.000000', isBase: true, buy: true, sell: true },
          { name: 'Carton', ratio: '12.000000', isBase: false, buy: true, sell: false },
        ],
        batches: [{ num: 'NSY-772', exp: addDays(today, 210), cost: '27.000000', price: '35.00', qty: '36.000000' }],
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
        rx: true,
        units: [
          { name: 'Tablet', ratio: '1.000000', isBase: true, buy: false, sell: true },
          { name: 'Strip', ratio: '10.000000', isBase: false, buy: true, sell: true },
          { name: 'Box', ratio: '100.000000', isBase: false, buy: true, sell: true },
        ],
        batches: [{ num: 'CMT-305', exp: addDays(today, 450), cost: '3.000000', price: '4.00', qty: '80.000000' }],
      },
    ];

    const medIds: Record<string, { id: string; stripUnitId: string; firstBatchId: string }> = {};

    for (const m of medDefs) {
      await tx.execute(
        `INSERT INTO medicines (id, medicine_code, barcode, brand_name, generic_name, bangla_name, alternative_names, strength, dosage_form, category_id, manufacturer_id, storage_info, base_unit_name, min_stock_level, rx_required, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, '', '', $6, $7, $8, $9, $10, $11, $12, $13, TRUE, $14, $15)`,
        [
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
          ts,
        ]
      );
      let stripUnitId = '';
      for (const u of m.units) {
        const uid = uuid();
        if (u.name === 'Strip') stripUnitId = uid;
        await tx.execute(
          `INSERT INTO medicine_units (id, medicine_id, unit_name, conversion_to_base, is_base, allow_purchase, allow_sale, is_active, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8, $9)`,
          [uid, m.id, u.name, u.ratio, u.isBase, u.buy, u.sell, ts, ts]
        );
      }
      let firstBatchId = '';
      for (const b of m.batches) {
        const bid = uuid();
        if (!firstBatchId) firstBatchId = bid;
        const status = b.exp <= today ? 'EXPIRED' : 'ACTIVE';
        await tx.execute(
          `INSERT INTO batches (id, medicine_id, batch_number, expiry_date, supplier_id, received_date, purchase_cost_per_base, selling_price_per_base, initial_qty_base, current_qty_base, base_unit_name, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [bid, m.id, b.num, b.exp, sup1, today, b.cost, b.price, b.qty, b.qty, m.baseUnit, status, ts, ts]
        );
        await tx.execute(
          `INSERT INTO stock_movements (id, medicine_id, batch_id, qty_change_base, movement_type, reference_type, reference_id, cost_per_base_snapshot, reason, created_by, created_at)
           VALUES ($1, $2, $3, $4, 'OPENING_STOCK', 'OPENING', $5, $6, 'Initial pharmacy opening stock', $7, $8)`,
          [uuid(), m.id, bid, b.qty, bid, b.cost, adminId, ts]
        );
      }
      medIds[m.brand] = { id: m.id, stripUnitId, firstBatchId };
    }

    // 9. Expense Categories
    const expCat1 = uuid();
    const expCat2 = uuid();
    await tx.execute('INSERT INTO expense_categories (id, name) VALUES ($1, $2)', [expCat1, 'Utilities & Electricity']);
    await tx.execute('INSERT INTO expense_categories (id, name) VALUES ($1, $2)', [expCat2, 'Staff Tea & Supplies']);

    // 10. Open Cash Session
    const sessionId = uuid();
    await tx.execute(
      `INSERT INTO cash_sessions (id, session_number, counter_code, status, opened_by, opened_at, opening_cash, notes)
       VALUES ($1, $2, 'COUNTER-1', 'OPEN', $3, $4, $5, $6)`,
      [sessionId, `CSH-${datePart}-0001`, adminId, ts, '5000.00', 'Morning counter float']
    );

    await tx.execute(
      `INSERT INTO cash_movements (id, cash_session_id, movement_type, amount_signed, reference_type, reference_id, notes, created_by, created_at)
       VALUES ($1, $2, 'OPENING_CASH', $3, 'CASH_SESSION', $4, 'Opening counter cash', $5, $6)`,
      [uuid(), sessionId, '5000.00', sessionId, adminId, ts]
    );

    // 11. Seed one completed Sale
    const saleId = uuid();
    const saleLineId = uuid();
    await tx.execute(
      `INSERT INTO sales (id, invoice_number, customer_id, sale_date, status, gross_subtotal, line_discount_total, invoice_discount, net_total, paid_amount, due_amount, total_cogs, notes, created_by, created_at)
       VALUES ($1, $2, $3, $4, 'COMPLETED', $5, '0.00', '0.00', $6, $7, $8, $9, 'Initial seeded customer credit invoice', $10, $11)`,
      [saleId, `INV-${datePart}-0001`, cust1, today, '1050.00', '1050.00', '600.00', '450.00', '795.00', adminId, ts]
    );

    await tx.execute(
      `INSERT INTO sale_lines (id, sale_id, medicine_id, unit_id, unit_name_snapshot, conversion_ratio_snapshot, qty_input, qty_base, unit_price, gross_total, line_discount, line_total, effective_line_total, cogs_total)
       VALUES ($1, $2, $3, $4, 'Strip', '6.000000', '5.000000', '30.000000', '210.00', '1050.00', '0.00', '1050.00', '1050.00', '795.00')`,
      [saleLineId, saleId, medIds['Zimax 500'].id, medIds['Zimax 500'].stripUnitId]
    );

    await tx.execute(
      `INSERT INTO sale_batch_allocations (id, sale_line_id, batch_id, qty_base, cost_per_base_snapshot, cogs_total, is_manual_override, override_reason)
       VALUES ($1, $2, $3, '30.000000', '26.500000', '795.00', FALSE, '')`,
      [uuid(), saleLineId, medIds['Zimax 500'].firstBatchId]
    );

    await tx.execute(`UPDATE batches SET current_qty_base = '60.000000' WHERE id = $1`, [
      medIds['Zimax 500'].firstBatchId,
    ]);
    await tx.execute(
      `INSERT INTO stock_movements (id, medicine_id, batch_id, qty_change_base, movement_type, reference_type, reference_id, reference_line_id, cost_per_base_snapshot, reason, created_by, created_at)
       VALUES ($1, $2, $3, '-30.000000', 'SALE', 'SALE', $4, $5, '26.500000', 'Seeded POS Sale', $6, $7)`,
      [uuid(), medIds['Zimax 500'].id, medIds['Zimax 500'].firstBatchId, saleId, saleLineId, adminId, ts]
    );

    const payId = uuid();
    await tx.execute(
      `INSERT INTO payments (id, payment_number, party_type, party_id, direction, method, amount, reference_no, notes, status, created_by, created_at)
       VALUES ($1, $2, 'CUSTOMER', $3, 'IN', 'CASH', '600.00', '', 'Partial cash payment on sale', 'POSTED', $4, $5)`,
      [payId, `PAY-${datePart}-0001`, cust1, adminId, ts]
    );
    await tx.execute(
      `INSERT INTO payment_allocations (id, payment_id, target_type, target_id, amount_allocated)
       VALUES ($1, $2, 'SALE', $3, '600.00')`,
      [uuid(), payId, saleId]
    );
    await tx.execute(
      `INSERT INTO cash_movements (id, cash_session_id, movement_type, amount_signed, reference_type, reference_id, notes, created_by, created_at)
       VALUES ($1, $2, 'CASH_SALE', '600.00', 'SALE', $3, 'Cash received on seeded invoice', $4, $5)`,
      [uuid(), sessionId, saleId, adminId, ts]
    );

    for (const seqKey of [`CSH-${datePart}`, `INV-${datePart}`, `PAY-${datePart}`]) {
      await tx.execute(
        `INSERT INTO doc_sequences (seq_key, current_val) VALUES ($1, 1)
         ON CONFLICT (seq_key) DO UPDATE SET current_val = GREATEST(doc_sequences.current_val, 1)`,
        [seqKey]
      );
    }

    await recordAudit(tx, {
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
}
