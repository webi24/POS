import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import {
  createInitialState,
  DEFAULT_BRANCH_NAME,
  normalizeBranches,
  normalizeFinanceLedgers,
  setAppState,
  type AppState,
  type AuditEntry,
  type Business,
  type CapitalInjection,
  type Customer,
  type Expense,
  type OwnerAccount,
  type PaymentMap,
  type Product,
  type Refund,
  type Sale,
  type Staff,
  type StockAdjustment,
  type SyncQueueItem,
} from './posStore'

const DB_NAME = 'kenya-pos-db'
const DB_VERSION = 4

export type CartItem = {
  productId: string
  name: string
  quantity: number
  unitPrice: number
}

type PendingSaleDraft = {
  cart: CartItem[]
  payments: PaymentMap
  customerId?: string
  savedAt: string
}

type PosDbSchema = DBSchema & {
  businesses: {
    key: string
    value: Business
    indexes: { 'by-business': string }
  }
  products: {
    key: string
    value: Product
    indexes: { 'by-business': string }
  }
  customers: {
    key: string
    value: Customer
    indexes: { 'by-business': string }
  }
  staff: {
    key: string
    value: Staff
    indexes: { 'by-business': string }
  }
  sales: {
    key: string
    value: Sale
    indexes: { 'by-business': string }
  }
  stockAdjustments: {
    key: string
    value: StockAdjustment
    indexes: { 'by-business': string }
  }
  syncQueue: {
    key: string
    value: SyncQueueItem
    indexes: { 'by-business': string }
  }
  owners: {
    key: string
    value: OwnerAccount
  }
  auditTrail: {
    key: string
    value: AuditEntry
    indexes: { 'by-business': string }
  }
  expenses: {
    key: string
    value: Expense
    indexes: { 'by-business': string }
  }
  capitalInjections: {
    key: string
    value: CapitalInjection
    indexes: { 'by-business': string }
  }
  refunds: {
    key: string
    value: Refund
    indexes: { 'by-business': string }
  }
  meta: {
    key: string
    value: unknown
  }
}

let dbPromise: Promise<IDBPDatabase<PosDbSchema>> | null = null

function getDb(): Promise<IDBPDatabase<PosDbSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<PosDbSchema>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        // v1 kept the whole app state under one key in a single unnamed store.
        // v2 moves to per-record stores; the migration reads the old blob and
        // distributes records into their stores.
        if (oldVersion < 2) {
          const recordStores = [
            'businesses',
            'products',
            'customers',
            'staff',
            'sales',
            'stockAdjustments',
            'syncQueue',
          ] as const
          for (const storeName of recordStores) {
            if (!db.objectStoreNames.contains(storeName)) {
              const store = db.createObjectStore(storeName)
              store.createIndex('by-business', 'businessId')
            }
          }
        }
        // v3 adds owner accounts (Section 2/3) and persistent audit trail (Section 5).
        if (oldVersion < 3) {
          if (!db.objectStoreNames.contains('owners')) {
            db.createObjectStore('owners')
          }
          if (!db.objectStoreNames.contains('auditTrail')) {
            const store = db.createObjectStore('auditTrail')
            store.createIndex('by-business', 'businessId')
          }
        }
        // v4 adds the owner finance ledgers: expenses, capital injections
        // and refunds (owner dashboard).
        if (oldVersion < 4) {
          const financeStores = ['expenses', 'capitalInjections', 'refunds'] as const
          for (const storeName of financeStores) {
            if (!db.objectStoreNames.contains(storeName)) {
              const store = db.createObjectStore(storeName)
              store.createIndex('by-business', 'businessId')
            }
          }
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta')
        }
      },
    })
  }
  return dbPromise
}

const STORE_FOR_KIND = {
  products: 'products',
  customers: 'customers',
  staff: 'staff',
  sales: 'sales',
  stockAdjustments: 'stockAdjustments',
} as const

export type RecordKind = keyof typeof STORE_FOR_KIND

