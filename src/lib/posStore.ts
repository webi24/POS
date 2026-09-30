export type BusinessType = 'shop' | 'supermarket' | 'pharmacy' | 'liquor' | 'hardware' | 'salon'
export type UnitOfMeasure = 'piece' | 'kg' | 'litre' | 'pack'
export type StockAdjustmentReason = 'damage' | 'theft' | 'expired' | 'delivery' | 'count-correction'

export type PaymentMap = {
  cash: number
  mpesa: number
  credit: number
}

export type Product = {
  id: string
  businessId: string
  name: string
  category: string
  price: number
  costPrice: number
  stockQuantity: number
  unitOfMeasure: UnitOfMeasure   /** EAN/UPC/etc. Optional; loose produce and services have none. */
  barcode?: string
  expiryDate?: string
  batchNumber?: string
  restrictedItem?: boolean
  lowStockAlert: number
  /** Per-branch on-hand stock for non-default branches; default branch uses stockQuantity. */
  stockByBranch?: Record<string, number>
}

export type Customer = {
  id: string
  businessId: string
  name: string
  phone?: string
  balance: number
}

export type Staff = {
  id: string
  businessId: string
  /** Branch this PIN can sign in at (normalized to the default branch). */
  branchId?: string
  name: string
  pin: string
  shift: string
  /** Onboarding walkthrough tracked per staff account, not per device (Section 6). */
  walkthroughCompletedAt?: string
}

export type SaleItem = {
  productId: string
  quantity: number
  unitPrice: number
}

export type Sale = {
  id: string
  businessId: string
  /** Branch the sale happened at (normalized to the default branch). */
  branchId?: string
  items: SaleItem[]
  payments: PaymentMap
  customerId?: string
  total: number
  createdAt: string
  attendantId?: string
  mpesaStatus?: 'pending' | 'confirmed' | 'manual' | 'failed'
  mpesaReceipt?: string
  /** Set when the whole sale was refunded; the sale stays in the ledger. */
  refundedAt?: string
  /** eTIMS fiscalisation result (Section 4). Queued offline like everything else. */
  etims?: {
    status: 'queued' | 'signed' | 'failed'
    invcNo?: number
    /** KRA control number built from the fiscal stamp (curRcptNo/totRcptNo). */
    controlNumber?: string
    rcptSign?: string
    signedAt?: string
    error?: string
  }
}

/**
 * Owner account (Section 3). Independent of any business: an owner starts
 * with zero businesses and may attach many (Section 2). Phone-ready: the
 * nullable phone number participates in identifier lookup today.
 */
export type OwnerAccount = {
  id: string
  fullName: string
  email: string
  phoneNumber?: string
  /** Demo-mode only; the backend keeps real credentials. Never synced. */
  passwordHash?: string
  emailVerified: boolean
  /** Demo-mode stand-in for the emailed verification link. */
  verificationCode?: string
  /** Onboarding walkthrough is tracked per account, not per device (Section 6). */
  walkthroughCompletedAt?: string
  createdAt: string
}

/** Audit trail entry (Section 5): who did what, when, with before/after. */
export type AuditEntry = {
  id: string
  businessId: string
  /** Branch this entry belongs to (normalized to the default branch). */
  branchId?: string
  at: string
  actorId?: string
  actorName: string
  actorRole: 'staff' | 'owner' | 'unknown'
  action: 'stock-adjusted' | 'price-changed' | 'staff-removed'
  productId?: string
  productName?: string
  before?: number
  after?: number
  detail?: string
}

export type Actor = { id?: string; name: string; role: 'staff' | 'owner' | 'unknown' }

export type StockAdjustment = {
  id: string
  /** Branch the correction applies to (normalized to the default branch). */
  branchId?: string
  businessId: string
  productId: string
  reason: StockAdjustmentReason
  quantityDelta: number
  createdAt: string
}

// --- Owner finance (dashboard): capital, expenses, refunds -----------------

export const EXPENSE_CATEGORIES = [
  'rent',
  'wages',
  'utilities',
  'transport',
  'restock',
  'other',
] as const

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number]

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  rent: 'Rent',
  wages: 'Wages',
  utilities: 'Utilities',
  transport: 'Transport',
  restock: 'Restock / supplies',
  other: 'Other',
}

/**
 * Manual business expense logged by the owner. Expenses are never derived
 * from sales data; they are the owner's own record of money leaving the
 * business for rent, wages, utilities, transport, restocking, etc.
 */
export type Expense = {
  id: string
  businessId: string
  category: ExpenseCategory
  amount: number
  note?: string
  /** Local day key (YYYY-MM-DD) the expense belongs to. */
  date: string
  createdAt: string
}

/**
 * Money the owner put INTO the business: the initial starting capital plus
 * any later injections. Total invested = starting capital + injections and
 * is the denominator for return-on-investment reporting.
 */
export type CapitalInjection = {
  id: string
  businessId: string
  amount: number
  note?: string
  /** Local day key (YYYY-MM-DD) of the injection. */
  date: string
  createdAt: string
}

/**
 * A returned sale. Refunds are tracked as their own records (not silent
 * deletions) so the owner always sees how much money went back out, and the
 * dashboard can show "Refunds this period: KES X" as a visible line.
 */
export type Refund = {
  id: string
  businessId: string
  saleId?: string
  productId?: string
  quantity: number
  amount: number
  reason?: string
  createdAt: string
}

export type Branch = {
  id: string
  businessId: string
  name: string
  /** Creation order; index 0 of business.branches is the main branch. */
  createdAt: string
}

export const DEFAULT_BRANCH_NAME = 'Main branch'

/** The branch a record belongs to when it predates branches (or omits one). */
export function defaultBranchOf(business: Business): Branch {
  return (
    business.branches[0] ?? {
      id: `${business.id}-main`,
      businessId: business.id,
      name: DEFAULT_BRANCH_NAME,
      createdAt: new Date(0).toISOString(),
    }
  )
}

/** Branch lookup that never throws: unknown/missing ids fall back to default. */
export function branchByIdOr(business: Business, branchId: string | undefined): Branch {
  if (branchId) {
    const found = business.branches.find((branch) => branch.id === branchId)
    if (found) return found
  }
  return defaultBranchOf(business)
}

/** Every branch is tagged with this id in filters; keeps code honest. */
export function normalizeBranches(business: Business): void {
  if (!Array.isArray(business.branches)) business.branches = []
}

