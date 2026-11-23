export interface AuthUser {
  id: string;
  username: string;
  fullName: string;
  phone: string;
  email: string;
  roleId: string;
  roleName: string;
  isSuperAdmin: boolean;
  isActive: boolean;
  mustChangePassword?: boolean;
  lastLoginAt?: string | null;
  permissions: Record<string, boolean>;
}

export interface PharmacySettings {
  id: number;
  pharmacy_name: string;
  drug_license_no: string;
  address: string;
  phone: string;
  email: string;
  website: string;
  currency: string;
  currency_symbol: string;
  timezone: string;
  default_low_stock_threshold: string;
  session_timeout_minutes: number;
  logo_data_url: string;
  receipt_footer: string;
  expiry_warning_days: number;
  backup_retention_count: number;
  printer_type: 'A5' | 'THERMAL_80MM' | 'A4';
  setup_completed: number;
}

export interface LicenseStatus {
  status: 'ACTIVE' | 'EXPIRED_READONLY' | 'INVALID_READONLY' | 'UNLICENSED_READONLY';
  writable: boolean;
  message: string;
  deviceFingerprint: string;
  payload: {
    licenseId: string;
    customerId: string;
    pharmacyName: string;
    licenseType: 'TRIAL' | 'TIME_LIMITED' | 'LIFETIME';
    issueDate: string;
    expiryDate: string | null;
    deviceFingerprint: string;
  } | null;
}

export interface MedicineUnit {
  id: string;
  medicine_id: string;
  unit_name: string;
  conversion_to_base: string;
  is_base: number;
  allow_purchase: number;
  allow_sale: number;
  is_active: number;
}

export interface Batch {
  id: string;
  medicine_id: string;
  batch_number: string;
  expiry_date: string;
  supplier_id: string | null;
  supplier_name?: string;
  purchase_id: string | null;
  received_date: string;
  purchase_cost_per_base: string;
  selling_price_per_base: string;
  initial_qty_base: string;
  current_qty_base: string;
  base_unit_name: string;
  status: 'ACTIVE' | 'QUARANTINED' | 'EXPIRED' | 'WRITTEN_OFF' | 'INACTIVE' | 'DEPLETED' | 'DAMAGED';
  brand_name?: string;
  generic_name?: string;
  strength?: string;
  medicine_code?: string;
  barcode?: string;
  storage_info?: string;
}

export interface Medicine {
  id: string;
  medicine_code: string;
  barcode: string;
  brand_name: string;
  generic_name: string;
  alternative_names: string;
  strength: string;
  dosage_form: string;
  category_id: string | null;
  category_name: string | null;
  manufacturer_id: string | null;
  manufacturer_name: string | null;
  storage_info: string;
  description: string;
  base_unit_name: string;
  min_stock_level: string;
  rx_required: number;
  is_active: number;
  notes: string;
  sellable_stock_base: number;
  total_physical_base: number;
  units: MedicineUnit[];
  batches: Batch[];
}

export interface SaleLineDetail {
  id: string;
  medicine_id: string;
  medicine_code?: string;
  barcode?: string;
  brand_name: string;
  generic_name: string;
  strength: string;
  base_unit_name: string;
  unit_name_snapshot: string;
  conversion_ratio_snapshot: string;
  qty_input: string;
  qty_base: string;
  unit_price: string;
  gross_total: string;
  line_discount: string;
  line_total: string;
  cogs_total: string;
  returned_qty_base: number;
  allocations: Array<{
    id: string;
    batch_id: string;
    batch_number: string;
    expiry_date: string;
    qty_base: string;
    cost_per_base_snapshot: string;
    cogs_total: string;
    is_manual_override: number;
    override_reason: string;
  }>;
}

export interface SaleRecord {
  id: string;
  invoice_number: string;
  customer_id: string | null;
  customer_name: string;
  customer_phone: string | null;
  sale_date: string;
  status: 'COMPLETED' | 'REVERSED' | 'DRAFT' | 'CANCELLED';
  gross_subtotal: string;
  line_discount_total: string;
  invoice_discount: string;
  net_total: string;
  paid_amount: string;
  due_amount: string;
  total_cogs: string;
  notes: string;
  cashier_name: string;
  created_at: string;
  reversal_reason: string;
  lines: SaleLineDetail[];
  payments: Array<{
    payment_number: string;
    method: string;
    amount: string;
    reference_no: string;
    status: string;
  }>;
}