/**
 * Loads app state from IndexedDB. Handles both the legacy v1 single-blob
 * layout and the v2 per-record layout so existing devices migrate cleanly.
 */
export async function loadState(): Promise<AppState> {
  const db = await getDb()

  const legacy = (await db.get('meta', 'pos-state')) as AppState | undefined
  if (legacy && Array.isArray(legacy.businesses) && legacy.businesses.length > 0) {
    await migrateLegacyState(db, legacy)
    await db.delete('meta', 'pos-state')
    return legacy
  }

  const state = createInitialState()
  const businesses = await db.getAll('businesses')
  state.businesses = businesses
  state.owners = await db.getAll('owners')

  for (const business of state.businesses) {
    business.products = await db.getAllFromIndex('products', 'by-business', business.id)
    business.customers = await db.getAllFromIndex('customers', 'by-business', business.id)
    business.staff = await db.getAllFromIndex('staff', 'by-business', business.id)
    business.sales = await db.getAllFromIndex('sales', 'by-business', business.id)
    business.stockAdjustments = await db.getAllFromIndex('stockAdjustments', 'by-business', business.id)
    business.auditTrail = await db.getAllFromIndex('auditTrail', 'by-business', business.id)
    business.expenses = await db.getAllFromIndex('expenses', 'by-business', business.id)
    business.capitalInjections = await db.getAllFromIndex('capitalInjections', 'by-business', business.id)
    business.refunds = await db.getAllFromIndex('refunds', 'by-business', business.id)
    normalizeFinanceLedgers(business)

    // Multi-branch: pre-branch businesses get their implicit main branch so
    // the rest of the app can always assume branches exists and is non-empty.
    normalizeBranches(business)
    if (business.branches.length === 0) {
      business.branches.push({
        id: `${business.id}-main`,
        businessId: business.id,
        name: DEFAULT_BRANCH_NAME,
        createdAt: new Date(0).toISOString(),
      })
    }
  }

  state.syncQueue = await db.getAll('syncQueue')
  return state
}

async function migrateLegacyState(db: IDBPDatabase<PosDbSchema>, legacy: AppState): Promise<void> {
  const tx = db.transaction(
    [
      'businesses',
      'products',
      'customers',
      'staff',
      'sales',
      'stockAdjustments',
      'syncQueue',
      'owners',
      'auditTrail',
      'expenses',
      'capitalInjections',
      'refunds',
    ],
    'readwrite',
  )

  for (const owner of legacy.owners ?? []) {
    await tx.objectStore('owners').put(owner, owner.id)
  }

  for (const business of legacy.businesses) {
    await tx.objectStore('businesses').put(business, business.id)
    for (const product of business.products ?? []) {
      await tx.objectStore('products').put(product, product.id)
    }
    for (const customer of business.customers ?? []) {
      await tx.objectStore('customers').put(customer, customer.id)
    }
    for (const staff of business.staff ?? []) {
      await tx.objectStore('staff').put(staff, staff.id)
    }
    for (const sale of business.sales ?? []) {
      await tx.objectStore('sales').put(sale, sale.id)
    }
    for (const adjustment of business.stockAdjustments ?? []) {
      await tx.objectStore('stockAdjustments').put(adjustment, adjustment.id)
    }
    for (const auditEntry of business.auditTrail ?? []) {
      await tx.objectStore('auditTrail').put(auditEntry, auditEntry.id)
    }
    for (const expense of business.expenses ?? []) {
      await tx.objectStore('expenses').put(expense, expense.id)
    }
    for (const injection of business.capitalInjections ?? []) {
      await tx.objectStore('capitalInjections').put(injection, injection.id)
    }
    for (const refund of business.refunds ?? []) {
      await tx.objectStore('refunds').put(refund, refund.id)
    }
  }

  for (const item of legacy.syncQueue ?? []) {
    await tx.objectStore('syncQueue').put(item, item.id)
  }

  await tx.done
}

