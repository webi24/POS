import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import './App.css'
import {
  addBusiness,
  addBranch,
  addCapitalInjection,
  addExpense,
  addProduct,
  auditTrailFor,
  completeSale,
  branchByIdOr,
  branchScope,
  createInitialState,
  createOwner,
  appendAuditEntry,
  defaultCategoriesFor,
  enqueueSyncAction,
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  exportCustomersCsv,
  exportSalesCsv,
  exportStockCsv,
  financeRangeFor,
  financeReportForRange,
  filteredExpenses,
  markOwnerVerified,
  normalizeFinanceLedgers,
  ownerBusinesses,
  parseBulkProductCsv,
  pendingSyncCount,
  productPerformanceForRange,
  recordStaff,
  recordStockAdjustment,
  recentSalesForFeed,
  refundSale,
  removeStaff,
  revenueByDayForRange,
  setStartingCapital,
  businessesVisibleTo,
  summarizeSalesForDay,
  todayKey,
  localDayKey,
  updateProductPrice,
  verifyOwnerCredentials,
  stockForBranch,
  verifyStaffPin,
  verifyStaffPinForBranch,
  withBranchScope,
  type AppState,
  type AuditEntry,
  type BusinessType,
  type CapitalInjection,
  type Customer,
  type Expense,
  type ExpenseCategory,
  type FinancePeriod,
  type PaymentMap,
  type Product,
  type Refund,
  type Sale,
  type Staff,
  type StockAdjustment,
  type StockAdjustmentReason,
  type UnitOfMeasure,
} from './lib/posStore'
import {
  clearCartDraft,
  initState,
  loadCartDraft,
  markRestoredFromBackend,
  pruneSyncedQueueItems,
  saveBusinessRecords,
  saveCartDraft,
  saveOwners,
  saveSyncQueueItems,
  type CartItem,
} from './lib/offlineDb'
import { createInMemorySyncAdapter, resolveConflict, runSync, type SyncAdapter } from './lib/syncEngine'
import {
  createMpesaClient,
  formatKenyanPhone,
  isValidMpesaReceipt,
  normalizeKenyanPhone,
  type StkStatus,
} from './lib/mpesa'
import {
  cameraScanSupported,
  detectScanFromKeystrokes,
  findProductByBarcode,
  type ScannerKeystroke,
} from './lib/barcode'
import { CameraBarcodeScanner } from './components/CameraBarcodeScanner'
import {
  authenticatedPush,
  backendEnabled,
  fetchMyBusinesses,
  getMpesaStatus,
  getValidAccessToken,
  mpesaProxyUrl,
  createBusinessOnServer,
  restoreBusinessData,
  setupMpesaCredentials,
  signSaleWithEtims,
  signInOwner,
  signOutOwner,
  signUpOwner,
  type MpesaStatusInfo,
} from './lib/backend'

const EMPTY_PAYMENTS: PaymentMap = { cash: 0, mpesa: 0, credit: 0 } // credit kept for data compat; UI removed

const mpesaClient = backendEnabled ? createMpesaClient(mpesaProxyUrl) : null

const syncAdapter: SyncAdapter = backendEnabled
  ? {
      name: 'supabase',
      push: (items) => authenticatedPush(items),
    }
  : createInMemorySyncAdapter()

/**
 * Owner SESSION: who is signed in on this device. Credentials live either
 * in the backend (Supabase auth) or, in demo mode, as hashes in
 * state.owners. Nothing sensitive is kept here.
 */
type OwnerSession = {
  email: string
  fullName?: string
  loggedInAt: number
}

type ActiveStaff = { id: string; name: string }

/** Owner-only screens reachable from the hamburger menu. */
type OwnerScreen =
  | 'inventory'
  | 'customers'
  | 'stock'
  | 'staff'
  | 'price'
  | 'audit'
  | 'backup'
  | 'dashboard'
  | 'connections'
  | 'settings'

/** Plain-language menu labels; owners get everything, attendants only Sell. */
const OWNER_MENU: Array<{ id: OwnerScreen; label: string }> = [
  { id: 'inventory', label: 'Inventory (items you sell)' },
  { id: 'customers', label: 'Customers' },
  { id: 'stock', label: 'Correct stock' },
  { id: 'staff', label: 'Staff & PINs' },
  { id: 'price', label: 'Price change' },
  { id: 'dashboard', label: 'Money dashboard' },
  { id: 'audit', label: 'What happened (log)' },
  { id: 'backup', label: 'Backup & export' },
  { id: 'connections', label: 'Connections (Sync, M-Pesa, eTIMS)' },
  { id: 'settings', label: 'Business settings' },
]

type MpesaFlow =
  | { stage: 'idle' }
  | { stage: 'pushing' }
  | {
      stage: 'waiting'
      checkoutRequestId: string
      /** Normalized number the prompt was sent to, shown while waiting. */
      phone: string
      amount: number
      /** Started-at timestamp powering the countdown. */
      startedAt: number
    }
  | { stage: 'manual-entry'; note?: string }

/** Owner session lock: 10 minutes of inactivity on shared devices. */
const OWNER_IDLE_MS = 10 * 60 * 1000

/**
 * Display countdown for the on-screen prompt window (Safaricom's STK prompt
 * itself lives ~60s on the customer's phone). The background listener keeps
 * capturing late payments for ~90s (30 × 3s) before giving up entirely.
 */
const STK_PROMPT_SECONDS = 45

function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

/**
 * Lightweight SVG trend chart: revenue and gross profit per day. Deliberately
 * dependency-free (no Chart.js) so it renders instantly on low-end Android
 * phones; the KES numbers above it remain the primary display.
 */