export type Business = {
  id: string
  name: string
  type: BusinessType
  // Non-secret Till/Paybill identifier (safe on-device).
  // Daraja consumer key/secret are NEVER stored client-side (see backend.ts):
  // they are submitted once over HTTPS and live only in the backend database.
  mpesaShortCode?: string
  /** Owning account identifier (non-secret). Server-side profiles are authoritative. */
  ownerEmail?: string
  /**
   * Physical locations of this business. Opt-in: businesses that never add
   * branches have exactly one implicit default branch and behave as before.
   * Product catalog/pricing/customers are shared by all branches; stock
   * tracking, sales, staff and audit entries are branch-scoped.
   */
  branches: Branch[]
  products: Product[]
  customers: Customer[]
  staff: Staff[]
  sales: Sale[]
  stockAdjustments: StockAdjustment[]
  auditTrail: AuditEntry[]
  // --- Owner finance (dashboard) -------------------------------------------
  /** Money the owner first put into the business (ROI denominator). */
  startingCapital?: number
  /** Later capital injections on top of the starting amount. */
  capitalInjections: CapitalInjection[]
  /** Manual expense log (rent, wages, utilities, transport, restock, other). */
  expenses: Expense[]
  /** Returned sales: visible money out, subtracted from revenue. */
  refunds: Refund[]
  // --- eTIMS (Section 4): identifiers are non-secret and safe on-device.
  // The cmcKey communication key is a secret, server-side only, like Daraja.
  kraPin?: string
  etimsBhfId?: string
  etimsDeviceSerial?: string
  /** VAT rate used for eTIMS tax buckets, default 16 (standard, tax type B). */
  vatRate?: number
}

export type SyncAction =
  | 'business-created'
  | 'business-updated'
  | 'branch-added'
  | 'product-added'
  | 'product-bulk-added'
  | 'product-updated'
  | 'customer-added'
  | 'staff-added'
  | 'staff-removed'
  | 'sale-created'
  | 'stock-adjusted'
  | 'credit-repayment'
  | 'audit-appended'
  | 'etims-invoice'
  | 'expense-added'
  | 'capital-injection-added'
  | 'refund-added'
  | 'capital-set'

export type SyncStatus = 'pending' | 'in-flight' | 'synced' | 'conflict' | 'error'

export type SyncConflict = {
  field: string
  localValue: unknown
  remoteValue: unknown
}

export type SyncQueueItem = {
  id: string
  businessId: string
  action: SyncAction
  payload: unknown
  status: SyncStatus
  createdAt: string
  attempts: number
  lastError?: string
  conflict?: SyncConflict[]
}

export type AppState = {
  businesses: Business[]
  owners: OwnerAccount[]
  syncQueue: SyncQueueItem[]
}

export function createInitialState(): AppState {
  return { businesses: [], owners: [], syncQueue: [] }
}

// --- Owner accounts (Section 3) -------------------------------------------

/** Non-reversible demo-mode hash. The backend owns real credentials. */
export function hashPasscode(input: string): string {
  let hash1 = 0x811c9dc5
  let hash2 = 0x01000193
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i)
    hash1 = Math.imul(hash1 ^ code, 0x01000193) >>> 0
    hash2 = Math.imul(hash2 + code, 0x85ebca6b) >>> 0
  }
  return `${hash1.toString(16).padStart(8, '0')}${hash2.toString(16).padStart(8, '0')}`
}

export type CreateOwnerResult =
  | { ok: true; owner: OwnerAccount }
  | { ok: false; error: string }

/**
 * Creates an owner account with ZERO businesses (Section 3). Businesses are
 * linked afterwards by setting business.ownerEmail. In demo mode (no
 * backend) the password is stored as a hash and a verification code is
 * generated for the simulated email flow.
 */
export function createOwner(
  state: AppState,
  input: { fullName: string; email: string; password?: string; phoneNumber?: string },
): CreateOwnerResult {
  const email = input.email.trim().toLowerCase()
  if (!email || !email.includes('@')) {
    return { ok: false, error: 'Enter a valid email address' }
  }
  if (!input.fullName.trim()) {
    return { ok: false, error: 'Enter your full name' }
  }
  if (input.password !== undefined && input.password.length < 8) {
    return { ok: false, error: 'Password needs at least 8 characters' }
  }
  if (state.owners.some((owner) => owner.email.toLowerCase() === email)) {
    return { ok: false, error: 'An account with this email already exists. Sign in instead' }
  }

  const owner: OwnerAccount = {
    id: newId('owner'),
    fullName: input.fullName.trim(),
    email,
    phoneNumber: input.phoneNumber?.trim() || undefined,
    passwordHash: input.password !== undefined ? hashPasscode(input.password) : undefined,
    emailVerified: false,
    // Deterministic demo code shown in the UI as the "email" in demo mode.
    verificationCode: '123456',
    createdAt: nowIso(),
  }
  state.owners.push(owner)
  return { ok: true, owner }
}

/**
 * Finds an owner by email OR phone, structured phone-ready (Section 3), so
 * OTP login can be added later without a rebuild.
 */
export function findOwnerByIdentifier(state: AppState, identifier: string): OwnerAccount | null {
  const needle = identifier.trim().toLowerCase()
  if (!needle) return null
  const digits = needle.replace(/\D/g, '')
  return (
    state.owners.find(
      (owner) =>
        owner.email.toLowerCase() === needle ||
        (digits.length >= 9 && owner.phoneNumber && owner.phoneNumber.replace(/\D/g, '').endsWith(digits)),
    ) ?? null
  )
}

export function verifyOwnerCredentials(
  state: AppState,
  identifier: string,
  password: string,
): OwnerAccount | null {
  const owner = findOwnerByIdentifier(state, identifier)
  if (!owner?.passwordHash) return null
  return owner.passwordHash === hashPasscode(password) ? owner : null
}

export function markOwnerVerified(state: AppState, ownerId: string, code: string): boolean {
  const owner = state.owners.find((entry) => entry.id === ownerId)
  if (!owner) return false
  if (owner.verificationCode && owner.verificationCode !== code) return false
  owner.emailVerified = true
  owner.verificationCode = undefined
  return true
} /** All businesses linked to this owner (Section 2: one owner, many businesses). */
export function ownerBusinesses(state: AppState, owner: { email: string }): Business[] {
  const email = owner.email.toLowerCase()
  return state.businesses.filter((business) => business.ownerEmail?.toLowerCase() === email)
}