/** Persists one business's records inside a single transaction. */
export async function saveBusinessRecords(business: Business): Promise<void> {
  const db = await getDb()
  const storeNames = [
    'businesses',
    'products',
    'customers',
    'staff',
    'sales',
    'stockAdjustments',
    'auditTrail',
    'expenses',
    'capitalInjections',
    'refunds',
  ] as const
  const tx = db.transaction(storeNames, 'readwrite')

  await tx.objectStore('businesses').put(business, business.id)
  for (const product of business.products) {
    await tx.objectStore('products').put(product, product.id)
  }
  for (const customer of business.customers) {
    await tx.objectStore('customers').put(customer, customer.id)
  }
  for (const staff of business.staff) {
    await tx.objectStore('staff').put(staff, staff.id)
  }
  for (const sale of business.sales) {
    await tx.objectStore('sales').put(sale, sale.id)
  }
  for (const adjustment of business.stockAdjustments) {
    await tx.objectStore('stockAdjustments').put(adjustment, adjustment.id)
  }
  for (const auditEntry of business.auditTrail) {
    await tx.objectStore('auditTrail').put(auditEntry, auditEntry.id)
  }
  for (const expense of business.expenses) {
    await tx.objectStore('expenses').put(expense, expense.id)
  }
  for (const injection of business.capitalInjections) {
    await tx.objectStore('capitalInjections').put(injection, injection.id)
  }
  for (const refund of business.refunds) {
    await tx.objectStore('refunds').put(refund, refund.id)
  }

  await tx.done
}

/** Upserts owner accounts (small list, called on every owner change). */
export async function saveOwners(owners: OwnerAccount[]): Promise<void> {
  const db = await getDb()
  const tx = db.transaction('owners', 'readwrite')
  for (const owner of owners) {
    await tx.objectStore('owners').put(owner, owner.id)
  }
  await tx.done
}

export async function saveSyncQueueItems(items: SyncQueueItem[]): Promise<void> {
  if (items.length === 0) return
  const db = await getDb()
  const tx = db.transaction('syncQueue', 'readwrite')
  for (const item of items) {
    await tx.objectStore('syncQueue').put(item, item.id)
  }
  await tx.done
}

/** Removes synced queue items, keeping pending/conflict/error items for review. */
export async function pruneSyncedQueueItems(state: AppState): Promise<void> {
  const synced = state.syncQueue.filter((item) => item.status === 'synced')
  if (synced.length === 0) return

  const db = await getDb()
  const tx = db.transaction('syncQueue', 'readwrite')
  for (const item of synced) {
    await tx.objectStore('syncQueue').delete(item.id)
  }
  await tx.done

  state.syncQueue = state.syncQueue.filter((item) => item.status !== 'synced')
}

const CART_KEY = 'cart-draft'
const RESTORED_KEY_PREFIX = 'restored-business:'

/** Marks a business as restored from the backend on THIS device (Section 7). */
export async function markRestoredFromBackend(businessId: string): Promise<void> {
  const db = await getDb()
  await db.put('meta', new Date().toISOString(), RESTORED_KEY_PREFIX + businessId)
}

export async function wasRestoredFromBackend(businessId: string): Promise<boolean> {
  const db = await getDb()
  const value = await db.get('meta', RESTORED_KEY_PREFIX + businessId)
  return value != null
}

export async function saveCartDraft(draft: PendingSaleDraft): Promise<void> {
  const db = await getDb()
  await db.put('meta', draft, CART_KEY)
}

export async function loadCartDraft(): Promise<PendingSaleDraft | null> {
  const db = await getDb()
  const draft = (await db.get('meta', CART_KEY)) as PendingSaleDraft | undefined
  return draft ?? null
}

export async function clearCartDraft(): Promise<void> {
  const db = await getDb()
  await db.delete('meta', CART_KEY)
}

/** Convenience bootstrap: load state and wire the module-level back-reference. */
export async function initState(): Promise<AppState> {
  const state = await loadState()
  setAppState(state)
  return state
}