function TrendChart({ points }: { points: Array<{ day: string; revenue: number; profit: number }> }) {
  const width = 720
  const height = 180
  const padX = 34
  const padY = 14

  if (points.length < 2) {
    return <p className="muted">Pick at least two days to see the trend.</p>
  }

  const max = Math.max(...points.map((point) => Math.max(point.revenue, point.profit)), 1)
  const stepX = (width - padX * 2) / (points.length - 1)
  const scaleY = (value: number) => height - padY - (value / max) * (height - padY * 2)
  const scaleX = (index: number) => padX + index * stepX

  const line = (key: 'revenue' | 'profit') =>
    points.map((point, index) => `${index === 0 ? 'M' : 'L'}${scaleX(index).toFixed(1)},${scaleY(point[key]).toFixed(1)}`).join(' ')

  // A midline gridline plus the max label gives the eye a reference point.
  const midY = (height - padY * 2) / 2 + padY
  const firstLabel = points[0]?.day.slice(5)
  const lastLabel = points[points.length - 1]?.day.slice(5)

  return (
    <svg
      className="trend-chart"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Daily revenue up to ${max} shillings, ${points.length} days`}
      preserveAspectRatio="none"
    >
      <line x1={padX} y1={midY} x2={width - padX} y2={midY} className="trend-grid" />
      <text x={2} y={midY + 4} className="trend-tick">
        {Math.round(max / 2).toLocaleString()}
      </text>
      <text x={2} y={padY + 8} className="trend-tick">
        {max.toLocaleString()}
      </text>
      <path d={line('revenue')} className="trend-line revenue" />
      <path d={line('profit')} className="trend-line profit" />
      <text x={padX} y={height - 2} className="trend-tick">
        {firstLabel}
      </text>
      <text x={width - padX} y={height - 2} textAnchor="end" className="trend-tick">
        {lastLabel}
      </text>
    </svg>
  )
}

function seedDemoBusiness(state: AppState): void {
  const business = addBusiness(state, {
    id: 'biz-demo',
    name: 'Kisumu Market (Demo)',
    type: 'shop',
    mpesaShortCode: '174379',
  })

  const demoProducts = [
    { name: 'Maize Flour', category: 'Food', price: 120, costPrice: 90, stockQuantity: 20, unitOfMeasure: 'pack' as UnitOfMeasure },
    { name: 'Cooking Oil 1L', category: 'Food', price: 350, costPrice: 280, stockQuantity: 12, unitOfMeasure: 'litre' as UnitOfMeasure },
    { name: 'Soap', category: 'Home', price: 80, costPrice: 55, stockQuantity: 4, unitOfMeasure: 'piece' as UnitOfMeasure },
    { name: 'Paracetamol', category: 'Health', price: 45, costPrice: 30, stockQuantity: 28, unitOfMeasure: 'pack' as UnitOfMeasure },
  ]
  demoProducts.forEach((product) => addProduct(business, { ...product, lowStockAlert: 5 }))

  business.customers.push(
    { id: 'cust-demo-a', businessId: business.id, name: 'Aisha', phone: '0712345678', balance: 250 },
    { id: 'cust-demo-b', businessId: business.id, name: 'Juma', balance: 0 },
  )
  recordStaff(business, { id: 'staff-demo', name: 'Mary', pin: '1234', shift: 'Morning' })
  recordStaff(business, { id: 'staff-demo-2', name: 'Otieno', pin: '4321', shift: 'Evening' })

  // Demo owner as a real owner account (Section 2/3 model): businesses link
  // to the owner's email; the password is stored only as a demo-mode hash.
  business.ownerEmail = 'owner@demo.co.ke'
  const demoOwner = createOwner(state, {
    fullName: 'Demo Owner',
    email: 'owner@demo.co.ke',
    password: 'demo1234',
  })
  if (demoOwner.ok) {
    demoOwner.owner.emailVerified = true
    demoOwner.owner.verificationCode = undefined
  }

  // Demo data is local-only; keep the sync queue clean.
  state.syncQueue = []
}

function App() {
  const stateRef = useRef<AppState>(createInitialState())
  const [, forceRender] = useReducer((tick: number) => tick + 1, 0)
  const refresh = () => {
    forceRender()
    void persistAll(stateRef.current)
  }

  const [loaded, setLoaded] = useState(false)
  const [selectedBusinessId, setSelectedBusinessId] = useState('')
  const [search, setSearch] = useState('')
  const [cart, setCart] = useState<CartItem[]>([])
  const [paymentDraft, setPaymentDraft] = useState<PaymentMap>({ ...EMPTY_PAYMENTS })
  const [selectedCustomerId, setSelectedCustomerId] = useState('')
  const [statusMessage, setStatusMessage] = useState('Ready. Everything saves even without internet')
  const [online, setOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true)
  const [syncing, setSyncing] = useState(false)

  // --- Session state (owner + active staff) --------------------------------
  const [owner, setOwner] = useState<OwnerSession | null>(null)
  const [activeStaff, setActiveStaff] = useState<ActiveStaff | null>(null)

  const [signupForm, setSignupForm] = useState({
    name: '',
    type: 'shop' as BusinessType,
    shortCode: '',
  })

  const [staffForm, setStaffForm] = useState({ name: '', pin: '', shift: 'Morning' })
  const [productForm, setProductForm] = useState({
    name: '',
    category: 'General',
    price: '',
    costPrice: '',
    stockQuantity: '',
    unitOfMeasure: 'piece' as UnitOfMeasure,
    barcode: '',
    expiryDate: '',
    batchNumber: '',
    restrictedItem: false,
    lowStockAlert: '3',
  })
  const [customerForm, setCustomerForm] = useState({ name: '', phone: '' })
  const [stockForm, setStockForm] = useState({
    productId: '',
    reason: 'count-correction' as StockAdjustmentReason,
    quantityDelta: '',
  })
  const [bulkText, setBulkText] = useState('')
  const [bulkErrors, setBulkErrors] = useState<string[]>([])

  // --- Barcode scanning -----------------------------------------------------
  const scanBufferRef = useRef<ScannerKeystroke[]>([])
  const scanTimerRef = useRef<number | undefined>(undefined)
  const [scanHint, setScanHint] = useState('Scanner ready. Scan a barcode or tap items below')
  const [cameraScanOpen, setCameraScanOpen] = useState(false)
  /** Scanned-but-unrecognized code awaiting the "add it?" offer. */
  const [scanNotFoundCode, setScanNotFoundCode] = useState('')
  /** Product-form field the next camera scan should fill (name|barcode|price). */
  const [cameraScanTarget, setCameraScanTarget] = useState<'name' | 'barcode' | 'price'>('name')

  const [pendingStaffId, setPendingStaffId] = useState('')
  const [pinInput, setPinInput] = useState('')
  const [pinError, setPinError] = useState('')

  // --- Section 3: signup / login state (email-first, phone-ready) ----------
  // signupStep: 'account' → collect name/email/password → 'verify' → email
  // code → 'business' → create the first business under the account.
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signup')
  const [signupStep, setSignupStep] = useState<'account' | 'verify' | 'business'>('account')
  const [signupFullName, setSignupFullName] = useState('')
  const [signupPhone, setSignupPhone] = useState('')
  const [signupConfirm, setSignupConfirm] = useState('')
  const [authError, setAuthError] = useState('')
  const [verificationPending, setVerificationPending] = useState<string | null>(null)
  const [verificationCodeInput, setVerificationCodeInput] = useState('')
  const [verificationError, setVerificationError] = useState('')

  // --- Section 2: business chooser state -----------------------------------
  const [chooserTotals, setChooserTotals] = useState<Record<string, number>>({})
  const [businessChooserOpen, setBusinessChooserOpen] = useState(false)

  // --- Section 5: audit / price-change state -------------------------------
  const [priceForm, setPriceForm] = useState({ productId: '', newPrice: '' })

  // --- Section 6: walkthrough state (per account, not per device) ----------
  const [walkthroughStep, setWalkthroughStep] = useState<number | null>(null)

  // --- Section 7: restore state --------------------------------------------
  const [restoring, setRestoring] = useState(false)

  const [ownerEmailInput, setOwnerEmailInput] = useState('')
  const [ownerPasswordInput, setOwnerPasswordInput] = useState('')
  const [ownerLoginError, setOwnerLoginError] = useState('')
  const [ownerMode, setOwnerMode] = useState<'signin' | 'signup'>('signin')

  const [stkPhone, setStkPhone] = useState('')
  const [mpesaManualCode, setMpesaManualCode] = useState('')
  const [mpesa, setMpesa] = useState<MpesaFlow>({ stage: 'idle' })
  /** Ticks once per second while a prompt is waiting, driving the countdown. */
  const [nowTick, setNowTick] = useState(0)
  /** Checkout id of the most recent prompt, kept for late-payment listening. */
  const lastCheckoutRequestIdRef = useRef<string | null>(null)

  const [mpesaStatus, setMpesaStatus] = useState<MpesaStatusInfo>({ configured: false })
  const [mpesaFormOpen, setMpesaFormOpen] = useState(false)
  const [mpesaForm, setMpesaForm] = useState({ shortCode: '', consumerKey: '', consumerSecret: '' })
  const [mpesaFormError, setMpesaFormError] = useState('')

  // --- Section 4: eTIMS setup (identifiers only; cmcKey stays server-side) -
  const [etimsForm, setEtimsForm] = useState({ kraPin: '', bhfId: '00', deviceSerial: '' })
  const [etimsFormOpen, setEtimsFormOpen] = useState(false)

  const state = stateRef.current
  const business = useMemo(
    () => state.businesses.find((item) => item.id === selectedBusinessId) ?? state.businesses[0],
    [state.businesses, selectedBusinessId],
  )

  // Owner of THIS business: the session email must match the business's
  // ownerEmail. With a backend, RLS re-verifies every request server-side.
  const isOwnerHere = Boolean(business && owner && business.ownerEmail?.toLowerCase() === owner.email.toLowerCase())

  // A signed-in owner with zero businesses (fresh account, or one created on
  // the staff gate) goes straight to the chooser's create-business form.
  const ownerHasNoBusinesses = Boolean(owner && ownerBusinesses(state, { email: owner.email }).length === 0)

  // --- Persistence helpers ------------------------------------------------

  async function persistAll(currentState: AppState): Promise<void> {
    if (!loaded || currentState.businesses.length === 0) return
    await Promise.all(currentState.businesses.map((entry) => saveBusinessRecords(entry)))
    await saveSyncQueueItems(currentState.syncQueue)
  }

  // --- Boot ---------------------------------------------------------------

  useEffect(() => {
    let cancelled = false

    const boot = async () => {
      try {
        const loadedState = await initState()
        if (loadedState.businesses.length === 0) {
          seedDemoBusiness(loadedState)
        }
        if (cancelled) return
        stateRef.current = loadedState
        setSelectedBusinessId(loadedState.businesses[0].id)

        const draft = await loadCartDraft()
        if (draft && draft.cart.length > 0) {
          setCart(draft.cart)
          setPaymentDraft(draft.payments)
          setSelectedCustomerId(draft.customerId ?? '')
          setStatusMessage('Recovered your unfinished sale. Carry on where you left off')
        }

        const savedSession = localStorage.getItem('pos-active-staff')
        if (savedSession) {
          try {
            const session = JSON.parse(savedSession) as { businessId: string; staffId: string; name: string }
            const savedBusiness = loadedState.businesses.find((entry) => entry.id === session.businessId)
            if (savedBusiness?.staff.some((entry) => entry.id === session.staffId)) {
              setActiveStaff({ id: session.staffId, name: session.name })
            }
          } catch {
            localStorage.removeItem('pos-active-staff')
          }
        }

        const savedOwner = localStorage.getItem('pos-owner-account')
        let restoredSession: OwnerSession | null = null
        if (savedOwner) {
          try {
            restoredSession = JSON.parse(savedOwner) as OwnerSession
            setOwner(restoredSession)
          } catch {
            localStorage.removeItem('pos-owner-account')
          }
        }

        if (backendEnabled) {
          const token = await getValidAccessToken()
          if (token) {
            // Section 7: on a fresh device (no local businesses), pull the
            // owner's businesses from the backend before choosing one.
            if (loadedState.businesses.length === 0) {
              const remote = await fetchMyBusinesses()
              if (!cancelled && Array.isArray(remote)) {
                for (const remoteBiz of remote) {
                  const exists = loadedState.businesses.some((entry) => entry.id === remoteBiz.id)
                  if (!exists) {
                    loadedState.businesses.push({
                      id: remoteBiz.id,
                      name: remoteBiz.name,
                      type: (remoteBiz.type as BusinessType) ?? 'shop',
                      mpesaShortCode: remoteBiz.shortCode,
                      ownerEmail: restoredSession?.email,
                      products: [],
                      customers: [],
                      staff: [],
                      sales: [],
                      stockAdjustments: [],
                      auditTrail: [],
                      branches: [],
                      startingCapital: 0,
                      capitalInjections: [],
                      expenses: [],
                      refunds: [],
                    })
                    await saveBusinessRecords(loadedState.businesses[loadedState.businesses.length - 1])
                  }
                }
              }
            }

            const status = await getMpesaStatus(loadedState.businesses[0]?.id ?? '')
            if (!cancelled) setMpesaStatus(status)
          }
        }
      } catch {
        setStatusMessage('Could not open local storage. Check browser settings')
      } finally {
        if (!cancelled) setLoaded(true)
      }
    }

    void boot()
    return () => {
      cancelled = true
    }
  }, [])

  // --- Cart crash recovery ------------------------------------------------

  useEffect(() => {
    if (!loaded) return
    if (cart.length === 0) {
      void clearCartDraft()
      return
    }
    void saveCartDraft({
      cart,
      payments: paymentDraft,
      customerId: selectedCustomerId || undefined,
      savedAt: new Date().toISOString(),
    })
  }, [cart, paymentDraft, selectedCustomerId, loaded])

  // --- Owner idle timeout -------------------------------------------------

  const ownerIdleTimer = useRef<number | undefined>(undefined)

  const resetOwnerIdleTimer = () => {
    window.clearTimeout(ownerIdleTimer.current)
    if (!owner) return
    ownerIdleTimer.current = window.setTimeout(() => {
      setOwner(null)
      localStorage.removeItem('pos-owner-account')
      setStatusMessage('Owner session locked after 10 minutes idle. Sign in again')
    }, OWNER_IDLE_MS)
  }

  useEffect(() => {
    if (!owner) return
    resetOwnerIdleTimer()
    const events: Array<keyof DocumentEventMap> = ['pointerdown', 'keydown']
    events.forEach((event) => document.addEventListener(event, resetOwnerIdleTimer))
    return () => {
      window.clearTimeout(ownerIdleTimer.current)
      events.forEach((event) => document.removeEventListener(event, resetOwnerIdleTimer))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner?.loggedInAt, owner])

  // --- Connectivity + background sync ------------------------------------

  useEffect(() => {
    const handleOnline = () => setOnline(true)
    const handleOffline = () => {
      setOnline(false)
      setSyncing(false)
    }

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  useEffect(() => {
    if (!loaded) return

    const runSyncCycle = async () => {
      if (!navigator.onLine) return
      const pending = pendingSyncCount(stateRef.current)
      if (pending === 0) return

      setSyncing(true)
      try {
        const result = await runSync(stateRef.current, syncAdapter, {
          maxAttempts: 3,
          baseDelayMs: 500,
        })
        await pruneSyncedQueueItems(stateRef.current)
        if (result.conflicts > 0) {
          setStatusMessage(`${result.conflicts} sync conflict${result.conflicts > 1 ? 's' : ''} need your review below`)
        } else if (result.pushed > 0) {
          setStatusMessage(`Backed up ${result.pushed} offline change${result.pushed > 1 ? 's' : ''} to the cloud`)
        }
      } finally {
        setSyncing(false)
        forceRender()
      }
    }

    const handleOnlineSync = () => {
      setOnline(true)
      void runSyncCycle()
    }

    window.addEventListener('online', handleOnlineSync)
    const timer = window.setInterval(() => {
      if (navigator.onLine) void runSyncCycle()
    }, 60_000)
    void runSyncCycle()

    return () => {
      window.removeEventListener('online', handleOnlineSync)
      window.clearInterval(timer)
    }
  }, [loaded])

  // --- M-Pesa STK polling -------------------------------------------------

  // Latest finalizeSale via ref so polling isn't restarted on every render.
  const finalizeRef = useRef<(mpesaStatus?: Sale['mpesaStatus'], receipt?: string) => Promise<void>>(
    async () => {},
  )

  // Idempotence guard: a prompt confirmed while the attendant is in the
  // manual-code box must not ALSO finalize when they then type the code.
  const finalizedCheckoutIdsRef = useRef<Set<string>>(new Set())

  /**    * Auto-completion (the supermarket behaviour). After a prompt is sent, a
   * background listener polls Daraja for the result. Confirmed payments
   * finalize the sale by themselves (receipt stamped, cart cleared, stock
   * deducted) with no attendant action at all. The manual-code box is only a
   * fallback UI; it never disables the listener, so a customer who pays late
   * (e.g. they cancelled the first prompt, took a second one and confirmed
   * after the 60s window) still auto-completes the sale when Safaricom
   * reports the receipt.
   */
  const listeningCheckoutId =
    mpesa.stage === 'waiting' || mpesa.stage === 'manual-entry'
      ? (mpesa.stage === 'waiting' ? mpesa.checkoutRequestId : lastCheckoutRequestIdRef.current)
      : null

  useEffect(() => {
    if (!listeningCheckoutId) return
    if (!mpesaClient) return
    if (finalizedCheckoutIdsRef.current.has(listeningCheckoutId)) return

    let tries = 0
    const maxTries = 30 // 30 × 3s ≈ 90s of late-payment capture
    let timer: number | undefined
    let cancelled = false

    const poll = async () => {
      if (cancelled) return
      tries += 1
      const status: StkStatus = await mpesaClient.stkStatus(listeningCheckoutId)

      if (status.status === 'confirmed' && status.receipt) {
        // Re-check per poll: the attendant may have typed the code manually
        // while this very poll was in flight (mark first, finalize second,
        // so a racing path can never double-record the sale).
        if (finalizedCheckoutIdsRef.current.has(listeningCheckoutId)) return
        finalizedCheckoutIdsRef.current.add(listeningCheckoutId)
        await finalizeRef.current('confirmed', status.receipt)
        return
      }
      if (status.status === 'failed') {
        setMpesa((current) => {
          // A pending prompt has its own UI; only drop into manual entry
          // from a waiting stage. While listening after manual entry, stay
          // quiet, the attendant already has the box open.
          if (current.stage === 'waiting') {
            return {
              stage: 'manual-entry',
              note: 'M-Pesa said the payment did not go through. Enter the code if the customer paid, or cancel.',
            }
          }
          return current
        })
        return
      }
      if (tries >= maxTries) {
        setMpesa((current) => {
          if (current.stage === 'waiting') {
            return {
              stage: 'manual-entry',
              note: 'No confirmation within 90 seconds. If the customer completed the payment, the sale will still complete automatically, or enter the code manually.',
            }
          }
          return current
        })
        return
      }
      timer = window.setTimeout(() => void poll(), 3000)
    }

    void poll()
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [listeningCheckoutId])

  // Ticking clock for the waiting-stage countdown.
  useEffect(() => {
    if (mpesa.stage !== 'waiting') return
    const timer = window.setInterval(() => setNowTick((tick) => tick + 1), 1000)
    return () => window.clearInterval(timer)
  }, [mpesa.stage])

  // Gentle refresh for the owner's live sales feed: picks up sales that other
  // devices synced in since the last render. Pure re-render, no fetching.
  useEffect(() => {
    if (!isOwnerHere) return
    const timer = window.setInterval(() => forceRender(), 15_000)
    return () => window.clearInterval(timer)
  }, [isOwnerHere])

  // Picking a saved customer pre-fills their number for the prompt; going
  // back to walk-in (or a customer with no saved number) clears it.
  useEffect(() => {
    const currentBusiness = stateRef.current.businesses.find(
      (entry) => entry.id === selectedBusinessId,
    )
    const customer = currentBusiness?.customers.find((entry) => entry.id === selectedCustomerId)
    setStkPhone(customer?.phone ?? '')
  }, [selectedCustomerId, selectedBusinessId])

  // --- Derived values ------------------------------------------------------

  // The waiting-stage countdown reads Date.now(); nowTick forces a re-render
  // once per second so the seconds-remaining figure stays live.
  void nowTick
  const cartTotal = cart.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0)

  // --- Owner finance dashboard (owner-only; pure local computation) --------

  const [financePeriod, setFinancePeriod] = useState<FinancePeriod>('month')
  /** Branch switcher selection: undefined = main/only branch (default view). */
  const [selectedBranchId, setSelectedBranchId] = useState<string | undefined>(undefined)

  // The device remembers which branch it physically sits at, so staff logins
  // and the Sell screen stay scoped across reloads.
  useEffect(() => {
    if (!business) return
    const saved = window.localStorage.getItem(`pos-branch:${business.id}`)
    if (saved !== null) setSelectedBranchId(saved === '' ? undefined : saved)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business?.id])
  const changeBranch = (branchId: string) => {
    const next = branchId === '' ? undefined : branchId
    setSelectedBranchId(next)
    if (business) window.localStorage.setItem(`pos-branch:${business.id}`, branchId)
  }
  // --- Navigation: one screen at a time, reached via the hamburger menu. ---
  // Attendants only ever see 'sell'; owner screens live behind isOwnerHere.
  const [activeScreen, setActiveScreen] = useState<OwnerScreen | 'sell'>('sell')

  // A locked owner session must never strand the UI on an owner-only screen.
  useEffect(() => {
    if (activeScreen !== 'sell' && !isOwnerHere) setActiveScreen('sell')
  }, [activeScreen, isOwnerHere])
  const [menuOpen, setMenuOpen] = useState(false)
  const [customRange, setCustomRange] = useState({ start: '', end: '' })
  const [expenseForm, setExpenseForm] = useState({
    category: 'rent' as ExpenseCategory,
    amount: '',
    note: '',
    date: todayKey(),
  })
  const [capitalForm, setCapitalForm] = useState({ starting: '', injection: '', note: '' })
  const [sellerView, setSellerView] = useState<'quantity' | 'revenue' | 'profit'>('quantity')
  const [refundReasons, setRefundReasons] = useState<Record<string, string>>({})
  const [expenseFilter, setExpenseFilter] = useState<{ category: ExpenseCategory | 'all' }>({
    category: 'all',
  })

  // Recomputed per render, like dailySummary: shop-scale data with records
  // mutated in place, so memo caches would go stale between refreshes.
  const financeRange = financeRangeFor(
    financePeriod,
    financePeriod === 'custom' && customRange.start && customRange.end ? customRange : undefined,
  )

  // --- Multi-branch ----------------------------------------------------------
  // Only used when the business actually has branches; single-location shops
  // keep the plain business object everywhere.
  const hasBranches = (business?.branches.length ?? 0) > 1
  const activeBranch = business ? branchByIdOr(business, selectedBranchId) : null
  const multiBranchScope = useMemo(() => {
    if (!business || !hasBranches) return null
    if (selectedBranchId === '__all__') return business
    return branchScope(business, selectedBranchId)
  }, [business, hasBranches, selectedBranchId])
  /** The object all dashboard/seller/trend computations read from. */
  const financeView = multiBranchScope ?? business

  const trendPoints = useMemo(
    () => (financeView && financePeriod !== 'today' ? revenueByDayForRange(financeView, financeRange) : []),
    // Recomputed whenever the underlying render data changes; the business
    // object is mutated in place, so identity never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [business?.id, financePeriod, customRange.start, customRange.end, state.syncQueue.length, selectedBranchId],
  )
  const visibleExpenses = financeView ? filteredExpenses(financeView, { category: expenseFilter.category }) : []
  const financeReport = financeView ? financeReportForRange(financeView, financeRange) : null
  const financePerformance = financeView ? productPerformanceForRange(financeView, financeRange) : []
  const soldProducts = financePerformance.filter((entry) => entry.quantitySold > 0)
  const topSellers = [...soldProducts]
    .sort((a, b) =>
      sellerView === 'quantity'
        ? b.quantitySold - a.quantitySold
        : sellerView === 'revenue'
          ? b.revenue - a.revenue
          : b.grossProfit - a.grossProfit,
    )
    .slice(0, 5)
  const slowMovers = [...financePerformance]
    .sort((a, b) => a.quantitySold - b.quantitySold || b.revenue - a.revenue)
    .slice(0, 5)

  const submitStartingCapital = () => {
    if (!business || !isOwnerHere) return
    const amount = Number(capitalForm.starting)
    if (!Number.isFinite(amount) || amount < 0) {
      setStatusMessage('Enter the starting capital amount (zero or more)')
      return
    }
    try {
      setStartingCapital(state, business, amount)
      setStatusMessage('Starting capital saved. It is the baseline for your investment total')
      setCapitalForm((current) => ({ ...current, starting: '' }))
      refresh()
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'Could not save capital')
    }
  }

  const submitCapitalInjection = () => {
    if (!business || !isOwnerHere) return
    const amount = Number(capitalForm.injection)
    if (!Number.isFinite(amount) || amount <= 0) {
      setStatusMessage('Enter how much capital you are adding')
      return
    }
    try {
      addCapitalInjection(state, business, { amount, note: capitalForm.note })
      setStatusMessage('Capital injection recorded')
      setCapitalForm((current) => ({ ...current, injection: '', note: '' }))
      refresh()
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'Could not record the injection')
    }
  }

  const submitExpense = () => {
    if (!business || !isOwnerHere) return
    const amount = Number(expenseForm.amount)
    if (!Number.isFinite(amount) || amount <= 0) {
      setStatusMessage('Enter the expense amount')
      return
    }
    try {
      addExpense(state, business, {
        category: expenseForm.category,
        amount,
        note: expenseForm.note,
        date: expenseForm.date || undefined,
      })
      setStatusMessage('Expense logged. It reduces net profit, never gross profit')
      setExpenseForm((current) => ({ ...current, amount: '', note: '' }))
      refresh()
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'Could not log the expense')
    }
  }

  const submitRefund = (saleId: string) => {
    if (!business || !isOwnerHere) return
    try {
      const refund = refundSale(state, business, saleId, refundReasons[saleId])
      setStatusMessage(`Refund of KES ${refund.amount} recorded and stock returned`)
      setRefundReasons((current) => ({ ...current, [saleId]: '' }))
      refresh()
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'Could not refund the sale')
    }
  }
  const paymentTotal = paymentDraft.cash + paymentDraft.mpesa + paymentDraft.credit
  const balanceDue = Math.max(0, cartTotal - paymentTotal)
  const pendingSync = pendingSyncCount(state)
  const conflicts = state.syncQueue.filter((item) => item.status === 'conflict')

  // --- M-Pesa prompt: the phone the STK push will go to ---------------------
  // Typed number wins; otherwise the selected customer's saved number.
  const resolvedMpesaPhone =
    stkPhone.trim() || business?.customers.find((entry) => entry.id === selectedCustomerId)?.phone || ''
  const mpesaPhoneInvalid = resolvedMpesaPhone !== '' && normalizeKenyanPhone(resolvedMpesaPhone) === null
  const mpesaElapsed = mpesa.stage === 'waiting' ? Math.floor((Date.now() - mpesa.startedAt) / 1000) : 0

  // The switcher only ever lists businesses this session may see. The backend
  // (RLS) independently enforces the same rule for every query.
  const visibleBusinesses = businessesVisibleTo(state.businesses, owner
    ? { ownerEmail: owner.email }
    : activeStaff
      ? { staffId: activeStaff.id }
      : null)

  // Recomputed each render: cheap at shop scale, and mutation-based updates
  // (sales push into the same business object) would defeat a memo cache.
  const dailySummary = business ? summarizeSalesForDay(business, todayKey()) : null

  // Live sales feed for the owner (every device computes from the same local
  // store, so it reflects both this device and anything synced in).
  const liveSales = business && isOwnerHere ? recentSalesForFeed(business, 6) : []

  const filteredProducts = useMemo(() => {
    if (!business) return []
    const query = search.trim().toLowerCase()
    return business.products.filter((entry) => entry.name.toLowerCase().includes(query))
  }, [business, search])

  const lowStockProducts = useMemo(() => {
    if (!business) return []
    return business.products.filter(
      (entry) => stockForBranch(business, entry, selectedBranchId) <= entry.lowStockAlert,
    )
  }, [business, selectedBranchId])

  const categorySuggestions = useMemo(
    () => (business ? defaultCategoriesFor(business.type) : []),
    [business],
  )

  // --- Login gate ----------------------------------------------------------

  // Owner PIN gate only applies when NO owner session exists. A signed-in
  // owner with zero businesses is routed to the create-business form below.
  const needsPinLogin = Boolean(business && business.staff.length > 0 && !activeStaff && !isOwnerHere && !owner)

  const attemptPinLogin = () => {
    if (!business || !pendingStaffId) {
      setPinError('Tap your name first, then enter your PIN')
      return
    }
    // Branch-scoped PIN check: a PIN only opens the till of its own branch.
    const staff = verifyStaffPinForBranch(business, pendingStaffId, pinInput, selectedBranchId)
    if (!staff) {
      const known = verifyStaffPin(business, pendingStaffId, pinInput)
      setPinError(known ? 'This PIN is for another branch of this business' : 'Wrong PIN. Try again')
      setPinInput('')
      return
    }
    setActiveStaff({ id: staff.id, name: staff.name })
    localStorage.setItem(
      'pos-active-staff',
      JSON.stringify({ businessId: business.id, staffId: staff.id, name: staff.name }),
    )
    setPinInput('')
    setPinError('')
    setStatusMessage(`Serving as ${staff.name} (${staff.shift} shift)`)

    // Section 6: walkthrough shows on a staff member's FIRST login only.
    if (!staff.walkthroughCompletedAt) {
      setWalkthroughStep(1)
    }
  }

  // --- Section 3: owner signup / login (works offline via demo accounts, --
  // with the backend as the real credential store when configured) ---------

  const attemptOwnerLogin = async () => {
    setOwnerLoginError('')
    const email = ownerEmailInput.trim()
    const password = ownerPasswordInput
    if (!email || !password) {
      setOwnerLoginError('Enter your email and password')
      return
    }

    if (backendEnabled) {
      const result = await signInOwner(email, password)
      if (!result.ok) {
        setOwnerLoginError(result.error ?? 'Sign-in failed')
        return
      }
    } else {
      const verified = verifyOwnerCredentials(state, email, password)
      if (!verified) {
        setOwnerLoginError('Wrong email or password')
        setOwnerPasswordInput('')
        return
      }
      if (!verified.emailVerified) {
        setVerificationPending(verified.id)
        setSignupStep('verify')
        setOwnerLoginError('')
        setStatusMessage('Verify your email first. Enter the code we sent (demo code: 123456)')
        return
      }
    }

    const session: OwnerSession = { email: email.toLowerCase(), loggedInAt: Date.now() }
    setOwner(session)
    localStorage.setItem('pos-owner-account', JSON.stringify(session))
    setOwnerEmailInput('')
    setOwnerPasswordInput('')
    setStatusMessage(`Welcome back${email}`)

    // Section 6: walkthrough is tracked per owner account. Section 3: an
    // account with zero businesses goes to "create your first business".
    const ownerRecord = findOwnerByIdentifierSafe(state, email)
    if (ownerRecord && !ownerRecord.walkthroughCompletedAt) {
      setWalkthroughStep(1)
    }
    if (ownerBusinesses(state, { email: email.toLowerCase() }).length === 0) {
      setSignupStep('business')
    }
  }

  const attemptOwnerSignup = async () => {
    setAuthError('')
    const email = ownerEmailInput.trim()
    const password = ownerPasswordInput

    if (!signupFullName.trim()) {
      setAuthError('Enter your full name')
      return
    }
    if (password.length < 8) {
      setAuthError('Password needs at least 8 characters')
      return
    }
    if (password !== signupConfirm) {
      setAuthError('Passwords do not match')
      return
    }

    if (backendEnabled) {
      const result = await signUpOwner(email, password)
      if (!result.ok) {
        setAuthError(result.error ?? 'Sign-up failed')
        return
      }
      setStatusMessage(`Account created for ${email}. Check your email for the verification link, then sign in`)
      setAuthMode('signin')
      setOwnerPasswordInput('')
      setSignupConfirm('')
      return
    }

    const created = createOwner(state, {
      fullName: signupFullName,
      email,
      password,
      phoneNumber: signupPhone || undefined,
    })
    if (!created.ok) {
      setAuthError(created.error)
      return
    }
    void saveOwners(state.owners)
    // Demo "email": the code is deterministic (123456) and shown in the UI.
    setVerificationPending(created.owner.id)
    setSignupStep('verify')
    setStatusMessage('Account created. Check your email for the verification code (demo code: 123456)')
    setOwnerPasswordInput('')
    setSignupConfirm('')
    refresh()
  }

  const confirmVerification = () => {
    setVerificationError('')
    if (!verificationPending) return
    if (!markOwnerVerified(state, verificationPending, verificationCodeInput.trim())) {
      setVerificationError('That code is not right. Check your email')
      return
    }
    const ownerRecord = state.owners.find((entry) => entry.id === verificationPending)
    setVerificationPending(null)
    setVerificationCodeInput('')
    void saveOwners(state.owners)
    refresh()
    if (ownerRecord) {
      setStatusMessage(`Email verified. Welcome, ${ownerRecord.fullName}`)
      // Verification IS the login proof in demo mode, so start the owner
      // session here instead of forcing the new owner to retype credentials.
      const session: OwnerSession = { email: ownerRecord.email, loggedInAt: Date.now() }
      setOwner(session)
      localStorage.setItem('pos-owner-account', JSON.stringify(session))
      // Verified account with zero businesses → straight to first-business setup.
      setSignupStep('business')
      setOwnerEmailInput(ownerRecord.email)
    }
  }

  /** Section 6 helper: walkthrough lookup tolerates missing owner records. */
  function findOwnerByIdentifierSafe(appState: AppState, email: string) {
    return appState.owners.find((entry) => entry.email.toLowerCase() === email.toLowerCase()) ?? null
  }

  const switchAttendant = () => {
    setActiveStaff(null)
    setPendingStaffId('')
    localStorage.removeItem('pos-active-staff')
  }

  const ownerLogout = async () => {
    setOwner(null)
    setWalkthroughStep(null)
    localStorage.removeItem('pos-owner-account')
    if (backendEnabled) {
      await signOutOwner()
    }
    setStatusMessage('Owner session closed')
  }

  // --- Section 2: choosing a business resets the staff session. PINs are
  // scoped to ONE business, so a staff login never carries across. ----------

  const chooseBusiness = (businessId: string) => {
    setSelectedBusinessId(businessId)
    setActiveStaff(null)
    setPendingStaffId('')
    localStorage.removeItem('pos-active-staff')
    setBusinessChooserOpen(false)
    setWalkthroughStep(null)
    setStatusMessage('')
  }

  // --- Section 7: restore. Pull the full dataset from the backend onto a
  // fresh device (lost/stolen phone scenario). -------------------------------

  const restoreBusiness = async (businessId: string) => {
    setRestoring(true)
    try {
      const payload = await restoreBusinessData(businessId)
      if ('error' in payload) {
        setStatusMessage(payload.error)
        return
      }
      const biz = payload.business
      const existing = stateRef.current.businesses.find((entry) => entry.id === biz.id)
      if (existing) {
        existing.name = biz.name
        existing.type = (biz.type as BusinessType) ?? existing.type
        existing.products = payload.products as Product[]
        existing.customers = payload.customers as Customer[]
        existing.staff = payload.staff as Staff[]
        existing.sales = payload.sales as Sale[]
        existing.stockAdjustments = payload.stockAdjustments as StockAdjustment[]
        existing.auditTrail = payload.auditTrail as AuditEntry[]
        existing.startingCapital = biz.startingCapital ?? existing.startingCapital
        existing.capitalInjections = (payload.capitalInjections ?? []) as CapitalInjection[]
        existing.expenses = (payload.expenses ?? []) as Expense[]
        existing.refunds = (payload.refunds ?? []) as Refund[]
        normalizeFinanceLedgers(existing)
      } else {
        stateRef.current.businesses.push({
          id: biz.id,
          name: biz.name,
          type: (biz.type as BusinessType) ?? 'shop',
          mpesaShortCode: biz.mpesaShortCode,
          kraPin: biz.kraPin,
          etimsBhfId: biz.etimsBhfId,
          etimsDeviceSerial: biz.etimsDeviceSerial,
          vatRate: biz.vatRate,
          ownerEmail: owner?.email,
          products: payload.products as Product[],
          customers: payload.customers as Customer[],
          staff: payload.staff as Staff[],
          sales: payload.sales as Sale[],
          stockAdjustments: payload.stockAdjustments as StockAdjustment[],
          auditTrail: payload.auditTrail as AuditEntry[],
          branches: [],
          startingCapital: biz.startingCapital ?? 0,
          capitalInjections: (payload.capitalInjections ?? []) as CapitalInjection[],
          expenses: (payload.expenses ?? []) as Expense[],
          refunds: (payload.refunds ?? []) as Refund[],
        })
        normalizeFinanceLedgers(stateRef.current.businesses[stateRef.current.businesses.length - 1])
      }
      await saveBusinessRecords(stateRef.current.businesses.find((entry) => entry.id === biz.id)!)
      await markRestoredFromBackend(biz.id)
      setSelectedBusinessId(biz.id)
      setBusinessChooserOpen(false)
      setStatusMessage('All your records were restored from the cloud. Check they look right, then keep selling')
      refresh()
    } finally {
      setRestoring(false)
    }
  }

  // --- Section 6: walkthrough completion, tracked per account ---------------

  const finishWalkthrough = (finalStep: number) => {
    const nowIso = new Date().toISOString()
    if (activeStaff && business) {
      const staff = business.staff.find((entry) => entry.id === activeStaff.id)
      if (staff && !staff.walkthroughCompletedAt) {
        staff.walkthroughCompletedAt = nowIso
        refresh()
      }
    } else if (owner) {
      const ownerRecord = findOwnerByIdentifierSafe(stateRef.current, owner.email)
      if (ownerRecord && !ownerRecord.walkthroughCompletedAt) {
        ownerRecord.walkthroughCompletedAt = nowIso
        void saveOwners(stateRef.current.owners)
        refresh()
      }
    }
    setWalkthroughStep(null)
    if (finalStep > 0) setStatusMessage('You are ready. The sale screen is always one tap away')
  }

  // --- Business / setup actions -------------------------------------------

  const createBusiness = async () => {
    if (!owner) {
      setOwnerLoginError('Only the signed-in owner can create a business')
      return
    }
    if (!signupForm.name.trim()) {
      setOwnerLoginError('Give the business a name first')
      return
    }
    setOwnerLoginError('')

    // With a backend, the server creates the row and links it to the owner's
    // account; offline, the queued business-created action does it on sync.
    let serverBusinessId: string | undefined
    if (backendEnabled && navigator.onLine) {
      const result = await createBusinessOnServer(
        signupForm.name.trim(),
        signupForm.type,
        signupForm.shortCode || undefined,
      )
      if (result.ok) serverBusinessId = result.businessId
    }

    const created = addBusiness(state, {
      id: serverBusinessId,
      name: signupForm.name.trim(),
      type: signupForm.type,
      mpesaShortCode: signupForm.shortCode || undefined,
    })

    // Permanently link the new business to this owner.
    created.ownerEmail = owner.email

    setSelectedBusinessId(created.id)
    setStatusMessage(`${created.name} is ready. Add your items to start selling`)
    setSignupForm({ name: '', type: 'shop', shortCode: '' })
    setBusinessChooserOpen(false)
    refresh()
  }

  /**
   * Section 3: creates the FIRST business for an already-created (and in
   * demo mode verified) owner account. The account always exists first with
   * zero businesses; this only links the business to the signed-in owner.
   */
  const createFirstBusiness = async () => {
    const name = signupForm.name.trim()

    if (!owner) {
      setOwnerLoginError('Create or sign in to your owner account first')
      setSignupStep('account')
      return
    }
    if (!name) {
      setOwnerLoginError('Give the business a name first')
      return
    }
    setOwnerLoginError('')

    let serverBusinessId: string | undefined
    if (backendEnabled && navigator.onLine) {
      const created = await createBusinessOnServer(name, signupForm.type, signupForm.shortCode || undefined)
      if (created.ok) serverBusinessId = created.businessId
    }

    const businessState = stateRef.current
    const createdBusiness = addBusiness(businessState, {
      id: serverBusinessId,
      name,
      type: signupForm.type,
      mpesaShortCode: signupForm.shortCode || undefined,
    })
    // Permanently link the business to this owner's account.
    createdBusiness.ownerEmail = owner.email

    setSelectedBusinessId(createdBusiness.id)
    setSignupStep('account')
    setStatusMessage(`${name} is ready. Add your items to start selling`)
    setSignupForm({ name: '', type: 'shop', shortCode: '' })
    setOwnerEmailInput('')
    setOwnerLoginError('')
    refresh()
  }

  const addStaffMember = () => {
    if (!business) return
    if (!isOwnerHere) {
      setStatusMessage('Only the owner can add staff')
      return
    }
    if (!staffForm.name.trim() || staffForm.pin.trim().length < 4) {
      setStatusMessage('Staff need a name and a PIN of 4+ digits')
      return
    }
    const staff = recordStaff(business, {
      name: staffForm.name.trim(),
      pin: staffForm.pin.trim(),
      shift: staffForm.shift,
    })
    enqueueSyncAction(state, business.id, 'staff-added', { staffId: staff.id, name: staff.name })
    setStatusMessage(`${staff.name} can now sign in with their PIN`)
    setStaffForm({ name: '', pin: '', shift: 'Morning' })
    refresh()
  }

  const deleteStaffMember = (staffId: string) => {
    if (!business || !isOwnerHere) return
    const staff = business.staff.find((entry) => entry.id === staffId)
    if (!staff) return
    if (!window.confirm(`Remove ${staff.name}? They will no longer be able to sign in with their PIN.`)) return

    removeStaff(business, staffId)
    appendAuditEntry(state, business, {
      actor: {
        name: owner?.fullName ?? owner?.email ?? 'Owner',
        role: 'owner',
      },
      action: 'staff-removed',
      productName: staff.name,
      detail: `PIN login removed for ${staff.name} (${staff.shift})`,
    })
    enqueueSyncAction(state, business.id, 'staff-removed', { staffId, name: staff.name })

    // If that person is signed in on this device, sign them out now.
    if (activeStaff?.id === staffId) {
      setActiveStaff(null)
      localStorage.removeItem('pos-active-staff')
      setActiveScreen('sell')
    }

    setStatusMessage(`${staff.name} removed. Their past sales stay in your records.`)
    refresh()
  }

  // --- Owner: M-Pesa credential management (secrets never stored locally) --

  const submitMpesaCredentials = async () => {
    if (!business || !isOwnerHere) return
    if (!mpesaForm.shortCode.trim() || !mpesaForm.consumerKey.trim() || !mpesaForm.consumerSecret.trim()) {
      setMpesaFormError('All three fields are required')
      return
    }

    const result = await setupMpesaCredentials(business.id, {
      shortCode: mpesaForm.shortCode.trim(),
      consumerKey: mpesaForm.consumerKey.trim(),
      consumerSecret: mpesaForm.consumerSecret,
    })

    if (!result.ok) {
      setMpesaFormError(result.error ?? 'Could not save credentials')
      return
    }

    // Scrub immediately: the secret must not linger in React state.
    setMpesaForm({ shortCode: '', consumerKey: '', consumerSecret: '' })
    setMpesaFormError('')
    setMpesaFormOpen(false)
    const status = await getMpesaStatus(business.id)
    setMpesaStatus(status)
    setStatusMessage('M-Pesa credentials saved securely on the server')
  }

  const openMpesaForm = async () => {
    if (!business) return
    setMpesaForm({ shortCode: business.mpesaShortCode ?? '', consumerKey: '', consumerSecret: '' })
    setMpesaFormError('')
    setMpesaFormOpen(true)
    if (backendEnabled) {
      setMpesaStatus(await getMpesaStatus(business.id))
    }
  }

  // --- Section 5: price change with audit attribution -----------------------

  const applyPriceChange = () => {
    if (!business) return
    if (!priceForm.productId) {
      setStatusMessage('Choose the item whose price changed')
      return
    }
    const newPrice = Number(priceForm.newPrice)
    try {
      updateProductPrice(state, business, priceForm.productId, newPrice, {
        id: activeStaff?.id,
        name: activeStaff?.name ?? (isOwnerHere ? owner?.email ?? 'Owner' : 'Unknown'),
        role: activeStaff ? 'staff' : isOwnerHere ? 'owner' : 'unknown',
        })
      const product = business.products.find((entry) => entry.id === priceForm.productId)
      setStatusMessage(`Price updated to KES ${newPrice} for ${product?.name ?? 'item'}`)
      setPriceForm({ productId: '', newPrice: '' })
      refresh()
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'Could not change the price')
    }
  }

  // --- Section 4: eTIMS setup (identifiers only); the cmcKey stays server-side

  const submitEtimsSetup = async () => {
    if (!business || !isOwnerHere) return
    const kraPin = etimsForm.kraPin.trim().toUpperCase()
    if (!/^[AP]\d{9}[A-Z]$/.test(kraPin)) {
      setStatusMessage('KRA PIN looks wrong. Format like A012345678Z')
      return
    }

    // Save identifiers locally (non-secret) + queue for the server, which
    // then performs device init with KRA to obtain the cmcKey securely.
    business.kraPin = kraPin
    business.etimsBhfId = etimsForm.bhfId.trim() || '00'
    business.etimsDeviceSerial = etimsForm.deviceSerial.trim() || undefined
    enqueueSyncAction(state, business.id, 'business-updated', {
      kraPin: business.kraPin,
      etimsBhfId: business.etimsBhfId,
      etimsDeviceSerial: business.etimsDeviceSerial,
    })
    setEtimsFormOpen(false)
    setStatusMessage(
      'eTIMS details saved. Invoicing will queue automatically with each sale.' +
        (backendEnabled ? '' : ' (Works fully once the backend is connected.)'),
    )
    refresh()
  }

  // --- Section 2: chooser totals (today's sales per business) ---------------

  useEffect(() => {
    if (!businessChooserOpen) return
    const totals: Record<string, number> = {}
    for (const entry of visibleBusinesses) {
      totals[entry.id] = summarizeSalesForDay(entry, todayKey()).totalSales
    }
    setChooserTotals(totals)
  }, [businessChooserOpen, visibleBusinesses])

  // --- Inventory actions ---------------------------------------------------

  const addProductFromForm = () => {
    if (!business) return
    if (!productForm.name.trim()) {
      setStatusMessage('What is the item called?')
      return
    }
    const price = Number(productForm.price)
    if (!Number.isFinite(price) || price <= 0) {
      setStatusMessage('Enter a selling price above zero')
      return
    }

    const product = addProduct(business, {
      name: productForm.name.trim(),
      category: productForm.category.trim() || 'General',
      price,
      costPrice: Number(productForm.costPrice) || 0,
      stockQuantity: Number(productForm.stockQuantity) || 0,
      unitOfMeasure: productForm.unitOfMeasure,
      barcode: productForm.barcode.trim() || undefined,
      expiryDate: productForm.expiryDate || undefined,
      batchNumber: productForm.batchNumber.trim() || undefined,
      restrictedItem: productForm.restrictedItem || undefined,
      lowStockAlert: Number(productForm.lowStockAlert) || 0,
    })

    enqueueSyncAction(state, business.id, 'product-added', { productId: product.id, name: product.name })
    setStatusMessage(`${product.name} added to your items`)
    setProductForm({
      name: '',
      category: 'General',
      price: '',
      costPrice: '',
      stockQuantity: '',
      unitOfMeasure: 'piece',
      barcode: '',
      expiryDate: '',
      batchNumber: '',
      restrictedItem: false,
      lowStockAlert: '3',
    })
    refresh()
  }

  const importBulkProducts = () => {
    if (!business) return
    const { rows, errors } = parseBulkProductCsv(bulkText)
    setBulkErrors(errors)

    if (rows.length === 0) {
      setStatusMessage('Nothing to import. Paste rows like: Name, Category, Price, Stock')
      return
    }

    rows.forEach((row) => addProduct(business, row))
    enqueueSyncAction(state, business.id, 'product-bulk-added', {
      count: rows.length,
      names: rows.map((row) => row.name),
    })
    setStatusMessage(`Imported ${rows.length} items${errors.length > 0 ? `, ${errors.length} line(s) had problems` : ''}`)
    setBulkText('')
    refresh()
  }

  // --- Customer actions ----------------------------------------------------

  const addCustomerFromForm = (inlineName?: string, inlinePhone?: string) => {
    if (!business) return
    const name = inlineName ?? customerForm.name
    const phone = inlinePhone ?? customerForm.phone
    if (!name.trim()) {
      setStatusMessage('Customer needs a name')
      return
    }
    const customer = {
      id: `cust-${crypto.randomUUID()}`,
      businessId: business.id,
      name: name.trim(),
      phone: phone.trim() || undefined,
      balance: 0,
    }
    business.customers.push(customer)
    enqueueSyncAction(state, business.id, 'customer-added', { customerId: customer.id, name: customer.name })
    setSelectedCustomerId(customer.id)
    if (inlineName === undefined) setCustomerForm({ name: '', phone: '' })
    setStatusMessage(`${customer.name} saved. Pick them at checkout for faster M-Pesa pushes`)
    refresh()
  }

  // --- Stock correction ----------------------------------------------------

  const recordCorrection = () => {
    if (!business) return
    const productId = stockForm.productId || business.products[0]?.id
    if (!productId) {
      setStatusMessage('Add an item before correcting stock')
      return
    }
    const delta = Number(stockForm.quantityDelta)
    if (!Number.isFinite(delta) || delta === 0) {
      setStatusMessage('Enter how many items to add (delivery) or remove (damage, theft…)')
      return
    }
    recordStockAdjustment(business, {
      productId,
      reason: stockForm.reason,
      quantityDelta: delta,
      actor: {
        id: activeStaff?.id,
        name: activeStaff?.name ?? (isOwnerHere ? owner?.email ?? 'Owner' : 'Unknown'),
        role: activeStaff ? 'staff' : isOwnerHere ? 'owner' : 'unknown',
      },
    })
    setStatusMessage('Stock corrected and saved')
    setStockForm({ productId: '', reason: 'count-correction', quantityDelta: '' })
    refresh()
  }

  // --- Cart ----------------------------------------------------------------

  const stockOf = (productId: string): number =>
    business?.products.find((entry) => entry.id === productId)?.stockQuantity ?? 0

  const addToCart = (product: Product) => {
    const inCart = cart.find((item) => item.productId === product.id)?.quantity ?? 0
    if (inCart + 1 > product.stockQuantity) {
      setStatusMessage(`Only ${product.stockQuantity} of ${product.name} left`)
      return
    }
    setCart((current) => {
      const existing = current.find((item) => item.productId === product.id)
      if (existing) {
        return current.map((item) =>
          item.productId === product.id ? { ...item, quantity: item.quantity + 1 } : item,
        )
      }
      return [...current, { productId: product.id, name: product.name, quantity: 1, unitPrice: product.price }]
    })
  }

  const changeQuantity = (productId: string, delta: number) => {
    setCart((current) =>
      current
        .map((item) => {
          if (item.productId !== productId) return item
          const next = item.quantity + delta
          if (delta > 0 && next > stockOf(productId)) {
            setStatusMessage(`Only ${stockOf(productId)} in stock`)
            return item
          }
          return { ...item, quantity: Math.max(0, next) }
        })
        .filter((item) => item.quantity > 0),
    )
  }

  // --- Barcode scanning -----------------------------------------------------

  /**
   * One barcode = one product. Unknown codes do NOT auto-add (a barcode is    * not a price). The attendant gets a one-tap path to create the product
   * with the code pre-filled, offline, syncing like any other addition.
   */
  const handleScannedBarcode = (rawCode: string, source: 'scanner' | 'camera') => {
    const currentBusiness = stateRef.current.businesses.find((entry) => entry.id === business?.id)
    if (!currentBusiness) return
    const code = rawCode.trim()
    if (!code) return

    const product = findProductByBarcode(currentBusiness.products, code)
    if (product) {
      addToCart(product)
      setScanNotFoundCode('')
      setScanHint(`Scanned: ${product.name} added to cart`)
      return
    }

    setScanHint(`No product found for barcode ${code}`)
    setScanNotFoundCode(code)
    setCameraScanTarget(source === 'camera' ? 'barcode' : 'name')
    setSearch('')
  }

  /** One-tap "add it?" from the not-found offer: opens the form pre-filled. */
  const startAddProductFromBarcode = () => {
    if (!scanNotFoundCode) return
    setProductForm((current) => ({
      ...current,
      name: cameraScanTarget === 'barcode' ? '' : `Barcode ${scanNotFoundCode}`,
      barcode: scanNotFoundCode,
    }))
    setScanNotFoundCode('')
    setScanHint(`New item ${scanNotFoundCode}. Fill in the details and save`)
    document.getElementById('product-form-name')?.focus()
  }

  const dismissScanNotFound = () => {
    setScanNotFoundCode('')
    setScanHint('Scanner ready, scan a barcode or tap items below')
  }

  // Global keyboard listener: hardware scanners arrive as a fast burst of
  // keystrokes ending in Enter. detectScanFromKeystrokes() separates that
  // signature from an attendant typing in the search box (too slow, or with
  // human-sized pauses). Runs even with no field focused, so a scan works
  // without clicking into the search box first.
  useEffect(() => {
    if (!loaded || !business) return

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const inTextField =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        target?.isContentEditable === true

      // Fast-typing guard: inside a text field, only single printable
      // characters and Enter reach the buffer; nothing the browser needs
      // (Tab, arrows, shortcuts) is swallowed. The classifier below still
      // rejects the burst unless it is scanner-fast with no human pauses.
      if (event.key.length === 1 || event.key === 'Enter') {
        scanBufferRef.current.push({ key: event.key, at: performance.now() })
      } else {
        scanBufferRef.current.length = 0
        return
      }

      if (scanBufferRef.current.length > 64) scanBufferRef.current.length = 64

      if (event.key === 'Enter') {
        const events = scanBufferRef.current
        scanBufferRef.current = []
        window.clearTimeout(scanTimerRef.current)

        const code = detectScanFromKeystrokes(events)
        if (code) {
          // Keep the page's own Enter behaviour (e.g. submitting a form the
          // attendant intentionally focused) while still processing the scan.
          if (!inTextField) event.preventDefault()
          setScanHint('Reading scan…')
          handleScannedBarcode(code, 'scanner')
          return
        }

        // Not scanner-like: if this was an intentional field entry, let the
        // browser/form handle Enter as normal.
        return
      }

      // Decay: a human's next keypress usually lands after the burst window.
      window.clearTimeout(scanTimerRef.current)
      scanTimerRef.current = window.setTimeout(() => {
        scanBufferRef.current = []
      }, 400)
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      window.clearTimeout(scanTimerRef.current)
    }
  }, [loaded, business?.id])

  // --- Checkout ------------------------------------------------------------

  const finalizeSale = async (mpesaStatusArg?: Sale['mpesaStatus'], receipt?: string) => {
    const currentBusiness = stateRef.current.businesses.find((entry) => entry.id === business?.id)
    if (!currentBusiness) return
    if (cart.length === 0) {
      setStatusMessage('The cart is empty')
      return
    }
    if (paymentTotal + 0.001 < cartTotal) {
      setStatusMessage(`KES ${Math.ceil(balanceDue)} still due before completing the sale`)
      return
    }

    // Clear the recovery draft first so a crash here can never resurrect a
    // sale that has already been completed.
    await clearCartDraft()

    try {
      // The sale (and its stock deduction) belongs to the selected branch.
      const sale = withBranchScope(selectedBranchId, () =>
        completeSale(currentBusiness, {
          items: cart.map((item) => ({
            productId: item.productId,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
          })),
          payments: { ...paymentDraft },
          customerId: selectedCustomerId || undefined,
          attendantId: activeStaff?.id,
          mpesaStatus: mpesaStatusArg,
        }),
      )
      if (receipt) {
        sale.mpesaReceipt = receipt
      }

      // Section 4: eTIMS fiscalisation: immediately when online, queued
      // otherwise (completeSale already queues it). Never blocks the sale.
      if (
        currentBusiness.kraPin &&
        currentBusiness.etimsDeviceSerial &&
        backendEnabled &&
        navigator.onLine
      ) {
        void signSaleWithEtims(currentBusiness.id, sale.id).then((result) => {
          if (result.ok) {
            sale.etims = result.etims as Sale['etims']
            refresh() // persist the invoice/control number onto the sale
          }
        })
      }

      setCart([])
      setPaymentDraft({ ...EMPTY_PAYMENTS })
      setSelectedCustomerId('')
      setStkPhone('')
      setMpesaManualCode('')
      setMpesa({ stage: 'idle' })
      setStatusMessage(
        `Sale of KES ${sale.total} completed and saved${receipt ? ` (M-Pesa ${receipt})` : ''}`,
      )
      refresh()
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'Could not complete the sale')
    }
  }

  const handleCheckout = async () => {
    if (!business) return
    if (cart.length === 0) {
      setStatusMessage('Tap items above to add them to the cart')
      return
    }
    if (paymentTotal + 0.001 < cartTotal) {
      setStatusMessage(`KES ${Math.ceil(balanceDue)} still due`)
      return
    }

    const mpesaAmount = paymentDraft.mpesa

    if (mpesaAmount === 0) {
      await finalizeSale(undefined)
      return
    }

    // M-Pesa needs connectivity for STK Push; everything else works offline.
    if (!online) {
      setMpesa({
        stage: 'manual-entry',
        note: 'You are offline, so the M-Pesa push cannot be sent. If the customer has already paid, enter the code from their message.',
      })
      return
    }

    if (!resolvedMpesaPhone) {
      setStatusMessage('Enter the customer phone number for the M-Pesa prompt')
      return
    }

    await sendMpesaPush(resolvedMpesaPhone, mpesaAmount)
  }

  /**
   * Sends one STK prompt to the customer's phone. Separated from
   * handleCheckout so the waiting state can offer "Resend" without
   * re-running any cart logic.
   */
  const sendMpesaPush = async (phone: string, amount: number): Promise<void> => {
    const currentBusiness = stateRef.current.businesses.find((entry) => entry.id === business?.id)
    if (!currentBusiness) return

    if (!mpesaClient) {
      setMpesa({
        stage: 'manual-entry',
        note: 'M-Pesa prompt is not configured on this device yet. Enter the payment code manually instead.',
      })
      return
    }

    if (!normalizeKenyanPhone(phone)) {
      setStatusMessage('Enter a valid Safaricom number, e.g. 0712 345 678')
      return
    }

    setMpesa({ stage: 'pushing' })
    const push = await mpesaClient.stkPush({
      businessId: currentBusiness.id,
      phone,
      amount: Math.round(amount),
      reference: currentBusiness.name.replace(/\s+/g, '').slice(0, 10) || 'POS',
    })

    if (!push.ok) {
      setMpesa({ stage: 'manual-entry', note: push.error })
      return
    }

    lastCheckoutRequestIdRef.current = push.checkoutRequestId
    setMpesa({
      stage: 'waiting',
      checkoutRequestId: push.checkoutRequestId,
      phone: normalizeKenyanPhone(phone) ?? phone,
      amount: Math.round(amount),
      startedAt: Date.now(),
    })
    setStatusMessage('Prompt sent. The sale completes itself once the customer pays')
  }

  const resendMpesaPush = async () => {
    if (mpesa.stage !== 'waiting') return
    await sendMpesaPush(mpesa.phone, mpesa.amount)
  }

  const changeMpesaNumber = () => {
    setMpesa({ stage: 'idle' })
    setStkPhone('')
    setMpesaManualCode('')
    setStatusMessage('Enter the corrected number, then send the prompt again')
  }

  const enterManualMpesa = () => {
    setMpesa({
      stage: 'manual-entry',
      note: 'Enter the M-Pesa confirmation code from the customer’s payment SMS.',
    })
  }

  const confirmManualMpesa = async () => {
    const code = mpesaManualCode.trim().toUpperCase()
    if (!isValidMpesaReceipt(code)) {
      setStatusMessage('M-Pesa codes are 10 letters/numbers, e.g. QGH7XYZ12K')
      return
    }
    // Manual completion closes the prompt: the background listener must not
    // fire a second finalize when Safaricom later reports the same payment.
    if (lastCheckoutRequestIdRef.current) {
      finalizedCheckoutIdsRef.current.add(lastCheckoutRequestIdRef.current)
    }
    await finalizeSale('manual', code)
  }

  const cancelMpesaFlow = () => {
    // Explicit cancel stops auto-completion for this prompt: the attendant
    // is switching payment methods, so a late confirmation must never
    // finalize whatever cart happens to be open afterwards.
    if (lastCheckoutRequestIdRef.current) {
      finalizedCheckoutIdsRef.current.add(lastCheckoutRequestIdRef.current)
    }
    setMpesa({ stage: 'idle' })
    setMpesaManualCode('')
    setStatusMessage('M-Pesa step cancelled. The cart is untouched')
  }

  finalizeRef.current = finalizeSale

  // --- Exports -------------------------------------------------------------

  const exportData = (kind: 'sales' | 'stock' | 'customers') => {
    if (!business) return
    const safeName = business.name.toLowerCase().replace(/\s+/g, '-') || 'business'
    if (kind === 'sales') {
      downloadCsv(`${safeName}-sales.csv`, exportSalesCsv(business))
    } else if (kind === 'stock') {
      downloadCsv(`${safeName}-stock.csv`, exportStockCsv(business))
    } else {
      downloadCsv(`${safeName}-customers.csv`, exportCustomersCsv(business))
    }
    setStatusMessage(`${kind} list downloaded. Open it in Excel or Google Sheets`)
  }

  const resolveQueueConflict = (id: string, keep: 'mine' | 'theirs') => {
    resolveConflict(state, id, keep === 'mine' ? 'local' : 'remote')
    setStatusMessage(keep === 'mine' ? 'Keeping your copy. It will sync again' : 'Using the copy from the cloud')
    refresh()
    if (keep === 'mine' && navigator.onLine) {
      void runSync(state, syncAdapter, { maxAttempts: 1, baseDelayMs: 200 }).then(() => {
        void pruneSyncedQueueItems(state)
        forceRender()
      })
    }
  }

  // --- Render: loading -----------------------------------------------------

  if (!loaded) {
    return (
      <div className="app-shell">
        <div className="panel loading-panel">
          <h1>Opening your shop…</h1>
        </div>
      </div>
    )
  }

  // --- Render: signup / first-run (Section 3: account FIRST, zero businesses,
  // then email verification, then the first business) ----------------------

  if (!business) {
    const renderSigninFields = () => (
      <>
        <div className="form-row">
          <input
            type="email"
            value={ownerEmailInput}
            onChange={(event) => setOwnerEmailInput(event.target.value)}
            placeholder="Email address"
            autoComplete="username"
          />
        </div>
        <div className="form-row">
          <input
            type="password"
            value={ownerPasswordInput}
            onChange={(event) => setOwnerPasswordInput(event.target.value)}
            placeholder="Password"
            autoComplete="current-password"
          />
        </div>
      </>
    )

    const renderSignupFields = () => (
      <>
        <div className="form-row">
          <input
            value={signupFullName}
            onChange={(event) => setSignupFullName(event.target.value)}
            placeholder="Your full name"
            autoComplete="name"
          />
        </div>
        <div className="form-row">
          <input
            type="email"
            value={ownerEmailInput}
            onChange={(event) => setOwnerEmailInput(event.target.value)}
            placeholder="Email address"
            autoComplete="username"
          />
        </div>
        <div className="form-row">
          <input
            value={signupPhone}
            onChange={(event) => setSignupPhone(event.target.value)}
            placeholder="Phone number (optional)"
            inputMode="tel"
          />
        </div>
        <div className="form-row inline-fields">
          <input
            type="password"
            value={ownerPasswordInput}
            onChange={(event) => setOwnerPasswordInput(event.target.value)}
            placeholder="Password (8+ characters)"
            autoComplete="new-password"
          />
          <input
            type="password"
            value={signupConfirm}
            onChange={(event) => setSignupConfirm(event.target.value)}
            placeholder="Confirm password"
            autoComplete="new-password"
          />
        </div>
      </>
    )

    return (
      <div className="app-shell">
        <div className="panel signup-panel">
          <p className="eyebrow">Kenya POS</p>

          {signupStep === 'account' && (
            <>
              <div className="owner-mode-toggle">
                <button
                  type="button"
                  className={authMode === 'signup' ? 'owner-mode-tab selected' : 'owner-mode-tab'}
                  onClick={() => {
                    setAuthMode('signup')
                    setAuthError('')
                  }}
                >
                  Sign Up
                </button>
                <button
                  type="button"
                  className={authMode === 'signin' ? 'owner-mode-tab selected' : 'owner-mode-tab'}
                  onClick={() => {
                    setAuthMode('signin')
                    setAuthError('')
                  }}
                >
                  Log In
                </button>
              </div>
              {authMode === 'signup' ? (
                <>
                  <h1>Create your owner account</h1>
                  <p className="muted">One account can hold many businesses. Your data stays yours.</p>
                  {renderSignupFields()}
                  {authError && <p className="error-text">{authError}</p>}
                  <button type="button" className="primary" onClick={() => void attemptOwnerSignup()}>
                    Create account
                  </button>
                  <details className="forgot-password-box">
                    <summary>Forgot your password?</summary>
                    <p className="muted">
                      Password resets happen by email. {backendEnabled ? 'Enter your email on the sign-in screen after requesting a reset link from the login page.' : 'Demo mode: accounts live only on this device. Clear the site data in your browser to start over.'}
                    </p>
                  </details>
                </>
              ) : (
                <>
                  <h1>Welcome back</h1>
                  {renderSigninFields()}
                  {authError && <p className="error-text">{authError}</p>}
                  <button type="button" className="primary" onClick={() => void attemptOwnerLogin()}>
                    Log in
                  </button>
                </>
              )}
            </>
          )}

          {signupStep === 'verify' && (
            <>
              <h1>Check your email</h1>
              <p className="muted">
                Enter the verification code we sent to {ownerEmailInput || 'your email'}. You need a verified email
                before setting up M-Pesa (Daraja).
              </p>
              <div className="form-row">
                <input
                  value={verificationCodeInput}
                  onChange={(event) => setVerificationCodeInput(event.target.value.replace(/\D/g, ''))}
                  placeholder="6-digit code"
                  inputMode="numeric"
                  maxLength={6}
                  autoFocus
                />
              </div>
              {verificationError && <p className="error-text">{verificationError}</p>}
              <button type="button" className="primary" onClick={confirmVerification}>
                Verify email
              </button>
              {!backendEnabled && <small className="muted demo-hint">Demo mode: the code is 123456.</small>}
            </>
          )}

          {signupStep === 'business' && (
            <>
              <h1>Create your first business</h1>
              <p className="muted">Linked to your account, {owner?.email ?? ownerEmailInput}. You can add more businesses any time.</p>
              <div className="form-row">
                <input
                  value={signupForm.name}
                  onChange={(event) => setSignupForm((current) => ({ ...current, name: event.target.value }))}
                  placeholder="Business name (e.g. Mama Njeri Duka)"
                />
              </div>
              <div className="form-row">
                <select
                  value={signupForm.type}
                  onChange={(event) =>
                    setSignupForm((current) => ({ ...current, type: event.target.value as BusinessType }))
                  }
                >
                  <option value="shop">Shop / Duka</option>
                  <option value="supermarket">Supermarket</option>
                  <option value="pharmacy">Pharmacy / Chemist</option>
                  <option value="liquor">Liquor store</option>
                  <option value="hardware">Hardware / Agrovet</option>
                  <option value="salon">Salon / Barber</option>
                </select>
              </div>
              <div className="form-row">
                <input
                  value={signupForm.shortCode}
                  onChange={(event) => setSignupForm((current) => ({ ...current, shortCode: event.target.value }))}
                  placeholder="Paybill / Till number (optional)"
                  inputMode="numeric"
                />
              </div>
              {ownerLoginError && <p className="error-text">{ownerLoginError}</p>}
              <button type="button" className="primary" onClick={() => void createFirstBusiness()}>
                Create business &amp; start selling
              </button>
            </>
          )}

          {!backendEnabled && (
            <small className="muted demo-hint">
              Demo mode: accounts are stored on this device only. Configure the backend for accounts that work across
              devices.
            </small>
          )}
        </div>
      </div>
    )
  }

  // --- Render: login gate (staff PIN + real owner sign-in) -----------------

  if (needsPinLogin) {
    return (
      <div className="app-shell">
        <div className="login-screen">
          <div className="panel login-panel">
            <p className="eyebrow">{business.name}</p>
            <h1>Who is serving?</h1>
            <div className="staff-picker">
              {business.staff.map((staff) => (
                <button
                  key={staff.id}
                  type="button"
                  className={pendingStaffId === staff.id ? 'staff-chip selected' : 'staff-chip'}
                  onClick={() => {
                    setPendingStaffId(staff.id)
                    setPinError('')
                  }}
                >
                  {staff.name}
                  <small>{staff.shift}</small>
                </button>
              ))}
            </div>
            <div className="form-row">
              <input
                type="password"
                inputMode="numeric"
                maxLength={6}
                value={pinInput}
                onChange={(event) => setPinInput(event.target.value.replace(/\D/g, ''))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') attemptPinLogin()
                }}
                placeholder="Enter your PIN"
                autoFocus
              />
            </div>
            {pinError && <p className="error-text">{pinError}</p>}
            <button type="button" className="primary" onClick={attemptPinLogin}>
              Start my shift
            </button>

            <div className="owner-login-divider">
              <span>Owner access</span>
            </div>
            <div className="owner-mode-toggle">
              <button
                type="button"
                className={ownerMode === 'signin' ? 'owner-mode-tab selected' : 'owner-mode-tab'}
                onClick={() => {
                  setOwnerMode('signin')
                  setOwnerLoginError('')
                }}
              >
                Sign in
              </button>
              <button
                type="button"
                className={ownerMode === 'signup' ? 'owner-mode-tab selected' : 'owner-mode-tab'}
                onClick={() => {
                  setOwnerMode('signup')
                  setOwnerLoginError('')
                }}
              >
                Create account
              </button>
            </div>
            {ownerMode === 'signup' && (
              <div className="form-row">
                <input
                  value={signupFullName}
                  onChange={(event) => setSignupFullName(event.target.value)}
                  placeholder="Your full name"
                  autoComplete="name"
                />
              </div>
            )}
            <div className="form-row inline-fields">
              <input
                type="email"
                value={ownerEmailInput}
                onChange={(event) => setOwnerEmailInput(event.target.value)}
                placeholder="Owner email"
                autoComplete="username"
              />
              <input
                type="password"
                value={ownerPasswordInput}
                onChange={(event) => setOwnerPasswordInput(event.target.value)}
                placeholder={ownerMode === 'signup' ? 'Choose a password (8+ characters)' : 'Owner password'}
                autoComplete={ownerMode === 'signup' ? 'new-password' : 'current-password'}
              />
            </div>
            {ownerMode === 'signup' && (
              <div className="form-row">
                <input
                  type="password"
                  value={signupConfirm}
                  onChange={(event) => setSignupConfirm(event.target.value)}
                  placeholder="Confirm password"
                  autoComplete="new-password"
                />
              </div>
            )}
            {ownerLoginError && <p className="error-text">{ownerLoginError}</p>}
            {authError && <p className="error-text">{authError}</p>}
            {verificationError && <p className="error-text">{verificationError}</p>}
            {verificationPending && (
              <>
                <p className="muted gate-verify-note">
                  Account created! Enter the 6-digit code{backendEnabled ? ' from your email' : ' (demo code: 123456)'} to
                  finish.
                </p>
                <div className="form-row inline-fields">
                  <input
                    value={verificationCodeInput}
                    onChange={(event) => setVerificationCodeInput(event.target.value.replace(/\D/g, ''))}
                    placeholder="6-digit email code"
                    inputMode="numeric"
                    maxLength={6}
                  />
                  <button type="button" className="primary" onClick={confirmVerification}>
                    Verify
                  </button>
                </div>
              </>
            )}
            <button
              type="button"
              className="owner-login-button"
              onClick={() => void (ownerMode === 'signup' ? attemptOwnerSignup() : attemptOwnerLogin())}
            >
              {ownerMode === 'signup' ? 'Create owner account' : 'Sign in as owner'}
            </button>
            {!backendEnabled && (
              <small className="muted demo-hint">
                Demo mode: owner@demo.co.ke / demo1234, or create your own account. Configure the backend for real
                accounts.
              </small>
            )}
          </div>
        </div>
      </div>
    )
  }

  const connectionLabel = syncing ? 'Syncing…' : online ? 'Online' : 'Offline. Still selling'

  // --- Render: business chooser (Section 2, one owner, many businesses) ---

  if ((businessChooserOpen && isOwnerHere) || ownerHasNoBusinesses) {
    return (
      <div className="app-shell">
        <div className="panel chooser-panel">
          <p className="eyebrow">Kenya POS</p>
          <h1>{ownerHasNoBusinesses ? 'Create your first business' : 'Choose a business'}</h1>
          <p className="muted">Signed in as {owner?.email}. Each business keeps its own staff, items and records.</p>
          <div className="chooser-list">
            {visibleBusinesses.length === 0 && (
              <p className="muted">No businesses on this account yet. Set up your first one below.</p>
            )}
            {visibleBusinesses.map((entry) => (
              <div key={entry.id} className="chooser-item">
                <div>
                  <strong>{entry.name}</strong>
                  <small>{entry.type} · today: KES {chooserTotals[entry.id] ?? 0}</small>
                </div>
                <div className="chooser-actions">
                  <button type="button" className="primary" onClick={() => chooseBusiness(entry.id)}>
                    Open
                  </button>
                  {backendEnabled && navigator.onLine && (
                    <button
                      type="button"
                      disabled={restoring}
                      onClick={() => void restoreBusiness(entry.id)}
                    >
                      {restoring ? 'Restoring…' : 'Restore from cloud'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          <h2 className="chooser-subheading">{ownerHasNoBusinesses ? 'Set up your business' : 'Add another business'}</h2>
          <div className="form-row">
            <input
              value={signupForm.name}
              onChange={(event) => setSignupForm((current) => ({ ...current, name: event.target.value }))}
              placeholder="Business name"
            />
          </div>
          <div className="form-row inline-fields">
            <select
              value={signupForm.type}
              onChange={(event) =>
                setSignupForm((current) => ({ ...current, type: event.target.value as BusinessType }))
              }
            >
              <option value="shop">Shop / Duka</option>
              <option value="supermarket">Supermarket</option>
              <option value="pharmacy">Pharmacy / Chemist</option>
              <option value="liquor">Liquor store</option>
              <option value="hardware">Hardware / Agrovet</option>
              <option value="salon">Salon / Barber</option>
            </select>
            <input
              value={signupForm.shortCode}
              onChange={(event) => setSignupForm((current) => ({ ...current, shortCode: event.target.value }))}
              placeholder="Till / Paybill (optional)"
              inputMode="numeric"
            />
          </div>
          {ownerLoginError && <p className="error-text">{ownerLoginError}</p>}
          <button
            type="button"
            className={ownerHasNoBusinesses ? 'primary' : undefined}
            onClick={() => void (ownerHasNoBusinesses ? createFirstBusiness() : createBusiness())}
          >
            {ownerHasNoBusinesses ? 'Create business & start selling' : '+ Add another business'}
          </button>

          <button type="button" className="link-button chooser-logout" onClick={() => void ownerLogout()}>
            Log out
          </button>
        </div>
      </div>
    )
  }

  // --- Render: main app ----------------------------------------------------

  /** Navigates from the menu and closes the drawer in one tap. */
  const goToScreen = (screen: OwnerScreen | 'sell') => {
    setActiveScreen(screen)
    setMenuOpen(false)
  }

  const menuItems = isOwnerHere ? OWNER_MENU : []

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-left">
          <button
            type="button"
            className="hamburger"
            aria-label="Open menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span />
            <span />
            <span />
          </button>
          <div>
            <p className="eyebrow">Kenya POS</p>
            <h1>{business.name}</h1>
          </div>
        </div>
        <div className="topbar-side">
          <div className="connection-status">
            <span className={`dot ${syncing ? 'syncing' : online ? 'online' : 'offline'}`} />
            {connectionLabel}
          </div>
          {activeStaff ? (
            <div className="attendant-chip">
              Serving as <strong>{activeStaff.name}</strong>
              <button type="button" className="link-button" onClick={switchAttendant}>
                Switch
              </button>
            </div>
          ) : isOwnerHere ? (
            <div className="attendant-chip owner-chip">
              <strong>Owner</strong> · {owner?.email}
              <button type="button" className="link-button" onClick={() => void ownerLogout()}>
                Log out
              </button>
            </div>
          ) : (
            <div className="attendant-chip">
              <strong>Limited view.</strong> Owner features need sign-in
            </div>
          )}
        </div>
      </header>

      {menuOpen && (
        <div className="menu-backdrop" onClick={() => setMenuOpen(false)}>
          <nav className="menu-drawer" onClick={(event) => event.stopPropagation()}>
            <p className="eyebrow">Menu</p>
            <button
              type="button"
              className={activeScreen === 'sell' ? 'menu-item selected' : 'menu-item'}
              onClick={() => goToScreen('sell')}
            >
              Sell
            </button>
            {menuItems.map((item) => (
              <button
                key={item.id}
                type="button"
                className={activeScreen === item.id ? 'menu-item selected' : 'menu-item'}
                onClick={() => goToScreen(item.id)}
              >
                {item.label}
              </button>
            ))}
            {isOwnerHere && visibleBusinesses.length > 1 && (
              <button type="button" className="menu-item" onClick={() => { setMenuOpen(false); setBusinessChooserOpen(true) }}>
                Switch business…
              </button>
            )}
            {!activeStaff && (
              <button type="button" className="menu-item menu-item-quiet" onClick={() => { setMenuOpen(false); switchAttendant() }}>
                Staff login
              </button>
            )}
          </nav>
        </div>
      )}

      {statusMessage && <p className="status-banner">{statusMessage}</p>}

      {walkthroughStep !== null && (
        <div className="walkthrough-overlay">
          <div className="panel walkthrough-card">
            <p className="eyebrow">Step {walkthroughStep} of 3</p>
            {walkthroughStep === 1 && (
              <>
                <h2>Add what you sell</h2>
                <p>
                  In <strong>“Add / import items”</strong>, put in each product: name, price and how many you have.
                  Many at once? Use “Import many items at once” and paste your list.
                </p>
              </>
            )}
            {walkthroughStep === 2 && (
              <>
                <h2>Make a sale</h2>
                <p>
                  On the <strong>Sell</strong> screen, tap the items the customer takes; they land in the cart. Choose
                  Cash or M-Pesa (or both), then press <strong>Complete sale</strong>.
                </p>
              </>
            )}
            {walkthroughStep === 3 && (
              <>
                <h2>See your day</h2>
                <p>
                  The <strong>Today</strong> panel shows everything: total sales, cash vs M-Pesa, your best sellers and
                  who served. It resets each morning.
                </p>
              </>
            )}
            <div className="walkthrough-actions">
              <button
                type="button"
                className="primary"
                onClick={() => {
                  if (walkthroughStep < 3) {
                    setWalkthroughStep(walkthroughStep + 1)
                  } else {
                    finishWalkthrough(walkthroughStep)
                  }
                }}
              >
                {walkthroughStep < 3 ? 'Next' : 'Done. Start selling'}
              </button>
              <button type="button" className="link-button" onClick={() => finishWalkthrough(0)}>
                Skip. I know this app
              </button>
            </div>
          </div>
        </div>
      )}

      {cameraScanOpen && (
        <CameraBarcodeScanner
          onDetected={(barcode) => {
            setCameraScanOpen(false)
            handleScannedBarcode(barcode, 'camera')
          }}
          onClose={() => setCameraScanOpen(false)}
        />
      )}

      {conflicts.length > 0 && (
        <section className="panel conflict-box">
          <h2>Sync conflicts need your decision</h2>
          <p className="muted">The same records changed on this device and in the cloud. Nothing was lost. Pick which copy to keep.</p>
          {conflicts.map((item) => (
            <div key={item.id} className="conflict-item">
              <div>
                <strong>{item.action}</strong>
                <small>{item.conflict?.map((c) => c.field).join(', ')}</small>
              </div>
              <div className="conflict-actions">
                <button type="button" onClick={() => resolveQueueConflict(item.id, 'mine')}>
                  Keep mine
                </button>
                <button type="button" onClick={() => resolveQueueConflict(item.id, 'theirs')}>
                  Use theirs
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      <div className="content-grid">
        <main className="main-panel">
          {activeScreen === 'sell' && (
          <section className="panel sales-panel">
            <div className="section-header">
              <h2>Sell</h2>
              <div className="search-box">
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search items…"
                />
              </div>
            </div>

            <div className="scan-bar">
              <small className={scanNotFoundCode ? 'scan-hint scan-hint-warn' : 'scan-hint'}>{scanHint}</small>
              {cameraScanSupported() && (
                <button type="button" onClick={() => setCameraScanOpen(true)}>
                  Scan with camera
                </button>
              )}
            </div>

            {scanNotFoundCode && (
              <div className="scan-not-found panel">
                <p>
                  No product found for barcode <strong>{scanNotFoundCode}</strong>. Add it to inventory?
                </p>
                <div className="scan-not-found-actions">
                  <button type="button" className="primary" onClick={startAddProductFromBarcode}>
                    Add new product with this barcode
                  </button>
                  <button type="button" className="link-button" onClick={dismissScanNotFound}>
                    Dismiss
                  </button>
                </div>
              </div>
            )}

            {business.products.length === 0 ? (
              <p className="muted">No items yet{isOwnerHere ? '. Add your first item below or import a list.' : '. The owner has not added items yet.'}</p>
            ) : (
              <div className="product-list">
                {filteredProducts.map((product) => (
                  <button key={product.id} type="button" className="product-card" onClick={() => addToCart(product)}>
                    <span>{product.name}</span>
                    <strong>KES {product.price}</strong>
                    <small className={product.stockQuantity <= product.lowStockAlert ? 'stock-low' : ''}>
                      {product.stockQuantity} {product.unitOfMeasure} left
                    </small>
                    {product.expiryDate && (
                      <small className="expiry-tag">Exp: {product.expiryDate}</small>
                    )}
                  </button>
                ))}
              </div>
            )}

            <div className="cart-box">
              <h3>Cart</h3>
              {cart.length === 0 ? (
                <p className="muted">Cart is empty. Your unsold items are safe if the phone goes off.</p>
              ) : (
                <div className="cart-items">
                  {cart.map((item) => (
                    <div key={item.productId} className="cart-item">
                      <div>
                        <strong>{item.name}</strong>
                        <small>KES {item.unitPrice} each</small>
                      </div>
                      <div className="qty-controls">
                        <button type="button" onClick={() => changeQuantity(item.productId, -1)}>
                          −
                        </button>
                        <span>{item.quantity}</span>
                        <button type="button" onClick={() => changeQuantity(item.productId, 1)}>
                          +
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="payment-grid">
                <label>
                  Cash
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    value={paymentDraft.cash || ''}
                    placeholder="0"
                    onChange={(event) =>
                      setPaymentDraft((current) => ({ ...current, cash: Number(event.target.value) || 0 }))
                    }
                  />
                </label>
                <label>
                  M-Pesa
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    value={paymentDraft.mpesa || ''}
                    placeholder="0"
                    onChange={(event) =>
                      setPaymentDraft((current) => ({ ...current, mpesa: Number(event.target.value) || 0 }))
                    }
                  />
                </label>
              </div>

              {paymentDraft.mpesa > 0 && (
                <div className="mpesa-prompt-box">
                  {mpesa.stage === 'idle' && (
                    <>
                      <div className="mpesa-prompt-head">
                        <strong>Prompt {resolvedMpesaPhone || 'the customer'} for KES {Math.round(paymentDraft.mpesa)}</strong>
                        {!online && <small className="mpesa-offline-note">Offline. The prompt needs internet; record the code manually instead.</small>}
                      </div>
                      {online && (
                        <>
                          <div className="form-row">
                            <input
                              value={stkPhone}
                              onChange={(event) => setStkPhone(event.target.value)}
                              placeholder="Customer number, e.g. 0712 345 678"
                              inputMode="tel"
                              aria-label="Customer phone number for the M-Pesa prompt"
                              className={mpesaPhoneInvalid ? 'input-error' : ''}
                            />
                          </div>
                          {mpesaPhoneInvalid && (
                            <p className="error-text">That number doesn’t look right. Use 07…, 01…, or +254…</p>
                          )}
                        </>
                      )}
                    </>
                  )}

                  {mpesa.stage === 'pushing' && (
                    <div className="mpesa-prompt-head">
                      <strong>Sending the prompt…</strong>
                      <p className="muted">Ask the customer to watch their phone.</p>
                    </div>
                  )}

                  {mpesa.stage === 'waiting' && (
                    <div className="mpesa-prompt-head">
                      <strong>
                        Prompt sent to {formatKenyanPhone(mpesa.phone)} for KES {mpesa.amount}
                      </strong>
                      <p className="muted">The customer sees the request on their phone and enters their M-Pesa PIN. The sale completes by itself the moment they pay.</p>
                      <div className="mpesa-countdown" role="status">
                        {mpesaElapsed >= STK_PROMPT_SECONDS
                          ? 'Still waiting. If the customer pays, the sale completes automatically, or use the options below.'
                          : `Waiting for the PIN… ${Math.max(0, STK_PROMPT_SECONDS - mpesaElapsed)}s`}
                      </div>
                      <div className="mpesa-prompt-actions">
                        <button type="button" onClick={() => void resendMpesaPush()}>
                          Resend prompt
                        </button>
                        <button type="button" onClick={enterManualMpesa}>Enter code manually</button>
                        <button type="button" onClick={changeMpesaNumber}>Change number</button>
                      </div>
                    </div>
                  )}

                  {mpesa.stage === 'manual-entry' && (
                    <>
                      {mpesa.note && <p className="muted">{mpesa.note}</p>}
                      <div className="form-row inline-fields">
                        <input
                          value={mpesaManualCode}
                          onChange={(event) => setMpesaManualCode(event.target.value.toUpperCase())}
                          placeholder="M-Pesa code e.g. QGH7XYZ12K"
                          maxLength={10}
                        />
                        <button type="button" className="primary" onClick={() => void confirmManualMpesa()}>
                          Record code &amp; finish
                        </button>
                      </div>
                      <button type="button" className="link-button" onClick={cancelMpesaFlow}>
                        Cancel M-Pesa step
                      </button>
                    </>
                  )}
                </div>
              )}

              <div className="checkout-summary">
                <span>To pay</span>
                <strong>KES {cartTotal}</strong>
              </div>
              <div className="checkout-summary small">
                <span>Recorded so far</span>
                <strong>KES {paymentTotal}</strong>
              </div>
              {balanceDue > 0 && cart.length > 0 && (
                <div className="checkout-summary small balance-due">
                  <span>Still due</span>
                  <strong>KES {Math.ceil(balanceDue)}</strong>
                </div>
              )}

              <div className="form-row">
                <select
                  value={selectedCustomerId}
                  onChange={(event) => {
                    // Quick path: add a regular customer without leaving the
                    // sale. The full customer list stays in its own screen.
                    if (event.target.value === '__add-customer__') {
                      const name = window.prompt('Customer name?')
                      if (!name || !name.trim()) return
                      const phone = window.prompt('Phone (optional)?') ?? ''
                      addCustomerFromForm(name.trim(), phone.trim())
                    }
                  }}
                >
                  <option value="">Walk-in customer</option>
                  {business.customers.map((customer) => (
                    <option key={customer.id} value={customer.id}>
                      {customer.name}
                    </option>
                  ))}
                  <option value="__add-customer__">+ Add new customer…</option>
                </select>
              </div>

              <button
                type="button"
                className="primary"
                disabled={mpesa.stage === 'pushing' || mpesa.stage === 'waiting'}
                onClick={() => void handleCheckout()}
              >
                {mpesa.stage === 'pushing'
                  ? 'Sending M-Pesa prompt…'
                  : mpesa.stage === 'waiting'
                    ? 'Waiting for customer M-Pesa PIN…'
                    : paymentDraft.mpesa > 0 && online
                      ? 'Send M-Pesa prompt & complete'
                      : 'Complete sale'}
              </button>
            </div>
          </section>
          )}

          {activeScreen === 'sell' && dailySummary && (
            <section className="panel today-strip">
              <div className="today-strip-head">
                <h2>Today · {todayKey()}</h2>
                <small className="muted">Total sales, cash vs M-Pesa, and who served. Resets each morning.</small>
              </div>
              <div className="kpi-row">
                <div>
                  <span>Total sales</span>
                  <strong>KES {dailySummary.totalSales}</strong>
                </div>
                <div>
                  <span>Cash</span>
                  <strong>KES {dailySummary.cash}</strong>
                </div>
                <div>
                  <span>M-Pesa</span>
                  <strong>KES {dailySummary.mpesa}</strong>
                </div>
              </div>
              {dailySummary.topItems.length > 0 && (
                <div className="summary-list">
                  <h3>Top sellers today</h3>
                  {dailySummary.topItems.map((item) => (
                    <div key={item.name} className="summary-line">
                      <span>{item.name}</span>
                      <strong>{item.quantity}</strong>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {activeScreen === 'sell' && isOwnerHere && liveSales.length > 0 && (
            <section className="panel live-sales-panel">
              <div className="today-strip-head">
                <h2>Live sales</h2>
                <small className="muted">Newest first. Sales from every device in this shop land here as they happen.</small>
              </div>
              <ul className="live-sales-list">
                {liveSales.map((row) => (
                  <li key={row.id} className={row.refunded ? 'refunded' : ''}>
                    <span className="live-time">{row.time}</span>
                    <span className="live-attendant">{row.attendant}</span>
                    <span className="live-method">{row.mpesa > 0 ? 'M-Pesa' : row.credit > 0 ? 'Credit' : 'Cash'}</span>
                    <strong className="live-amount">KES {row.total.toLocaleString()}</strong>
                    {row.refunded && <em className="live-refund-tag">Refunded</em>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {activeScreen === 'inventory' && isOwnerHere && (
            <section className="panel screen-panel">
              <h2>Add / import items</h2>
                <div className="form-row">
                  <input
                    id="product-form-name"
                    value={productForm.name}
                    onChange={(event) => setProductForm((current) => ({ ...current, name: event.target.value }))}
                    placeholder="Item name"
                  />
                </div>
                <div className="form-row">
                  <input
                    value={productForm.barcode}
                    onChange={(event) => setProductForm((current) => ({ ...current, barcode: event.target.value.trim() }))}
                    placeholder="Barcode (optional, scan or type it)"
                    inputMode="numeric"
                  />
                </div>
                <div className="form-row inline-fields">
                  <input
                    value={productForm.category}
                    onChange={(event) => setProductForm((current) => ({ ...current, category: event.target.value }))}
                    placeholder="Category"
                    list="category-suggestions"
                  />
                  <datalist id="category-suggestions">
                    {categorySuggestions.map((category) => (
                      <option key={category} value={category} />
                    ))}
                  </datalist>
                  <select
                    value={productForm.unitOfMeasure}
                    onChange={(event) =>
                      setProductForm((current) => ({
                        ...current,
                        unitOfMeasure: event.target.value as UnitOfMeasure,
                      }))
                    }
                  >
                    <option value="piece">Piece</option>
                    <option value="kg">Kg</option>
                    <option value="litre">Litre</option>
                    <option value="pack">Pack</option>
                  </select>
                </div>
                <div className="form-row inline-fields">
                  <input
                    type="number"
                    inputMode="decimal"
                    value={productForm.price}
                    onChange={(event) => setProductForm((current) => ({ ...current, price: event.target.value }))}
                    placeholder="Selling price"
                  />
                  <input
                    type="number"
                    inputMode="decimal"
                    value={productForm.costPrice}
                    onChange={(event) => setProductForm((current) => ({ ...current, costPrice: event.target.value }))}
                    placeholder="Cost price"
                  />
                </div>
                <div className="form-row inline-fields">
                  <input
                    type="number"
                    inputMode="numeric"
                    value={productForm.stockQuantity}
                    onChange={(event) =>
                      setProductForm((current) => ({ ...current, stockQuantity: event.target.value }))
                    }
                    placeholder="Stock quantity"
                  />
                  <input
                    type="number"
                    inputMode="numeric"
                    value={productForm.lowStockAlert}
                    onChange={(event) =>
                      setProductForm((current) => ({ ...current, lowStockAlert: event.target.value }))
                    }
                    placeholder="Alert me when below"
                  />
                </div>
                <div className="form-row inline-fields">
                  <input
                    type="date"
                    value={productForm.expiryDate}
                    onChange={(event) => setProductForm((current) => ({ ...current, expiryDate: event.target.value }))}
                    aria-label="Expiry date"
                  />
                  <input
                    value={productForm.batchNumber}
                    onChange={(event) => setProductForm((current) => ({ ...current, batchNumber: event.target.value }))}
                    placeholder="Batch number (optional)"
                  />
                </div>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={productForm.restrictedItem}
                    onChange={(event) =>
                      setProductForm((current) => ({ ...current, restrictedItem: event.target.checked }))
                    }
                  />
                  Restricted item (e.g. medicine, alcohol)
                </label>
                <button type="button" className="primary" onClick={addProductFromForm}>
                  Add item
                </button>

                <details className="bulk-box">
                  <summary>Import many items at once</summary>
                  <p className="muted">
                    One per line: <code>Name, Category, Price, Stock, Cost, Unit</code>. Only the first four are
                    required.
                  </p>
                  <textarea
                    value={bulkText}
                    onChange={(event) => setBulkText(event.target.value)}
                    rows={5}
                    placeholder={'Milk, Fresh, 60, 30, 45, piece\nBread, Food, 55, 10'}
                  />
                  {bulkErrors.length > 0 && (
                    <ul className="error-list">
                      {bulkErrors.map((error) => (
                        <li key={error}>{error}</li>
                      ))}
                    </ul>
                  )}
                  <button type="button" className="primary" onClick={importBulkProducts}>
                    Import list
                  </button>
                </details>
            </section>
          )}

          {activeScreen === 'customers' && isOwnerHere && (
            <section className="panel screen-panel">
              <h2>Customers</h2>
              <p className="muted">Save regular customers so you can pick them at checkout.</p>
              <div className="form-row inline-fields">
                <input
                  value={customerForm.name}
                  onChange={(event) => setCustomerForm((current) => ({ ...current, name: event.target.value }))}
                  placeholder="Customer name"
                />
                <input
                  value={customerForm.phone}
                  onChange={(event) => setCustomerForm((current) => ({ ...current, phone: event.target.value }))}
                  placeholder="Phone (optional)"
                  inputMode="tel"
                />
              </div>
              <button type="button" className="primary" onClick={() => addCustomerFromForm()}>
                Add customer
              </button>

              <div className="ledger-list">
                {business.customers.length === 0 && <p className="muted">No customers yet.</p>}
                {business.customers.map((customer) => (
                  <div key={customer.id} className="ledger-item">
                    <div>
                      <strong>{customer.name}</strong>
                      <small>{customer.phone ?? 'No phone saved'}</small>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {activeScreen === 'stock' && isOwnerHere && (
            <section className="panel screen-panel">
              <h2>Correct stock</h2>
              <p className="muted">For breakages, theft, expiry, deliveries or counting mistakes.</p>
              <div className="form-row">
                <select
                  value={stockForm.productId}
                  onChange={(event) => setStockForm((current) => ({ ...current, productId: event.target.value }))}
                >
                  <option value="">Select item</option>
                  {business.products.map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.name} ({product.stockQuantity} left)
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-row inline-fields">
                <select
                  value={stockForm.reason}
                  onChange={(event) =>
                    setStockForm((current) => ({ ...current, reason: event.target.value as StockAdjustmentReason }))
                  }
                >
                  <option value="damage">Damage / breakage</option>
                  <option value="theft">Theft</option>
                  <option value="expired">Expired / spoilage</option>
                  <option value="delivery">Delivery received</option>
                  <option value="count-correction">Count correction</option>
                </select>
                <input
                  type="number"
                  inputMode="numeric"
                  value={stockForm.quantityDelta}
                  onChange={(event) => setStockForm((current) => ({ ...current, quantityDelta: event.target.value }))}
                  placeholder="Qty (+ or −)"
                />
              </div>
              <button type="button" className="primary" onClick={recordCorrection}>
                Save correction
              </button>

              {lowStockProducts.length > 0 && (
                <div className="low-stock-box">
                  <h3>Running low</h3>
                  {lowStockProducts.map((product) => (
                    <div key={product.id} className="summary-line">
                      <span>{product.name}</span>
                      <strong>
                        {product.stockQuantity} {product.unitOfMeasure}
                      </strong>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {activeScreen === 'dashboard' && isOwnerHere && (
            <section className="panel finance-panel">
              <div className="finance-head">
                <h2>Money dashboard</h2>
                <div className="finance-range-tabs">
                  {(['today', 'week', 'month', 'custom', 'all'] as const).map((period) => (
                    <button
                      key={period}
                      type="button"
                      className={financePeriod === period ? 'finance-tab selected' : 'finance-tab'}
                      onClick={() => setFinancePeriod(period)}
                    >
                      {period === 'today'
                        ? 'Today'
                        : period === 'week'
                          ? '7 days'
                          : period === 'month'
                            ? '30 days'
                            : period === 'custom'
                              ? 'Custom'
                              : 'All time'}
                    </button>
                  ))}
                </div>
              </div>

              {financePeriod === 'custom' && (
                <div className="finance-custom-range">
                  <label>
                    From
                    <input
                      type="date"
                      value={customRange.start}
                      onChange={(event) => setCustomRange((current) => ({ ...current, start: event.target.value }))}
                    />
                  </label>
                  <label>
                    To
                    <input
                      type="date"
                      value={customRange.end}
                      onChange={(event) => setCustomRange((current) => ({ ...current, end: event.target.value }))}
                    />
                  </label>
                  {!customRange.start || !customRange.end ? (
                    <small className="muted">Pick both dates to see the numbers.</small>
                  ) : null}
                </div>
              )}

              {financeReport && (
                <>
                  <div className="finance-kpis">
                    <div className="finance-kpi">
                      <span>Revenue (after refunds)</span>
                      <strong>KES {financeReport.revenue.toLocaleString()}</strong>
                      {financeReport.refunds > 0 && (
                        <small className="finance-refund-line">Refunds this period: KES {financeReport.refunds.toLocaleString()}</small>
                      )}
                    </div>
                    <div className="finance-kpi">
                      <span>Cost of goods sold</span>
                      <strong>KES {financeReport.costOfGoods.toLocaleString()}</strong>
                    </div>
                    <div className="finance-kpi gross">
                      <span>Gross profit (revenue minus cost of goods)</span>
                      <strong>KES {financeReport.grossProfit.toLocaleString()}</strong>
                    </div>
                    <div className="finance-kpi">
                      <span>Expenses logged</span>
                      <strong>KES {financeReport.expenses.toLocaleString()}</strong>
                    </div>
                    <div className="finance-kpi net">
                      <span>Net profit (after expenses)</span>
                      <strong>KES {financeReport.netProfit.toLocaleString()}</strong>
                    </div>
                    <div className="finance-kpi roi">
                      <span>Investment recovered so far</span>
                      <strong>{financeReport.roiPercent}%</strong>
                      <small>of KES {financeReport.totalInvested.toLocaleString()} invested since start</small>
                    </div>
                  </div>

                  {trendPoints.length > 0 && (
                    <div className="finance-trend">
                      <h3>Revenue and gross profit over time</h3>
                      <TrendChart points={trendPoints} />
                      <div className="finance-trend-legend">
                        <span className="legend-revenue">Revenue</span>
                        <span className="legend-profit">Gross profit</span>
                      </div>
                    </div>
                  )}

                  <div className="finance-columns">
                    <div className="finance-col">
                      <h3>Capital invested</h3>
                      <p className="muted">What you put in. Return on investment is measured against this.</p>
                      <div className="finance-inline-form">
                        <input
                          type="number"
                          inputMode="numeric"
                          value={capitalForm.starting}
                          onChange={(event) => setCapitalForm((current) => ({ ...current, starting: event.target.value }))}
                          placeholder={`Starting capital (now KES ${(business?.startingCapital ?? 0).toLocaleString()})`}
                        />
                        <button type="button" className="primary" onClick={submitStartingCapital}>Set</button>
                      </div>
                      <div className="finance-inline-form">
                        <input
                          type="number"
                          inputMode="numeric"
                          value={capitalForm.injection}
                          onChange={(event) => setCapitalForm((current) => ({ ...current, injection: event.target.value }))}
                          placeholder="Add capital (e.g. 20000)"
                        />
                        <input
                          value={capitalForm.note}
                          onChange={(event) => setCapitalForm((current) => ({ ...current, note: event.target.value }))}
                          placeholder="Note (optional)"
                        />
                        <button type="button" className="primary" onClick={submitCapitalInjection}>Add</button>
                      </div>
                      <ul className="finance-log">
                        {business?.startingCapital ? (
                          <li>
                            <span>Starting capital</span>
                            <strong>KES {business.startingCapital.toLocaleString()}</strong>
                          </li>
                        ) : null}
                        {[...(business?.capitalInjections ?? [])].reverse().map((injection) => (
                          <li key={injection.id}>
                            <span>
                              {injection.date}
                              {injection.note ? ` · ${injection.note}` : ''}
                            </span>
                            <strong>KES {injection.amount.toLocaleString()}</strong>
                          </li>
                        ))}
                      </ul>
                    </div>

                    <div className="finance-col">
                      <h3>Log an expense</h3>
                      <p className="muted">Rent, wages, transport and the rest. Net profit subtracts these; gross profit does not.</p>
                      <div className="finance-inline-form">
                        <select
                          value={expenseForm.category}
                          onChange={(event) => setExpenseForm((current) => ({ ...current, category: event.target.value as ExpenseCategory }))}
                        >
                          {EXPENSE_CATEGORIES.map((category) => (
                            <option key={category} value={category}>
                              {EXPENSE_CATEGORY_LABELS[category]}
                            </option>
                          ))}
                        </select>
                        <input
                          type="number"
                          inputMode="numeric"
                          value={expenseForm.amount}
                          onChange={(event) => setExpenseForm((current) => ({ ...current, amount: event.target.value }))}
                          placeholder="Amount"
                        />
                      </div>
                      <div className="finance-inline-form">
                        <input
                          type="date"
                          value={expenseForm.date}
                          onChange={(event) => setExpenseForm((current) => ({ ...current, date: event.target.value }))}
                          aria-label="Expense date"
                        />
                        <input
                          value={expenseForm.note}
                          onChange={(event) => setExpenseForm((current) => ({ ...current, note: event.target.value }))}
                          placeholder="Note (optional)"
                        />
                        <button type="button" className="primary" onClick={submitExpense}>Log</button>
                      </div>
                      <div className="finance-inline-form expense-filter">
                        <select
                          value={expenseFilter.category}
                          onChange={(event) =>
                            setExpenseFilter((current) => ({
                              ...current,
                              category: event.target.value as ExpenseCategory | 'all',
                            }))
                          }
                          aria-label="Filter expenses by category"
                        >
                          <option value="all">All categories</option>
                          {EXPENSE_CATEGORIES.map((category) => (
                            <option key={category} value={category}>
                              {EXPENSE_CATEGORY_LABELS[category]}
                            </option>
                          ))}
                        </select>
                      </div>
                      <ul className="finance-log">
                        {visibleExpenses.slice(0, 8).map((expense) => (
                          <li key={expense.id}>
                            <span>
                              {expense.date} · {EXPENSE_CATEGORY_LABELS[expense.category]}
                              {expense.note ? ` · ${expense.note}` : ''}
                            </span>
                            <strong>KES {expense.amount.toLocaleString()}</strong>
                          </li>
                        ))}
                        {visibleExpenses.length === 0 && <li className="muted">No expenses match.</li>}
                      </ul>
                    </div>
                  </div>

                  <div className="finance-columns">
                    <div className="finance-col">
                      <h3>Best sellers</h3>
                      <div className="finance-range-tabs small-tabs">
                        {(['quantity', 'revenue', 'profit'] as const).map((view) => (
                          <button
                            key={view}
                            type="button"
                            className={sellerView === view ? 'finance-tab selected' : 'finance-tab'}
                            onClick={() => setSellerView(view)}
                          >
                            {view === 'quantity' ? 'By units' : view === 'revenue' ? 'By revenue' : 'By profit'}
                          </button>
                        ))}
                      </div>
                      <ul className="finance-bars">
                        {topSellers.length === 0 && <li className="muted">No sales in this period yet.</li>}
                        {topSellers.map((entry) => {
                          const max = topSellers[0]
                          const value =
                            sellerView === 'quantity' ? entry.quantitySold : sellerView === 'revenue' ? entry.revenue : entry.grossProfit
                          const maxValue =
                            sellerView === 'quantity' ? max?.quantitySold : sellerView === 'revenue' ? max?.revenue : max?.grossProfit
                          const width = maxValue ? Math.max(8, Math.round((value / maxValue) * 100)) : 0
                          return (
                            <li key={entry.productId}>
                              <span>{entry.name}</span>
                              <div className="bar-track">
                                <div className="bar-fill" style={{ width: `${width}%` }} />
                              </div>
                              <strong>
                                {sellerView === 'quantity'
                                  ? `${entry.quantitySold} units`
                                  : `KES ${Math.round(value).toLocaleString()}`}
                              </strong>
                            </li>
                          )
                        })}
                      </ul>
                    </div>

                    <div className="finance-col">
                      <h3>Slow movers and dead stock</h3>
                      <p className="muted">Zero sales in the period is a sign to discount, promote or drop the item.</p>
                      <ul className="finance-bars">
                        {slowMovers.map((entry) => (
                          <li key={entry.productId} className={entry.zeroSold ? 'dead-item' : ''}>
                            <span>{entry.name}</span>
                            <div className="bar-track">
                              <div className="bar-fill low" style={{ width: `${Math.min(100, entry.quantitySold * 10)}%` }} />
                            </div>
                            <strong>
                              {entry.zeroSold ? 'Not selling' : `${entry.quantitySold} units`}
                            </strong>
                          </li>
                        ))}
                      </ul>
                    </div>

                    <div className="finance-col">
                      <h3>Refunds</h3>
                      <p className="muted">Money back out to customers. Refunded sales restock automatically.</p>
                      <div className="finance-log refundable">
                        {business?.sales.filter((sale) => !sale.refundedAt).slice(-6).reverse().map((sale) => (
                          <div key={sale.id} className="refund-row">
                            <span>
                              {localDayKey(sale.createdAt)} · KES {sale.total.toLocaleString()}
                            </span>
                            <div className="refund-actions">
                              <input
                                value={refundReasons[sale.id] ?? ''}
                                onChange={(event) => setRefundReasons((current) => ({ ...current, [sale.id]: event.target.value }))}
                                placeholder="Reason (optional)"
                              />
                              <button type="button" className="primary" onClick={() => submitRefund(sale.id)}>Refund</button>
                            </div>
                          </div>
                        ))}
                        {(business?.sales.length ?? 0) === 0 && <p className="muted">No sales to refund yet.</p>}
                      </div>
                    </div>
                  </div>
                </>
              )}
            </section>
          )}

          {activeScreen === 'staff' && isOwnerHere && (
            <section className="panel screen-panel">
              <h2>Staff &amp; PINs</h2>
              <div className="form-row">
                <input
                  value={staffForm.name}
                  onChange={(event) => setStaffForm((current) => ({ ...current, name: event.target.value }))}
                  placeholder="Staff name"
                />
              </div>
              <div className="form-row inline-fields">
                <input
                  value={staffForm.pin}
                  type="password"
                  inputMode="numeric"
                  maxLength={6}
                  onChange={(event) => setStaffForm((current) => ({ ...current, pin: event.target.value.replace(/\D/g, '') }))}
                  placeholder="PIN (4+ digits)"
                />
                <select
                  value={staffForm.shift}
                  onChange={(event) => setStaffForm((current) => ({ ...current, shift: event.target.value }))}
                >
                  <option value="Morning">Morning</option>
                  <option value="Afternoon">Afternoon</option>
                  <option value="Evening">Evening</option>
                  <option value="Night">Night</option>
                </select>
              </div>
              <button type="button" className="primary" onClick={addStaffMember}>
                Add staff member
              </button>
              {business.staff.length > 0 && (
                <ul className="staff-list">
                  {business.staff.map((staff) => (
                    <li key={staff.id} className="staff-row">
                      <span>
                        {staff.name}, {staff.shift}
                      </span>
                      <button
                        type="button"
                        className="link-button staff-remove"
                        onClick={() => deleteStaffMember(staff.id)}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {activeScreen === 'price' && isOwnerHere && (
            <section className="panel screen-panel">
              <h2>Price change</h2>
              <p className="muted">Every price change is recorded with who and when.</p>
              <div className="form-row inline-fields">
                <select
                  value={priceForm.productId}
                  onChange={(event) => setPriceForm((current) => ({ ...current, productId: event.target.value }))}
                >
                  <option value="">Select item</option>
                  {business.products.map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.name}, KES {product.price}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  inputMode="decimal"
                  value={priceForm.newPrice}
                  onChange={(event) => setPriceForm((current) => ({ ...current, newPrice: event.target.value }))}
                  placeholder="New price"
                />
              </div>
              <button type="button" className="primary" onClick={applyPriceChange}>Save new price</button>
            </section>
          )}

          {activeScreen === 'audit' && isOwnerHere && (
            <section className="panel screen-panel">
              <h2>What happened (log)</h2>
              <p className="muted">Stock corrections and price changes: who did them and when.</p>
              {auditTrailFor(business).length === 0 ? (
                <p className="muted">Nothing yet.</p>
              ) : (
                <ul className="audit-list">
                  {auditTrailFor(business)
                    .slice(0, 30)
                    .map((entry: AuditEntry) => (
                      <li key={entry.id}>
                        <strong>{entry.actorName}</strong>{' '}
                        {entry.action === 'stock-adjusted'
                          ? 'corrected stock'
                          : entry.action === 'staff-removed'
                            ? 'removed staff member'
                            : 'changed the price'}{' '}
                        of <strong>{entry.productName}</strong>{' '}
                        <small>
                          {entry.before != null && entry.after != null
                            ? ` (${entry.before} → ${entry.after}) · `
                            : ''}
                          {new Date(entry.at).toLocaleString()}
                        </small>
                      </li>
                    ))}
                </ul>
              )}
            </section>
          )}

          {activeScreen === 'backup' && isOwnerHere && (
            <section className="panel screen-panel">
              <h2>Backup &amp; export</h2>
              <p className="muted">Your data is yours. Take a copy at any time.</p>
              <div className="export-buttons">
                <button type="button" onClick={() => exportData('sales')}>
                  Sales CSV
                </button>
                <button type="button" onClick={() => exportData('stock')}>
                  Stock CSV
                </button>
                <button type="button" onClick={() => exportData('customers')}>
                  Customers CSV
                </button>
              </div>
              <small className="muted">
                {pendingSync === 0
                  ? 'Everything is backed up.'
                  : `${pendingSync} offline change${pendingSync > 1 ? 's' : ''} waiting to back up.`}
              </small>
            </section>
          )}

          {activeScreen === 'settings' && isOwnerHere && (
            <section className="panel screen-panel">
              <h2>Business settings</h2>

              <div className="settings-block">
                <h3>Add a new business</h3>
                <div className="form-row">
                  <input
                    value={signupForm.name}
                    onChange={(event) => setSignupForm((current) => ({ ...current, name: event.target.value }))}
                    placeholder="Business name"
                  />
                </div>
                <div className="form-row">
                  <select
                    value={signupForm.type}
                    onChange={(event) =>
                      setSignupForm((current) => ({ ...current, type: event.target.value as BusinessType }))
                    }
                  >
                    <option value="shop">Shop / Duka</option>
                    <option value="supermarket">Supermarket</option>
                    <option value="pharmacy">Pharmacy / Chemist</option>
                    <option value="liquor">Liquor store</option>
                    <option value="hardware">Hardware / Agrovet</option>
                    <option value="salon">Salon / Barber</option>
                  </select>
                </div>
                <div className="form-row">
                  <input
                    value={signupForm.shortCode}
                    onChange={(event) => setSignupForm((current) => ({ ...current, shortCode: event.target.value }))}
                    placeholder="Till / Paybill (optional)"
                    inputMode="numeric"
                  />
                </div>
                <button type="button" className="primary" onClick={() => void createBusiness()}>
                  Create business
                </button>
                {visibleBusinesses.length > 1 && (
                  <button type="button" className="link-button" onClick={() => setBusinessChooserOpen(true)}>
                    All my businesses…
                  </button>
                )}
                <small className="muted">Linked to {owner?.email}. Sign in on any device to see your businesses.</small>
              </div>
            </section>
          )}

          {activeScreen === 'connections' && isOwnerHere && (
            <section className="panel screen-panel">
              <h2>Connections (Sync, M-Pesa, eTIMS)</h2>
              <div className="settings-block">
                <h3>Sync status</h3>
                <div className="sync-pill">{syncing ? 'Backing up…' : online ? 'Connected' : 'Offline. Safe to keep selling'}</div>
                <small>
                  {pendingSync === 0
                    ? 'All records are saved on this device and backed up.'
                    : `${pendingSync} change(s) saved on-device, waiting to back up. They will go through automatically; do nothing.`}
                </small>
              </div>

              <div className="settings-block mpesa-settings">
                <h3>M-Pesa connection</h3>
                <small className="muted">
                  {mpesaStatus.configured
                    ? mpesaStatus.maskedSecret
                      ? `Daraja key on file: ${mpesaStatus.maskedSecret}. Stored on the server only`
                      : 'Daraja credentials are stored on the server only.'
                    : 'Not configured yet. Your Daraja key/secret are sent once over HTTPS and never stored on this device.'}
                </small>
                {mpesaFormOpen ? (
                  <div className="mpesa-form">
                    <input
                      value={mpesaForm.shortCode}
                      onChange={(event) => setMpesaForm((current) => ({ ...current, shortCode: event.target.value }))}
                      placeholder="Till / Paybill number"
                      inputMode="numeric"
                    />
                    <input
                      value={mpesaForm.consumerKey}
                      onChange={(event) => setMpesaForm((current) => ({ ...current, consumerKey: event.target.value }))}
                      placeholder="Daraja consumer key"
                    />
                    <input
                      type="password"
                      value={mpesaForm.consumerSecret}
                      onChange={(event) => setMpesaForm((current) => ({ ...current, consumerSecret: event.target.value }))}
                      placeholder={mpesaStatus.configured ? 'Re-enter secret to replace it' : 'Daraja consumer secret'}
                      autoComplete="off"
                    />
                    {mpesaFormError && <p className="error-text">{mpesaFormError}</p>}
                    <button type="button" className="primary" onClick={() => void submitMpesaCredentials()}>
                      Save to server
                    </button>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => {
                        setMpesaFormOpen(false)
                        setMpesaForm({ shortCode: '', consumerKey: '', consumerSecret: '' })
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button type="button" onClick={() => void openMpesaForm()}>
                    {mpesaStatus.configured ? 'Replace credentials' : 'Set up M-Pesa'}
                  </button>
                )}
              </div>

              <div className="settings-block etims-settings">
                <h3>KRA eTIMS</h3>
                {business.kraPin && business.etimsDeviceSerial ? (
                  <>
                    <small className="muted">
                      Invoices go to KRA automatically as you sell (queued while offline). KRA PIN: {business.kraPin} ·
                      Branch: {business.etimsBhfId ?? '00'}
                    </small>
                    <ul className="etims-invoice-list">
                      {business.sales
                        .filter((sale) => sale.etims?.invcNo)
                        .slice(-5)
                        .reverse()
                        .map((sale) => (
                          <li key={sale.id}>
                            #{sale.etims?.invcNo} · KES {sale.total} · {sale.etims?.controlNumber ?? sale.etims?.status}
                          </li>
                        ))}
                    </ul>
                  </>
                ) : (
                  <small className="muted">
                    Not set up yet. Register for eTIMS on iTax first (outside this app), then enter your details here.
                    Still onboarding with KRA? You can invoice manually with eTIMS Lite on your phone: dial *222#.
                  </small>
                )}
                {etimsFormOpen ? (
                  <div className="etims-form">
                    <input
                      value={etimsForm.kraPin}
                      onChange={(event) => setEtimsForm((current) => ({ ...current, kraPin: event.target.value }))}
                      placeholder="KRA PIN (A012345678Z)"
                    />
                    <div className="form-row inline-fields">
                      <input
                        value={etimsForm.bhfId}
                        onChange={(event) => setEtimsForm((current) => ({ ...current, bhfId: event.target.value }))}
                        placeholder="Branch (00)"
                      />
                      <input
                        value={etimsForm.deviceSerial}
                        onChange={(event) =>
                          setEtimsForm((current) => ({ ...current, deviceSerial: event.target.value }))
                        }
                        placeholder="Device serial (from iTax)"
                      />
                    </div>
                    <button type="button" className="primary" onClick={() => void submitEtimsSetup()}>
                      Save eTIMS details
                    </button>
                    <button type="button" className="link-button" onClick={() => setEtimsFormOpen(false)}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button type="button" onClick={() => setEtimsFormOpen(true)}>
                    {business.kraPin ? 'Update eTIMS details' : 'Set up eTIMS'}
                  </button>
                )}
              </div>
            </section>
          )}
        </main>
      </div>
    </div>
  )
}

export default App