export function newId(prefix: string): string {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`
  return `${prefix}-${uuid}`
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function localDayKey(isoDate: string): string {
  const date = new Date(isoDate)
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

export function todayKey(): string {
  return localDayKey(new Date().toISOString())
}

export function defaultCategoriesFor(type: BusinessType): string[] {
  switch (type) {
    case 'pharmacy':
      return ['Medicine', 'Supplements', 'Baby Care', 'Wellness']
    case 'liquor':
      return ['Beer', 'Spirits', 'Wine', 'Soft Drinks']
    case 'hardware':
      return ['Tools', 'Building', 'Electrical', 'Plumbing']
    case 'salon':
      return ['Hair', 'Nails', 'Skin', 'Accessories']
    case 'supermarket':
      return ['Food', 'Drinks', 'Home', 'Fresh']
    default:
      return ['Food', 'Home', 'General', 'Drinks']
  }
}

export function defaultUnitFor(type: BusinessType): UnitOfMeasure {
  if (type === 'hardware' || type === 'salon') return 'piece'
  return 'piece'
}

export function getBusinessScope(state: AppState, businessId: string): Business {
  const business = state.businesses.find((item) => item.id === businessId)
  if (!business) {
    throw new Error(`Business ${businessId} not found`)
  }
  return business
}

/**
 * Which businesses may this session see in the switcher?
 * - Signed-in owner: only businesses linked to their account.
 * - Signed-in attendant: only the business their staff record belongs to.
 * - No session (first run / demo): everything on this device.
 * This is UI scoping; the database (RLS) remains the enforcement layer.
 */
export function businessesVisibleTo(
  businesses: Business[],
  session: { ownerEmail?: string; ownerBusinessId?: string; staffId?: string } | null,
): Business[] {
  if (session?.ownerEmail) {
    const ownerEmail = session.ownerEmail.toLowerCase()
    return businesses.filter(
      (entry) => entry.ownerEmail?.toLowerCase() === ownerEmail || entry.id === session.ownerBusinessId,
    )
  }
  if (session?.staffId) {
    return businesses.filter((entry) => entry.staff.some((staff) => staff.id === session.staffId))
  }
  return businesses
}

export function addBusiness(
  state: AppState,
  input: {
    id?: string
    name: string
    type: BusinessType
    mpesaShortCode?: string
  },
): Business {
  const business: Business = {
    id: input.id ?? newId('biz'),
    name: input.name,
    type: input.type,
    mpesaShortCode: input.mpesaShortCode,
    branches: [],
    products: [],
    customers: [],
    staff: [],
    sales: [],
    stockAdjustments: [],
    auditTrail: [],
    startingCapital: 0,
    capitalInjections: [],
    expenses: [],
    refunds: [],
  }

  // Every business gets one implicit main branch so single-location shops
  // behave exactly as before, and branches[] always exists for the UI.
  business.branches.push({
    id: `${business.id}-main`,
    businessId: business.id,
    name: DEFAULT_BRANCH_NAME,
    createdAt: nowIso(),
  })

  state.businesses.push(business)
  enqueueSyncAction(state, business.id, 'business-created', {
    businessId: business.id,
    name: business.name,
    type: business.type,
    mpesaShortCode: business.mpesaShortCode,
  })
  return business
}

/**
 * Adds a branch to a business. The catalog/pricing/customers stay shared;
 * only stock tracking, sales, staff and audit become branch-scoped.
 */
export function addBranch(state: AppState, business: Business, name: string): Branch {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Branch needs a name')
  if (business.branches.some((branch) => branch.name.toLowerCase() === trimmed.toLowerCase())) {
    throw new Error(`Branch "${trimmed}" already exists`)
  }
  const branch: Branch = {
    id: newId('branch'),
    businessId: business.id,
    name: trimmed,
    createdAt: nowIso(),
  }
  business.branches.push(branch)
  enqueueSyncAction(state, business.id, 'branch-added', {
    branchId: branch.id,
    name: branch.name,
  })
  return branch
}

export function addProduct(
  business: Business,
  productInput: {
    id?: string
    name: string
    category: string
    price: number
    costPrice: number
    stockQuantity: number
    unitOfMeasure: UnitOfMeasure
    barcode?: string
    expiryDate?: string
    batchNumber?: string
    restrictedItem?: boolean
    lowStockAlert: number
  },
): Product {
  const product: Product = {
    ...productInput,
    id: productInput.id ?? newId('prod'),
    businessId: business.id,
  }

  business.products.push(product)
  return product
}

export type BulkProductRow = {
  name: string
  category: string
  price: number
  costPrice: number
  stockQuantity: number
  unitOfMeasure: UnitOfMeasure
  lowStockAlert: number
}

export function parseBulkProductCsv(text: string): { rows: BulkProductRow[]; errors: string[] } {
  const rows: BulkProductRow[] = []
  const errors: string[] = []
  const units = new Set<UnitOfMeasure>(['piece', 'kg', 'litre', 'pack'])

  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .forEach((line, index) => {
      const parts = line.split(',').map((part) => part.trim())
      if (parts.length < 4) {
        errors.push(`Line ${index + 1}: needs at least name, category, price, stock`)
        return
      }

      const [name, category, price, stock, cost, unit] = parts
      const parsedPrice = Number(price)
      const parsedStock = Number(stock)
      if (!Number.isFinite(parsedPrice) || parsedPrice < 0) {
        errors.push(`Line ${index + 1}: "${price}" is not a valid price`)
        return
      }
      if (!Number.isFinite(parsedStock) || parsedStock < 0) {
        errors.push(`Line ${index + 1}: "${stock}" is not a valid stock quantity`)
        return
      }

      const parsedUnit = unit && units.has(unit.toLowerCase() as UnitOfMeasure) ? (unit.toLowerCase() as UnitOfMeasure) : 'piece'

      rows.push({
        name,
        category: category || 'General',
        price: parsedPrice,
        costPrice: Number(cost) || 0,
        stockQuantity: parsedStock,
        unitOfMeasure: parsedUnit,
        lowStockAlert: 3,
      })
    })

  return { rows, errors }
}

export function recordStaff(
  business: Business,
  input: { id?: string; name: string; pin: string; shift?: string; branchId?: string },
): Staff {
  const staff: Staff = {
    id: input.id ?? newId('staff'),
    businessId: business.id,
    branchId: input.branchId ?? currentBranchTag(),
    name: input.name,
    pin: input.pin,
    shift: input.shift ?? 'Any',
    walkthroughCompletedAt: undefined,
  }

  business.staff.push(staff)
  return staff
}

/**
 * PIN check scoped to one branch: a Mamboleo PIN cannot open the Kisumu Town
 * till. Old staff records without a branchId fall back to the default branch,
 * so pre-branch accounts keep working at the main branch.
 */
export function verifyStaffPinForBranch(
  business: Business,
  staffId: string,
  pin: string,
  branchId: string | undefined,
): Staff | null {
  const staff = verifyStaffPin(business, staffId, pin)
  if (!staff) return null
  return branchByIdOr(business, staff.branchId).id === branchByIdOr(business, branchId).id ? staff : null
}

export function verifyStaffPin(business: Business, staffId: string, pin: string): Staff | null {
  const staff = business.staff.find((entry) => entry.id === staffId)
  if (staff && staff.pin === pin) {
    return staff
  }
  return null
}

/**
 * Removes a staff member's PIN login. Past sales keep their attendantId, so
 * sales history stays intact even after the person is removed.
 */
export function removeStaff(business: Business, staffId: string): boolean {
  const index = business.staff.findIndex((entry) => entry.id === staffId)
  if (index === -1) return false
  business.staff.splice(index, 1)
  return true
}

// --- Audit trail (Section 5) -----------------------------------------------

/** Appends one audit entry, scopes it to the business, and queues it for sync. */
export function appendAuditEntry(
  state: AppState,
  business: Business,
  entry: {
    actor: Actor
    action: AuditEntry['action']
    productId?: string
    productName?: string
    before?: number
    after?: number
    detail?: string
  },
): AuditEntry {
  const audit: AuditEntry = {
    id: newId('audit'),
    businessId: business.id,
    branchId: currentBranchTag(),
    at: nowIso(),
    actorId: entry.actor.id,
    actorName: entry.actor.name || 'Unknown',
    actorRole: entry.actor.role,
    action: entry.action,
    productId: entry.productId,
    productName: entry.productName,
    before: entry.before,
    after: entry.after,
    detail: entry.detail,
  }
  business.auditTrail.push(audit)
  enqueueSyncAction(state, business.id, 'audit-appended', audit)
  return audit
} /** Chronological (newest first) audit view, owner-only in the UI. */
export function auditTrailFor(business: Business): AuditEntry[] {
  return [...business.auditTrail].sort((a, b) => b.at.localeCompare(a.at))
}

/**
 * Price change: updates the product and records before/after in the audit
 * trail with attribution. Staff or owner may do it; the log tells them apart.
 */
export function updateProductPrice(
  state: AppState,
  business: Business,
  productId: string,
  newPrice: number,
  actor: Actor,
): Product {
  const product = business.products.find((entry) => entry.id === productId)
  if (!product) {
    throw new Error(`Product ${productId} not found in ${business.name}`)
  }
  if (!Number.isFinite(newPrice) || newPrice <= 0) {
    throw new Error('Price must be a number above zero')
  }
  if (newPrice === product.price) {
    return product
  }

  const before = product.price
  product.price = newPrice
  appendAuditEntry(state, business, {
    actor,
    action: 'price-changed',
    productId: product.id,
    productName: product.name,
    before,
    after: newPrice,
  })
  enqueueSyncAction(state, business.id, 'product-updated', {
    productId: product.id,
    price: newPrice,
  })
  return product
}

/**
 * Branch-scoped view of a business: sales/stock adjustments/audit trail and
 * staff filtered to one branch. Products, customers and finance ledgers stay
 * shared (catalog, pricing and expenses are business-level by design).
 */
export function branchScope(business: Business, branchId: string | undefined): Business {
  const branch = branchByIdOr(business, branchId)
  return {
    ...business,
    staff: business.staff.filter((staff) => branchByIdOr(business, staff.branchId).id === branch.id),
    sales: business.sales.filter((sale) => branchByIdOr(business, sale.branchId).id === branch.id),
    stockAdjustments: business.stockAdjustments.filter(
      (adjustment) => branchByIdOr(business, adjustment.branchId).id === branch.id,
    ),
    auditTrail: business.auditTrail.filter((entry) => branchByIdOr(business, entry.branchId).id === branch.id),
  }
}

/** A branch-scoped writer proxy: mutations branch-tagged via a branch id bag. */
const pendingBranchTag: { current: string | undefined } = { current: undefined }

export function withBranchScope<T>(branchId: string | undefined, fn: () => T): T {
  pendingBranchTag.current = branchId
  try {
    return fn()
  } finally {
    pendingBranchTag.current = undefined
  }
}

/** Current branch tag for new records (used by completeSale etc.). */
function currentBranchTag(): string | undefined {
  return pendingBranchTag.current
}

/**
 * On-hand stock of a product at one branch. The default branch reads/writes
 * the product's legacy stockQuantity field (so existing data just works);
 * added branches get their own map entry, starting at zero until a delivery
 * or correction is recorded for that branch.
 */
export function stockForBranch(
  business: Business,
  product: Product,
  branchId: string | undefined,
): number {
  const branch = branchByIdOr(business, branchId)
  if (branch.id === defaultBranchOf(business).id) return product.stockQuantity
  return product.stockByBranch?.[branch.id] ?? 0
}

/** Branch-aware stock writer (companion to stockForBranch). */
function setStockForBranch(
  business: Business,
  product: Product,
  branchId: string | undefined,
  value: number,
): void {
  const branch = branchByIdOr(business, branchId)
  const next = Math.max(0, value)
  if (branch.id === defaultBranchOf(business).id) {
    product.stockQuantity = next
    return
  }
  if (!product.stockByBranch) product.stockByBranch = {}
  product.stockByBranch[branch.id] = next
}

export function completeSale(
  business: Business,
  input: {
    id?: string
    items: SaleItem[]
    payments: PaymentMap
    customerId?: string
    attendantId?: string
    mpesaStatus?: Sale['mpesaStatus']
  },
): Sale {
  const total = input.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0)

  for (const item of input.items) {
    const product = business.products.find((entry) => entry.id === item.productId)
    if (!product) {
      throw new Error(`Product ${item.productId} not found in ${business.name}`)
    }

    const available = stockForBranch(business, product, currentBranchTag())
    if (available < item.quantity) {
      throw new Error(`Not enough stock for ${product.name}`)
    }

    setStockForBranch(business, product, currentBranchTag(), available - item.quantity)
  }

  const sale: Sale = {
    id: input.id ?? newId('sale'),
    businessId: business.id,
    branchId: currentBranchTag(),
    items: input.items,
    payments: input.payments,
    customerId: input.customerId,
    total,
    createdAt: nowIso(),
    attendantId: input.attendantId,
    mpesaStatus: input.mpesaStatus ?? (input.payments.mpesa > 0 ? 'pending' : undefined),
  }

  business.sales.push(sale)

  // eTIMS (Section 4): if the business has KRA eTIMS details on file, queue
  // the invoice for fiscalisation. Queued offline like every other action;
  // completing the sale NEVER waits on KRA.
  if (business.kraPin && business.etimsDeviceSerial) {
    sale.etims = { status: 'queued' }
    enqueueSyncAction(stateOf(), business.id, 'etims-invoice', {
      saleId: sale.id,
      total: sale.total,
      items: sale.items,
      createdAt: sale.createdAt,
    })
  }

  if (input.customerId) {
    const customer = business.customers.find((entry) => entry.id === input.customerId)
    if (customer && input.payments.credit > 0) {
      customer.balance += input.payments.credit
    }
  }

  enqueueSyncAction(stateOf(), business.id, 'sale-created', sale)
  return sale
}

export function undoSale(business: Business, saleId: string): Sale {
  const index = business.sales.findIndex((entry) => entry.id === saleId)
  if (index === -1) {
    throw new Error(`Sale ${saleId} not found in ${business.name}`)
  }

  const sale = business.sales[index]

  for (const item of sale.items) {
    const product = business.products.find((entry) => entry.id === item.productId)
    if (product) {
      // Stock goes back on the same branch shelf it left.
      setStockForBranch(
        business,
        product,
        sale.branchId,
        stockForBranch(business, product, sale.branchId) + item.quantity,
      )
    }
  }

  if (sale.customerId && sale.payments.credit > 0) {
    const customer = business.customers.find((entry) => entry.id === sale.customerId)
    if (customer) {
      customer.balance = Math.max(0, customer.balance - sale.payments.credit)
    }
  }

  business.sales.splice(index, 1)
  return sale
}

export function applyCreditRepayment(
  business: Business,
  customerId: string,
  amount: number,
): Customer {
  const customer = business.customers.find((entry) => entry.id === customerId)
  if (!customer) {
    throw new Error(`Customer ${customerId} not found`)
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Repayment amount must be greater than zero')
  }

  customer.balance = Math.max(0, customer.balance - amount)
  enqueueSyncAction(stateOf(), business.id, 'credit-repayment', {
    customerId,
    amount,
  })
  return customer
}

export function recordStockAdjustment(
  business: Business,
  input: {
    id?: string
    productId: string
    reason: StockAdjustmentReason
    quantityDelta: number
    actor?: Actor
  },
): StockAdjustment {
  const product = business.products.find((entry) => entry.id === input.productId)
  if (!product) {
    throw new Error(`Product ${input.productId} not found`)
  }

  const adjustment: StockAdjustment = {
    id: input.id ?? newId('adj'),
    businessId: business.id,
    branchId: currentBranchTag(),
    productId: input.productId,
    reason: input.reason,
    quantityDelta: input.quantityDelta,
    createdAt: nowIso(),
  }

  business.stockAdjustments.push(adjustment)
  const before = stockForBranch(business, product, adjustment.branchId)
  setStockForBranch(business, product, adjustment.branchId, before + input.quantityDelta)

  // Audit trail (Section 5): every stock adjustment is logged with who/when.
  appendAuditEntry(stateOf(), business, {
    actor: input.actor ?? { name: 'Unknown', role: 'unknown' },
    action: 'stock-adjusted',
    productId: product.id,
    productName: product.name,
    before,
    after: stockForBranch(business, product, adjustment.branchId),
    detail: `${input.reason} (${input.quantityDelta > 0 ? '+' : ''}${input.quantityDelta})`,
  })

  enqueueSyncAction(stateOf(), business.id, 'stock-adjusted', adjustment)
  return adjustment
}

// --- Owner finance mutations (dashboard) ------------------------------------

/** Creates an empty finance sub-ledger for a new business. */
export function createFinanceLedgers(business: Business): void {
  business.startingCapital = business.startingCapital ?? 0
  business.capitalInjections = business.capitalInjections ?? []
  business.expenses = business.expenses ?? []
  business.refunds = business.refunds ?? []
}

/** Normalizes legacy business objects loaded from IndexedDB (missing arrays). */
export function normalizeFinanceLedgers(business: Business): void {
  if (!Array.isArray(business.capitalInjections)) business.capitalInjections = []
  if (!Array.isArray(business.expenses)) business.expenses = []
  if (!Array.isArray(business.refunds)) business.refunds = []
  if (typeof business.startingCapital !== 'number' || !Number.isFinite(business.startingCapital)) {
    business.startingCapital = 0
  }
}

/** Sets (or updates) the starting capital. Owner-only action in the UI. */
export function setStartingCapital(state: AppState, business: Business, amount: number): void {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error('Starting capital must be zero or more')
  }
  business.startingCapital = round2(amount)
  enqueueSyncAction(state, business.id, 'capital-set', { startingCapital: business.startingCapital })
}

/** Logs one capital injection on top of the starting amount. */
export function addCapitalInjection(
  state: AppState,
  business: Business,
  input: { amount: number; note?: string; date?: string },
): CapitalInjection {
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new Error('Capital amount must be greater than zero')
  }
  const injection: CapitalInjection = {
    id: newId('cap'),
    businessId: business.id,
    amount: round2(input.amount),
    note: input.note?.trim() || undefined,
    date: input.date ?? todayKey(),
    createdAt: nowIso(),
  }
  business.capitalInjections.push(injection)
  enqueueSyncAction(state, business.id, 'capital-injection-added', injection)
  return injection
}

/** Total money the owner has put into the business since inception. */
export function totalCapitalInvested(business: Business): number {
  return round2(
    (business.startingCapital ?? 0) +
      business.capitalInjections.reduce((sum, injection) => sum + injection.amount, 0),
  )
}

/** Logs one manual expense. Expenses are never auto-generated from sales. */
export function addExpense(
  state: AppState,
  business: Business,
  input: { category: ExpenseCategory; amount: number; note?: string; date?: string },
): Expense {
  if (!EXPENSE_CATEGORIES.includes(input.category)) {
    throw new Error('Choose an expense category')
  }
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new Error('Expense amount must be greater than zero')
  }
  const expense: Expense = {
    id: newId('exp'),
    businessId: business.id,
    category: input.category,
    amount: round2(input.amount),
    note: input.note?.trim() || undefined,
    date: input.date ?? todayKey(),
    createdAt: nowIso(),
  }
  business.expenses.push(expense)
  enqueueSyncAction(state, business.id, 'expense-added', expense)
  return expense
}

/**
 * Refunds one sale in full: restocks the items, records a visible Refund,
 * and reduces the customer's credit balance when the sale was on credit.
 * The sale itself stays in the ledger marked refundedAt so the dashboard can
 * show refunds as their own line rather than silently rewriting history.
 */
export function refundSale(state: AppState, business: Business, saleId: string, reason?: string): Refund {
  const sale = business.sales.find((entry) => entry.id === saleId)
  if (!sale) {
    throw new Error(`Sale ${saleId} not found in ${business.name}`)
  }
  if (sale.refundedAt) {
    throw new Error('This sale has already been refunded')
  }

  for (const item of sale.items) {
    const product = business.products.find((entry) => entry.id === item.productId)
    if (product) {
      // Refunds restock the same branch that sold the item.
      setStockForBranch(
        business,
        product,
        sale.branchId,
        stockForBranch(business, product, sale.branchId) + item.quantity,
      )
    }
  }

  if (sale.customerId && sale.payments.credit > 0) {
    const customer = business.customers.find((entry) => entry.id === sale.customerId)
    if (customer) {
      customer.balance = Math.max(0, customer.balance - sale.payments.credit)
    }
  }

  const refund: Refund = {
    id: newId('refund'),
    businessId: business.id,
    saleId: sale.id,
    productId: sale.items[0]?.productId,
    quantity: sale.items.reduce((sum, item) => sum + item.quantity, 0),
    amount: round2(sale.total),
    reason: reason?.trim() || undefined,
    createdAt: nowIso(),
  }
  business.refunds.push(refund)
  sale.refundedAt = nowIso()

  enqueueSyncAction(state, business.id, 'refund-added', refund)
  return refund
}

// --- Owner finance reporting (dashboard) ------------------------------------

export type FinanceRange = { start: string; end: string }

export type FinancePeriod = 'today' | 'week' | 'month' | 'custom' | 'all'

/** Inclusive local-day range presets, plus a custom start/end pair. */
export function financeRangeFor(
  period: FinancePeriod,
  custom?: { start: string; end: string },
): FinanceRange {
  const today = new Date()
  const end = todayKey()
  if (period === 'today') {
    return { start: end, end }
  }
  if (period === 'week') {
    const start = new Date(today)
    start.setDate(start.getDate() - 6)
    return { start: localDayKey(start.toISOString()), end }
  }
  if (period === 'month') {
    const start = new Date(today)
    start.setDate(start.getDate() - 29)
    return { start: localDayKey(start.toISOString()), end }
  }
  if (period === 'custom') {
    const start = custom?.start ?? end
    const rangeEnd = custom?.end ?? end
    // Tolerate a swapped pair rather than returning an empty report.
    return start <= rangeEnd ? { start, end: rangeEnd } : { start: rangeEnd, end: start }
  }
  return { start: '0000-01-01', end: '9999-12-31' }
}

function inRange(dayKey: string, range: FinanceRange): boolean {
  return dayKey >= range.start && dayKey <= range.end
}

export type ProductPerformance = {
  productId: string
  name: string
  quantitySold: number
  revenue: number
  costOfGoods: number
  grossProfit: number
  /** Items currently sitting in stock with no sales in the period. */
  zeroSold: boolean
}

/**
 * Per-product performance inside a date range: quantity, revenue and gross
 * margin. Powers best/worst sellers and most-profitable rankings. Products
 * with zero sales in the period appear with zeroSold: true (dead stock).
 */
export function productPerformanceForRange(business: Business, range: FinanceRange): ProductPerformance[] {
  const perf = new Map<string, ProductPerformance>()

  for (const product of business.products) {
    perf.set(product.id, {
      productId: product.id,
      name: product.name,
      quantitySold: 0,
      revenue: 0,
      costOfGoods: 0,
      grossProfit: 0,
      zeroSold: true,
    })
  }

  for (const sale of business.sales) {
    if (sale.refundedAt || !inRange(localDayKey(sale.createdAt), range)) continue
    for (const item of sale.items) {
      const entry = perf.get(item.productId)
      if (!entry) continue
      const cost = business.products.find((p) => p.id === item.productId)?.costPrice ?? 0
      entry.quantitySold += item.quantity
      entry.revenue += item.quantity * item.unitPrice
      entry.costOfGoods += item.quantity * cost
      entry.grossProfit = entry.revenue - entry.costOfGoods
      entry.zeroSold = false
    }
  }

  return [...perf.values()]
}

export type RevenuePoint = { day: string; revenue: number; profit: number }

/** Revenue and gross profit per day inside the range (for the trend chart). */
export function revenueByDayForRange(business: Business, range: FinanceRange): RevenuePoint[] {
  const points = new Map<string, RevenuePoint>()
  const cursor = new Date(`${range.start}T00:00:00`)
  const end = new Date(`${range.end}T00:00:00`)
  if (
    Number.isNaN(cursor.getTime()) ||
    Number.isNaN(end.getTime()) ||
    range.start === '0000-01-01'
  ) {
    // 'All time': aggregate by day from the data itself (bounded by sales).
    for (const sale of business.sales) {
      if (sale.refundedAt) continue
      const day = localDayKey(sale.createdAt)
      const point = points.get(day) ?? { day, revenue: 0, profit: 0 }
      point.revenue += sale.total
      point.profit += sale.items.reduce((sum, item) => {
        const cost = business.products.find((p) => p.id === item.productId)?.costPrice ?? 0
        return sum + item.quantity * (item.unitPrice - cost)
      }, 0)
      points.set(day, point)
    }
    return [...points.values()].sort((a, b) => a.day.localeCompare(b.day))
  }

  // Clamp the rendered window: a custom range of years would still chart day
  // by day, but we cap the number of daily points to keep the SVG light on
  // low-spec phones.
  const maxPoints = 120
  if ((end.getTime() - cursor.getTime()) / 86_400_000 > maxPoints) {
    end.setTime(cursor.getTime() + maxPoints * 86_400_000)
  }

  while (cursor <= end) {
    const day = localDayKey(cursor.toISOString())
    points.set(day, { day, revenue: 0, profit: 0 })
    cursor.setDate(cursor.getDate() + 1)
  }

  for (const sale of business.sales) {
    const day = localDayKey(sale.createdAt)
    const point = points.get(day)
    if (!point || sale.refundedAt) continue
    point.revenue += sale.total
    point.profit += sale.items.reduce((sum, item) => {
      const cost = business.products.find((p) => p.id === item.productId)?.costPrice ?? 0
      return sum + item.quantity * (item.unitPrice - cost)
    }, 0)
    points.set(day, point)
  }

  return [...points.values()].sort((a, b) => a.day.localeCompare(b.day))
}

export type FinanceReport = {
  range: FinanceRange
  /** Sales revenue minus refunds for the period. */
  revenue: number
  /** Visible money back out to customers (own line on the dashboard). */
  refunds: number
  /** Sum of cost price × quantity sold for the period. */
  costOfGoods: number
  /** Revenue minus cost of goods sold. Never shown as the full picture. */
  grossProfit: number
  /** Manual expenses logged by the owner for the period. */
  expenses: number
  /** Gross profit minus expenses. The number the owner actually keeps. */
  netProfit: number
  /** Since inception: net profit against everything the owner put in. */
  totalInvested: number
  /** Percentage of invested capital recovered so far (cumulative). */
  roiPercent: number
  /** Expenses per category for the period. */
  expensesByCategory: Record<string, number>
}

/**
 * The owner's profit and loss view for a date range. Gross and net profit
 * are always reported separately and labelled; refunds are their own line.
 * ROI is inherently cumulative since inception, independent of the range.
 */
export function financeReportForRange(business: Business, range: FinanceRange): FinanceReport {
  let revenue = 0
  let costOfGoods = 0
  let refundTotal = 0

  for (const sale of business.sales) {
    if (!inRange(localDayKey(sale.createdAt), range)) continue
    if (sale.refundedAt) {
      refundTotal += sale.total
      continue
    }
    revenue += sale.total
    for (const item of sale.items) {
      const cost = business.products.find((p) => p.id === item.productId)?.costPrice ?? 0
      costOfGoods += item.quantity * cost
    }
  }

  const expenses = business.expenses.filter((expense) => inRange(expense.date, range))
  const expensesTotal = expenses.reduce((sum, expense) => sum + expense.amount, 0)
  const expensesByCategory: Record<string, number> = {}
  for (const expense of expenses) {
    expensesByCategory[expense.category] =
      (expensesByCategory[expense.category] ?? 0) + expense.amount
  }

  const grossProfit = revenue - costOfGoods
  const netProfit = grossProfit - expensesTotal

  // ROI is inherently since-inception, so the cumulative figure is computed
  // over all history regardless of the selected range (single extra pass).
  let cumulativeRevenue = 0
  let cumulativeCost = 0
  for (const sale of business.sales) {
    if (sale.refundedAt) continue
    cumulativeRevenue += sale.total
    for (const item of sale.items) {
      const cost = business.products.find((p) => p.id === item.productId)?.costPrice ?? 0
      cumulativeCost += item.quantity * cost
    }
  }
  const cumulativeExpenses = business.expenses.reduce((sum, expense) => sum + expense.amount, 0)
  const cumulativeNet = cumulativeRevenue - cumulativeCost - cumulativeExpenses
  const totalInvested = totalCapitalInvested(business)
  const roiPercent = totalInvested > 0 ? round2((cumulativeNet / totalInvested) * 100) : 0

  return {
    range,
    revenue: round2(revenue),
    refunds: round2(refundTotal),
    costOfGoods: round2(costOfGoods),
    grossProfit: round2(grossProfit),
    expenses: round2(expensesTotal),
    netProfit: round2(netProfit),
    totalInvested,
    roiPercent,
    expensesByCategory,
  }
}

/**
 * The expense log filtered like every other list in the app: optional date
 * range and category. Pure function so the UI can call it per render.
 */
export function filteredExpenses(
  business: Business,
  filter: { range?: FinanceRange; category?: ExpenseCategory | 'all' },
): Expense[] {
  return [...business.expenses]
    .filter((expense) => {
      if (filter.category && filter.category !== 'all' && expense.category !== filter.category) {
        return false
      }
      if (filter.range && !inRange(expense.date, filter.range)) return false
      return true
    })
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
}

// --- eTIMS helpers (Section 4) ----------------------------------------------

/** Monotonic eTIMS invoice number per business/branch: 1, 2, 3… no gaps. */
export function nextEtimsInvoiceNumber(business: Business): number {
  const signed = business.sales
    .map((sale) => sale.etims?.invcNo ?? 0)
    .reduce((max, value) => Math.max(max, value), 0)
  return signed + 1
}

/** Builds the eTIMS OSCU sales payload (structure per KRA documentation). */
export function buildEtimsSalePayload(
  business: Business,
  sale: Sale,
  invcNo: number,
): Record<string, unknown> {
  const vatRate = business.vatRate ?? 16
  const taxable = round2(sale.total / (1 + vatRate / 100))
  const taxAmount = round2(sale.total - taxable)
  const timestamp = sale.createdAt.replace(/\D/g, '').slice(0, 14)

  return {
    tin: business.kraPin,
    bhfId: business.etimsBhfId ?? '00',
    invcNo,
    orgInvcNo: 0,
    trdInvcNo: sale.id,
    salesTyCd: 'N',
    rcptTyCd: 'S',
    pmtTyCd: sale.payments.cash > 0 ? '01' : '02', // 01 cash, 02 non-cash
    salesSttsCd: '02',
    cfmDt: timestamp,
    salesDt: timestamp.slice(0, 8),
    totItemCnt: sale.items.length,
    taxRtB: vatRate,
    taxblAmtB: taxable,
    taxAmtB: taxAmount,
    totTaxblAmt: taxable,
    totTaxAmt: taxAmount,
    totAmt: round2(sale.total),
    regrId: 'pos',
    regrNm: 'pos',
    modrId: 'pos',
    modrNm: 'pos',
    itemList: sale.items.map((item, index) => {
      const lineTotal = round2(item.quantity * item.unitPrice)
      const lineTaxable = round2(lineTotal / (1 + vatRate / 100))
      return {
        itemSeq: index + 1,
        itemCd: item.productId,
        itemNm: business.products.find((p) => p.id === item.productId)?.name ?? 'Item',
        qty: item.quantity,
        prc: round2(item.unitPrice),
        splyAmt: lineTaxable,
        taxTyCd: 'B',
        taxblAmt: lineTaxable,
        taxAmt: round2(lineTotal - lineTaxable),
        totAmt: lineTotal,
      }
    }),
  }
}

/** eTIMS control/verification number built from the fiscal stamp. */
export function buildEtimsControlNumber(
  business: Business,
  invcNo: number,
  curRcptNo: number | undefined,
): string {
  const tin = (business.kraPin ?? '').toUpperCase()
  const bhf = business.etimsBhfId ?? '00'
  const rcpt = curRcptNo ?? invcNo
  return `KE${tin.slice(0, 6)}/${bhf}/${rcpt}/${invcNo}`
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

export type DailySummary = {
  day: string
  totalSales: number
  cash: number
  mpesa: number
  credit: number
  topItems: Array<{ name: string; quantity: number }>
  attendants: Record<string, number>
}

export function summarizeSalesForDay(business: Business, day: string): DailySummary {
  const salesToday = business.sales.filter((sale) => localDayKey(sale.createdAt) === day)

  const totals = salesToday.reduce(
    (acc, sale) => {
      acc.totalSales += sale.total
      acc.cash += sale.payments.cash
      acc.mpesa += sale.payments.mpesa
      acc.credit += sale.payments.credit
      return acc
    },
    { totalSales: 0, cash: 0, mpesa: 0, credit: 0 },
  )

  const itemMap = new Map<string, number>()
  salesToday.forEach((sale) => {
    sale.items.forEach((item) => {
      itemMap.set(item.productId, (itemMap.get(item.productId) ?? 0) + item.quantity)
    })
  })

  const topItems = [...itemMap.entries()]
    .map(([productId, quantity]) => {
      const product = business.products.find((entry) => entry.id === productId)
      return { name: product?.name ?? 'Item', quantity }
    })
    .sort((a, b) => b.quantity - a.quantity)
    .slice(0, 4)

  const attendants = salesToday.reduce<Record<string, number>>((acc, sale) => {
    const staff = sale.attendantId
      ? business.staff.find((entry) => entry.id === sale.attendantId)
      : undefined
    const key = staff?.name ?? (sale.attendantId ? sale.attendantId : 'Unknown')
    acc[key] = (acc[key] ?? 0) + sale.total
    return acc
  }, {})

  return { day, ...totals, topItems, attendants }
}

/** Newest-first compact sales feed for the live activity panel. */
export function recentSalesForFeed(
  business: Business,
  limit = 6,
): Array<{
  id: string
  time: string
  total: number
  attendant: string
  mpesa: number
  cash: number
  credit: number
  refunded: boolean
}> {
  return [...business.sales]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, limit)
    .map((sale) => {
      const staff = sale.attendantId
        ? business.staff.find((entry) => entry.id === sale.attendantId)
        : undefined
      return {
        id: sale.id,
        time: new Date(sale.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        total: sale.total,
        attendant: staff?.name ?? (sale.attendantId ? 'Staff' : 'Owner'),
        mpesa: sale.payments.mpesa,
        cash: sale.payments.cash,
        credit: sale.payments.credit,
        refunded: Boolean(sale.refundedAt),
      }
    })
}

export function exportSalesCsv(business: Business): string {
  const header = 'id,businessId,total,cash,mpesa,credit,createdAt,customerId,attendantId\n'
  const rows = business.sales
    .map(
      (sale) =>
        `${sale.id},${sale.businessId},${sale.total},${sale.payments.cash},${sale.payments.mpesa},${sale.payments.credit},${sale.createdAt},${sale.customerId ?? ''},${sale.attendantId ?? ''}`,
    )
    .join('\n')

  return `${header}${rows}`
}

export function exportStockCsv(business: Business): string {
  const header =
    'id,name,category,price,costPrice,stockQuantity,unitOfMeasure,expiryDate,batchNumber,lowStockAlert\n'
  const rows = business.products
    .map(
      (product) =>
        `${product.id},${product.name},${product.category},${product.price},${product.costPrice},${product.stockQuantity},${product.unitOfMeasure},${product.expiryDate ?? ''},${product.batchNumber ?? ''},${product.lowStockAlert}`,
    )
    .join('\n')

  return `${header}${rows}`
}

export function exportCustomersCsv(business: Business): string {
  const header = 'id,name,phone,balance\n'
  const rows = business.customers
    .map((customer) => `${customer.id},${customer.name},${customer.phone ?? ''},${customer.balance}`)
    .join('\n')

  return `${header}${rows}`
}

// --- Sync queue primitives ---------------------------------------------

export function enqueueSyncAction(
  state: AppState,
  businessId: string,
  action: SyncAction,
  payload: unknown,
): SyncQueueItem {
  const item: SyncQueueItem = {
    id: newId('sync'),
    businessId,
    action,
    payload,
    status: 'pending',
    createdAt: nowIso(),
    attempts: 0,
  }

  state.syncQueue.push(item)
  return item
}

export function pendingSyncCount(state: AppState): number {
  return state.syncQueue.filter((item) => item.status !== 'synced').length
}

export function takePendingSyncBatch(
  state: AppState,
  max: number,
): SyncQueueItem[] {
  return state.syncQueue.filter((item) => item.status === 'pending').slice(0, max)
}

export function markSynced(state: AppState, ids: string[]): void {
  const idSet = new Set(ids)
  state.syncQueue.forEach((item) => {
    if (idSet.has(item.id)) {
      item.status = 'synced'
      item.attempts += 1
    }
  })
}

export function markInFlight(state: AppState, ids: string[]): void {
  const idSet = new Set(ids)
  state.syncQueue.forEach((item) => {
    if (idSet.has(item.id)) {
      item.status = 'in-flight'
      item.attempts += 1
    }
  })
}

export function markBackPending(state: AppState, ids: string[], error: string): void {
  const idSet = new Set(ids)
  state.syncQueue.forEach((item) => {
    if (idSet.has(item.id)) {
      item.status = 'pending'
      item.lastError = error
    }
  })
}

export function markConflict(
  state: AppState,
  id: string,
  conflict: SyncConflict[],
): void {
  const item = state.syncQueue.find((entry) => entry.id === id)
  if (item) {
    item.status = 'conflict'
    item.conflict = conflict
  }
}

export function markFailed(state: AppState, id: string, error: string): void {
  const item = state.syncQueue.find((entry) => entry.id === id)
  if (item) {
    item.status = 'error'
    item.lastError = error
  }
}

// Locally-owned modules keep a back-reference so pure helpers can enqueue
// sync actions without threading AppState through every call. The real app
// wires this once at startup; tests call setAppState(state) in beforeEach.
let activeState: AppState | null = null

export function setAppState(state: AppState): void {
  activeState = state
}

export function stateOf(): AppState {
  if (!activeState) {
    throw new Error('App state not initialised; call setAppState(state) first')
  }
  return activeState
}
