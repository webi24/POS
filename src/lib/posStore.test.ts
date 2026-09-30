import { beforeEach, describe, expect, it } from 'vitest'
import {
  addBusiness,
  addBranch,
  addCapitalInjection,
  addExpense,
  addProduct,
  applyCreditRepayment,
  branchByIdOr,
  branchScope,
  completeSale,
  createInitialState,
  enqueueSyncAction,
  exportCustomersCsv,
  exportSalesCsv,
  exportStockCsv,
  financeRangeFor,
  financeReportForRange,
  filteredExpenses,
  getBusinessScope,
  businessesVisibleTo,
  parseBulkProductCsv,
  pendingSyncCount,
  productPerformanceForRange,
  recentSalesForFeed,
  recordStaff,
  removeStaff,
  recordStockAdjustment,
  refundSale,
  setAppState,
  setStartingCapital,
  stockForBranch,
  summarizeSalesForDay,
  verifyStaffPinForBranch,
  withBranchScope,
  revenueByDayForRange,
  localDayKey,
  todayKey,
  totalCapitalInvested,
  undoSale,
  verifyStaffPin,
  type Sale,
} from './posStore'

describe('offline POS store', () => {
  let state: ReturnType<typeof createInitialState>

  beforeEach(() => {
    state = createInitialState()
    setAppState(state)
  })

  it('completes a sale, updates stock, and records split payment correctly', () => {
    const business = addBusiness(state, {
      id: 'biz-1',
      name: 'Kisumu Grocery',
      type: 'shop',
      mpesaShortCode: '174379',
    })

    addProduct(business, {
      id: 'p-1',
      name: 'Maize Flour',
      category: 'Food',
      price: 120,
      costPrice: 90,
      stockQuantity: 10,
      unitOfMeasure: 'pack',
      lowStockAlert: 3,
    })

    const sale = completeSale(business, {
      id: 'sale-1',
      items: [{ productId: 'p-1', quantity: 2, unitPrice: 120 }],
      payments: { cash: 80, mpesa: 80, credit: 80 },
      customerId: 'cust-1',
    })

    expect(sale.total).toBe(240)
    expect(business.products[0].stockQuantity).toBe(8)
    expect(business.sales[0].payments).toEqual({ cash: 80, mpesa: 80, credit: 80 })
  })

  it('refuses a sale that exceeds available stock', () => {
    const business = addBusiness(state, {
      id: 'biz-stock',
      name: 'Stock Shop',
      type: 'shop',
      mpesaShortCode: '1',
    })
    addProduct(business, {
      id: 'p-1',
      name: 'Soap',
      category: 'Home',
      price: 80,
      costPrice: 55,
      stockQuantity: 1,
      unitOfMeasure: 'piece',
      lowStockAlert: 1,
    })

    expect(() =>
      completeSale(business, {
        items: [{ productId: 'p-1', quantity: 2, unitPrice: 80 }],
        payments: { cash: 160, mpesa: 0, credit: 0 },
      }),
    ).toThrow(/Not enough stock/)
  })

  it('undoing a sale restores stock and reverses the credit balance', () => {
    const business = addBusiness(state, {
      id: 'biz-undo',
      name: 'Undo Shop',
      type: 'shop',
      mpesaShortCode: '1',
    })
    addProduct(business, {
      id: 'p-1',
      name: 'Sugar',
      category: 'Food',
      price: 200,
      costPrice: 150,
      stockQuantity: 5,
      unitOfMeasure: 'pack',
      lowStockAlert: 1,
    })
    business.customers.push({ id: 'cust-1', businessId: business.id, name: 'Otis', balance: 0 })

    const sale = completeSale(business, {
      id: 'sale-1',
      items: [{ productId: 'p-1', quantity: 3, unitPrice: 200 }],
      payments: { cash: 0, mpesa: 0, credit: 600 },
      customerId: 'cust-1',
    })

    expect(business.customers[0].balance).toBe(600)

    undoSale(business, sale.id)

    expect(business.products[0].stockQuantity).toBe(5)
    expect(business.customers[0].balance).toBe(0)
    expect(business.sales).toHaveLength(0)
  })

  it('records credit repayments into a customer ledger without leaking between businesses', () => {
    const businessA = addBusiness(state, {
      id: 'biz-a',
      name: 'A',
      type: 'pharmacy',
      mpesaShortCode: '1',
    })
    const businessB = addBusiness(state, {
      id: 'biz-b',
      name: 'B',
      type: 'shop',
      mpesaShortCode: '2',
    })

    businessA.customers.push({ id: 'cust-a', businessId: 'biz-a', name: 'Jane', balance: 200 })
    businessB.customers.push({ id: 'cust-b', businessId: 'biz-b', name: 'Juma', balance: 300 })

    const repaid = applyCreditRepayment(businessA, 'cust-a', 50)

    expect(repaid.balance).toBe(150)
    expect(businessB.customers[0].balance).toBe(300)
    expect(getBusinessScope(state, 'biz-a').customers[0].balance).toBe(150)
  })

  it('rejects credit repayments that are zero or negative', () => {
    const business = addBusiness(state, {
      id: 'biz-c',
      name: 'C',
      type: 'shop',
      mpesaShortCode: '1',
    })
    business.customers.push({ id: 'cust-c', businessId: 'biz-c', name: 'Halima', balance: 100 })

    expect(() => applyCreditRepayment(business, 'cust-c', 0)).toThrow(/greater than zero/)
    expect(() => applyCreditRepayment(business, 'cust-c', -20)).toThrow(/greater than zero/)
  })

  it('verifies staff PINs only within the owning business', () => {
    const businessA = addBusiness(state, {
      id: 'biz-a',
      name: 'A',
      type: 'liquor',
      mpesaShortCode: '1',
    })
    const businessB = addBusiness(state, {
      id: 'biz-b',
      name: 'B',
      type: 'shop',
      mpesaShortCode: '2',
    })

    recordStaff(businessA, { id: 'staff-1', name: 'Mary', pin: '1234', shift: 'Morning' })
    recordStaff(businessB, { id: 'staff-2', name: 'John', pin: '4321', shift: 'Evening' })

    expect(verifyStaffPin(businessA, 'staff-1', '1234')?.name).toBe('Mary')
    expect(verifyStaffPin(businessA, 'staff-1', '9999')).toBeNull()
    expect(verifyStaffPin(businessA, 'staff-2', '4321')).toBeNull()
    expect(getBusinessScope(state, 'biz-a').staff).toHaveLength(1)
    expect(getBusinessScope(state, 'biz-b').staff).toHaveLength(1)
  })

  it('applies stock adjustments for every reason type and keeps an audit trail', () => {
    const business = addBusiness(state, {
      id: 'biz-adj',
      name: 'Adjust Shop',
      type: 'hardware',
      mpesaShortCode: '1',
    })
    addProduct(business, {
      id: 'p-1',
      name: 'Hammer',
      category: 'Tools',
      price: 500,
      costPrice: 350,
      stockQuantity: 10,
      unitOfMeasure: 'piece',
      lowStockAlert: 2,
    })

    const reasons = ['damage', 'theft', 'expired', 'delivery', 'count-correction'] as const
    const deltas = [-1, -2, -1, 5, 1]
    reasons.forEach((reason, index) => {
      recordStockAdjustment(business, { productId: 'p-1', reason, quantityDelta: deltas[index] })
    })

    expect(business.products[0].stockQuantity).toBe(12)
    expect(business.stockAdjustments).toHaveLength(5)
    expect(business.stockAdjustments.every((entry) => entry.businessId === 'biz-adj')).toBe(true)
  })

  it('summarizes only today’s sales for the daily report', () => {
    const business = addBusiness(state, {
      id: 'biz-sum',
      name: 'Summary Shop',
      type: 'shop',
      mpesaShortCode: '1',
    })
    addProduct(business, {
      id: 'p-1',
      name: 'Milk',
      category: 'Fresh',
      price: 60,
      costPrice: 45,
      stockQuantity: 50,
      unitOfMeasure: 'pack',
      lowStockAlert: 5,
    })
    recordStaff(business, { id: 'staff-1', name: 'Mary', pin: '1234', shift: 'Morning' })

    const today = new Date()
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000)

    const todaySale = completeSale(business, {
      id: 'sale-today',
      items: [{ productId: 'p-1', quantity: 2, unitPrice: 60 }],
      payments: { cash: 120, mpesa: 0, credit: 0 },
      attendantId: 'staff-1',
    })
    todaySale.createdAt = today.toISOString()

    const oldSale = completeSale(business, {
      id: 'sale-old',
      items: [{ productId: 'p-1', quantity: 10, unitPrice: 60 }],
      payments: { cash: 600, mpesa: 0, credit: 0 },
      attendantId: 'staff-1',
    })
    oldSale.createdAt = yesterday.toISOString()

    const dayKey = `${today.getFullYear()}-${`${today.getMonth() + 1}`.padStart(2, '0')}-${`${today.getDate()}`.padStart(2, '0')}`
    const summary = summarizeSalesForDay(business, dayKey)

    expect(summary.totalSales).toBe(120)
    expect(summary.cash).toBe(120)
    expect(summary.topItems[0]).toEqual({ name: 'Milk', quantity: 2 })
    expect(summary.attendants.Mary).toBe(120)
  })

  it('parses bulk product CSV rows and reports bad lines', () => {
    const { rows, errors } = parseBulkProductCsv(
      ['Milk, Fresh, 60, 30, 45, piece', 'Bread, Food, 55, 10', 'Bad line', 'Eggs, Fresh, abc, 12'].join('\n'),
    )

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ name: 'Milk', price: 60, stockQuantity: 30, unitOfMeasure: 'piece' })
    expect(rows[1]).toMatchObject({ name: 'Bread', price: 55, stockQuantity: 10, unitOfMeasure: 'piece' })
    expect(errors).toHaveLength(2)
    expect(errors[0]).toContain('Line 3')
    expect(errors[1]).toContain('abc')
  })

  it('exports sales, stock, and customers as CSV the owner can open anywhere', () => {
    const business = addBusiness(state, {
      id: 'biz-exp',
      name: 'Export Shop',
      type: 'shop',
      mpesaShortCode: '1',
    })
    addProduct(business, {
      id: 'p-1',
      name: 'Soap',
      category: 'Home',
      price: 80,
      costPrice: 55,
      stockQuantity: 14,
      unitOfMeasure: 'piece',
      lowStockAlert: 4,
    })
    business.customers.push({ id: 'cust-1', businessId: 'biz-exp', name: 'Aisha', phone: '0712345678', balance: 250 })
    completeSale(business, {
      id: 'sale-1',
      items: [{ productId: 'p-1', quantity: 1, unitPrice: 80 }],
      payments: { cash: 80, mpesa: 0, credit: 0 },
      customerId: 'cust-1',
    })

    const salesCsv = exportSalesCsv(business)
    expect(salesCsv.split('\n')[0]).toContain('cash,mpesa,credit')
    expect(salesCsv).toContain('sale-1')

    const stockCsv = exportStockCsv(business)
    expect(stockCsv.split('\n')[0]).toContain('stockQuantity')
    expect(stockCsv).toContain('Soap')

    const customersCsv = exportCustomersCsv(business)
    expect(customersCsv).toContain('Aisha')
    expect(customersCsv).toContain('0712345678')
  })

  it('shows the switcher only businesses the session owns or staffs', () => {
    const bizA = addBusiness(state, { id: 'biz-a', name: 'A', type: 'shop', mpesaShortCode: '1' })
    const bizB = addBusiness(state, { id: 'biz-b', name: 'B', type: 'shop', mpesaShortCode: '2' })
    bizA.ownerEmail = 'a@test.co.ke'
    bizB.ownerEmail = 'b@test.co.ke'
    recordStaff(bizA, { id: 'staff-a1', name: 'Mary', pin: '1234', shift: 'Morning' })
    recordStaff(bizB, { id: 'staff-b1', name: 'Juma', pin: '5678', shift: 'Evening' })

    // Owner A sees only A (even if B exists on the same device).
    expect(
      businessesVisibleTo(state.businesses, { ownerEmail: 'a@test.co.ke', ownerBusinessId: 'biz-a' }).map((b) => b.id),
    ).toEqual(['biz-a'])

    // Attendant of A sees only A.
    expect(businessesVisibleTo(state.businesses, { staffId: 'staff-a1' }).map((b) => b.id)).toEqual(['biz-a'])

    // No session (first run / demo) sees everything on the device.
    expect(businessesVisibleTo(state.businesses, null)).toHaveLength(2)
  })

  it('never queues Daraja secrets in sync payloads', () => {
    addBusiness(state, { id: 'biz-sec', name: 'Secret Shop', type: 'shop', mpesaShortCode: '174379' })

    const serialized = JSON.stringify(state.syncQueue)
    expect(serialized).not.toContain('consumerKey')
    expect(serialized).not.toContain('consumerSecret')
    expect(serialized).not.toContain('mpesaConfig')
  })

  it('queues every offline action with a unique id and per-business scope', () => {
    const businessA = addBusiness(state, {
      id: 'biz-a',
      name: 'A',
      type: 'shop',
      mpesaShortCode: '1',
    })
    const businessB = addBusiness(state, {
      id: 'biz-b',
      name: 'B',
      type: 'shop',
      mpesaShortCode: '2',
    })

    addProduct(businessA, {
      name: 'Item A',
      category: 'General',
      price: 10,
      costPrice: 5,
      stockQuantity: 5,
      unitOfMeasure: 'piece',
      lowStockAlert: 1,
    })
    enqueueSyncAction(state, businessB.id, 'product-added', { productId: 'x' })

    expect(pendingSyncCount(state)).toBe(3) // 2 business-created + 1 manual enqueue
    const ids = new Set(state.syncQueue.map((item) => item.id))
    expect(ids.size).toBe(state.syncQueue.length)
    expect(state.syncQueue.every((item) => item.businessId === 'biz-a' || item.businessId === 'biz-b')).toBe(true)
  })
})

describe('owner finance dashboard', () => {
  let state: ReturnType<typeof createInitialState>

  beforeEach(() => {
    state = createInitialState()
    setAppState(state)
  })

  const setupBusiness = () => {
    const business = addBusiness(state, { id: 'biz-fin', name: 'Fin Test', type: 'shop' })
    setStartingCapital(state, business, 10_000)
    // Two products with deliberately different margins and prices so the
    // quantity/revenue/profit rankings can genuinely diverge.
    addProduct(business, {
      id: 'p-cheap', name: 'Candy', category: 'Food', price: 10, costPrice: 4,
      stockQuantity: 100, unitOfMeasure: 'piece', lowStockAlert: 5,
    })
    addProduct(business, {
      id: 'p-dear', name: 'Cooking Oil', category: 'Food', price: 400, costPrice: 380,
      stockQuantity: 50, unitOfMeasure: 'litre', lowStockAlert: 5,
    })
    addProduct(business, {
      id: 'p-dead', name: 'Dead Stock Item', category: 'Home', price: 200, costPrice: 120,
      stockQuantity: 10, unitOfMeasure: 'piece', lowStockAlert: 2,
    })
    return business
  }

  it('hand-check: gross profit = revenue minus cost of goods across mixed sales', () => {
    const business = setupBusiness()

    // 3 candy (3x10=30 revenue, 3x4=12 cost) + 2 oil (2x400=800, 2x380=760)
    completeSale(business, {
      id: 'sale-1',
      items: [
        { productId: 'p-cheap', quantity: 3, unitPrice: 10 },
        { productId: 'p-dear', quantity: 2, unitPrice: 400 },
      ],
      payments: { cash: 830, mpesa: 0, credit: 0 },
    })

    const report = financeReportForRange(business, financeRangeFor('all'))
    expect(report.revenue).toBe(830)
    expect(report.costOfGoods).toBe(772) // 12 + 760
    expect(report.grossProfit).toBe(58) // 830 - 772 = (30-12) + (800-760) = 18 + 40
    expect(report.expenses).toBe(0)
    expect(report.netProfit).toBe(58) // no expenses yet: net equals gross
  })

  it('expenses reduce net profit only; gross profit stays untouched and separate', () => {
    const business = setupBusiness()
    completeSale(business, {
      id: 'sale-1',
      items: [{ productId: 'p-cheap', quantity: 5, unitPrice: 10 }],
      payments: { cash: 50, mpesa: 0, credit: 0 },
    })

    addExpense(state, business, { category: 'rent', amount: 3_000, note: 'March rent' })
    addExpense(state, business, { category: 'transport', amount: 200 })

    const report = financeReportForRange(business, financeRangeFor('all'))
    expect(report.grossProfit).toBe(30) // 5 x (10-4)
    expect(report.expenses).toBe(3_200)
    expect(report.netProfit).toBe(30 - 3_200)
    expect(report.expensesByCategory['rent']).toBe(3_000)
    expect(report.expensesByCategory['transport']).toBe(200)
  })

  it('refunds are their own visible line and remove the sale from revenue', () => {
    const business = setupBusiness()
    completeSale(business, {
      id: 'sale-1',
      items: [{ productId: 'p-dear', quantity: 1, unitPrice: 400 }],
      payments: { cash: 400, mpesa: 0, credit: 0 },
    })
    completeSale(business, {
      id: 'sale-2',
      items: [{ productId: 'p-cheap', quantity: 2, unitPrice: 10 }],
      payments: { cash: 20, mpesa: 0, credit: 0 },
    })

    refundSale(state, business, 'sale-1', 'customer changed mind')

    const report = financeReportForRange(business, financeRangeFor('all'))
    expect(report.revenue).toBe(20) // only sale-2 counts
    expect(report.refunds).toBe(400) // visible as its own line
    expect(report.grossProfit).toBe(12) // 2 x (10-4)
    expect(business.products.find((p) => p.id === 'p-dear')?.stockQuantity).toBe(50) // restocked
    expect(business.sales.find((s) => s.id === 'sale-1')?.refundedAt).toBeTruthy()
  })

  it('rejects refunding the same sale twice', () => {
    const business = setupBusiness()
    completeSale(business, {
      id: 'sale-1',
      items: [{ productId: 'p-cheap', quantity: 1, unitPrice: 10 }],
      payments: { cash: 10, mpesa: 0, credit: 0 },
    })
    refundSale(state, business, 'sale-1')
    expect(() => refundSale(state, business, 'sale-1')).toThrow(/already/)
  })

  it('rankings: quantity, revenue and profit leaders can all differ; dead stock shows as zeroSold', () => {
    const business = setupBusiness()
    // Candy: 15 units, KES 150 revenue, KES 90 profit.
    // Oil: 1 unit, KES 400 revenue, KES 20 profit.
    // So candy leads quantity AND profit, oil leads revenue: three views that
    // genuinely disagree, which is the point.
    completeSale(business, {
      id: 'sale-1',
      items: [
        { productId: 'p-cheap', quantity: 15, unitPrice: 10 },
        { productId: 'p-dear', quantity: 1, unitPrice: 400 },
      ],
      payments: { cash: 550, mpesa: 0, credit: 0 },
    })

    const perf = productPerformanceForRange(business, financeRangeFor('all'))
    const byQty = [...perf].sort((a, b) => b.quantitySold - a.quantitySold)
    const byRevenue = [...perf].sort((a, b) => b.revenue - a.revenue)
    const byProfit = [...perf].sort((a, b) => b.grossProfit - a.grossProfit)

    expect(byQty[0].productId).toBe('p-cheap') // 15 units
    expect(byRevenue[0].productId).toBe('p-dear') // KES 400
    expect(byProfit[0].productId).toBe('p-cheap') // KES 90

    const dead = perf.find((entry) => entry.productId === 'p-dead')
    expect(dead?.zeroSold).toBe(true)
    expect(dead?.quantitySold).toBe(0)
  })

  it('total invested = starting capital plus injections; ROI is cumulative since inception', () => {
    const business = setupBusiness()
    addCapitalInjection(state, business, { amount: 5_000, note: 'March stock top-up' })

    expect(totalCapitalInvested(business)).toBe(15_000) // 10k + 5k

    completeSale(business, {
      id: 'sale-1',
      items: [{ productId: 'p-cheap', quantity: 10, unitPrice: 10 }],
      payments: { cash: 100, mpesa: 0, credit: 0 },
    })
    addExpense(state, business, { category: 'wages', amount: 40 })

    const report = financeReportForRange(business, financeRangeFor('today'))
    expect(report.totalInvested).toBe(15_000)
    // Cumulative net = 60 profit - 40 wages = 20 -> 20 / 15,000 = 0.13%
    expect(report.roiPercent).toBeCloseTo(0.13, 1)
  })

  it('date ranges filter sales and expenses by their local day keys', () => {
    const business = setupBusiness()
    const old = new Date()
    old.setDate(old.getDate() - 10)
    const oldSale: Sale = {
      id: 'sale-old',
      businessId: business.id,
      items: [{ productId: 'p-cheap', quantity: 1, unitPrice: 10 }],
      payments: { cash: 10, mpesa: 0, credit: 0 },
      total: 10,
      createdAt: old.toISOString(),
    }
    business.sales.push(oldSale)

    completeSale(business, {
      id: 'sale-today',
      items: [{ productId: 'p-cheap', quantity: 2, unitPrice: 10 }],
      payments: { cash: 20, mpesa: 0, credit: 0 },
    })

    const todayReport = financeReportForRange(business, financeRangeFor('today'))
    expect(todayReport.revenue).toBe(20)

    const weekReport = financeReportForRange(business, financeRangeFor('week'))
    expect(weekReport.revenue).toBe(20) // 10 days ago is outside even a week

    const allReport = financeReportForRange(business, financeRangeFor('all'))
    expect(allReport.revenue).toBe(30)
  })

  it('queues sync actions for expenses, injections, refunds and capital changes', () => {
    const business = setupBusiness()
    completeSale(business, {
      id: 'sale-1',
      items: [{ productId: 'p-cheap', quantity: 1, unitPrice: 10 }],
      payments: { cash: 10, mpesa: 0, credit: 0 },
    })

    addExpense(state, business, { category: 'rent', amount: 1_000 })
    addCapitalInjection(state, business, { amount: 2_000 })
    refundSale(state, business, 'sale-1')
    setStartingCapital(state, business, 12_000)

    const actions = state.syncQueue.map((item) => item.action)
    expect(actions).toContain('expense-added')
    expect(actions).toContain('capital-injection-added')
    expect(actions).toContain('refund-added')
    expect(actions).toContain('capital-set')
  })
})

describe('finance trend data and custom ranges', () => {
  let state: ReturnType<typeof createInitialState>

  beforeEach(() => {
    state = createInitialState()
    setAppState(state)
  })

  const setupBusiness = () => {
    const business = addBusiness(state, { id: 'biz-trend', name: 'Trend Test', type: 'shop' })
    addProduct(business, {
      id: 'p-1', name: 'Tea', category: 'Food', price: 20, costPrice: 8,
      stockQuantity: 500, unitOfMeasure: 'piece', lowStockAlert: 5,
    })
    return business
  }

  it('revenueByDayForRange produces daily totals matching the report figures', () => {
    const business = setupBusiness()

    // Sell on today only: 5 x 20 = 100 revenue, 5 x 12 = 60 profit.
    completeSale(business, {
      id: 'sale-today',
      items: [{ productId: 'p-1', quantity: 5, unitPrice: 20 }],
      payments: { cash: 100, mpesa: 0, credit: 0 },
    })

    const week = financeRangeFor('week')
    const points = revenueByDayForRange(business, week)

    expect(points).toHaveLength(7) // one point per day, zeros included
    const todayPoint = points[points.length - 1]
    expect(todayPoint.day).toBe(todayKey())
    expect(todayPoint.revenue).toBe(100)
    expect(todayPoint.profit).toBe(60)
    // All other days are zero, so the report revenue equals the day sum.
    const report = financeReportForRange(business, week)
    expect(points.reduce((sum, point) => sum + point.revenue, 0)).toBe(report.revenue)
  })

  it('a refunded sale shows in neither revenue nor profit on the chart', () => {
    const business = setupBusiness()
    completeSale(business, {
      id: 'sale-1',
      items: [{ productId: 'p-1', quantity: 2, unitPrice: 20 }],
      payments: { cash: 40, mpesa: 0, credit: 0 },
    })
    refundSale(state, business, 'sale-1')

    const points = revenueByDayForRange(business, financeRangeFor('today'))
    expect(points[0].revenue).toBe(0)
    expect(points[0].profit).toBe(0)
  })

  it('custom ranges are honoured and tolerate a swapped start/end', () => {
    const business = setupBusiness()
    const old = new Date()
    old.setDate(old.getDate() - 5)
    business.sales.push({
      id: 'sale-old',
      businessId: business.id,
      items: [{ productId: 'p-1', quantity: 1, unitPrice: 20 }],
      payments: { cash: 20, mpesa: 0, credit: 0 },
      total: 20,
      createdAt: old.toISOString(),
    })

    const start = new Date()
    start.setDate(start.getDate() - 2)
    const custom = financeRangeFor('custom', {
      start: localDayKey(start.toISOString()),
      end: todayKey(),
    })
    const report = financeReportForRange(business, custom)
    expect(report.revenue).toBe(0) // 5 days ago is outside the custom window

    const swapped = financeRangeFor('custom', { start: todayKey(), end: '2020-01-01' })
    expect(swapped.start).toBe('2020-01-01')
    expect(swapped.end).toBe(todayKey())
  })

  it('filteredExpenses filters by category and range', () => {
    const business = setupBusiness()
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)

    addExpense(state, business, { category: 'rent', amount: 1_000 })
    addExpense(state, business, { category: 'wages', amount: 500, date: localDayKey(yesterday.toISOString()) })
    addExpense(state, business, { category: 'rent', amount: 200, date: localDayKey(yesterday.toISOString()) })

    const all = filteredExpenses(business, {})
    expect(all).toHaveLength(3)
    expect(all[0].date >= all[all.length - 1].date).toBe(true) // newest first

    const rentOnly = filteredExpenses(business, { category: 'rent' })
    expect(rentOnly).toHaveLength(2)
    expect(rentOnly.every((expense) => expense.category === 'rent')).toBe(true)

    const todayOnly = filteredExpenses(business, { range: financeRangeFor('today') })
    expect(todayOnly).toHaveLength(1)
    expect(todayOnly[0].amount).toBe(1_000)
  })

  it('removes staff and their login, and feeds recent sales newest first', () => {
    const business = setupBusiness()
    const a = recordStaff(business, { name: 'Asha', pin: '1111' })
    const b = recordStaff(business, { name: 'Baraka', pin: '2222' })
    expect(business.staff).toHaveLength(2) // Asha + Baraka

    expect(removeStaff(business, a.id)).toBe(true)
    expect(business.staff.some((entry) => entry.id === a.id)).toBe(false)
    expect(removeStaff(business, a.id)).toBe(false) // already gone
    expect(verifyStaffPin(business, a.id, '1111')).toBeNull() // login revoked
    expect(verifyStaffPin(business, b.id, '2222')).not.toBeNull() // others untouched

    // Live feed: newest first, attendant names resolved, refunded kept but tagged.
    const milk = addProduct(business, {
      id: 'p-milk', name: 'Milk', category: 'Food', price: 50, costPrice: 35,
      stockQuantity: 10, unitOfMeasure: 'piece', lowStockAlert: 2,
    })
    const saleA = completeSale(business, {
      items: [{ productId: milk.id, quantity: 2, unitPrice: 50 }],
      payments: { cash: 0, mpesa: 100, credit: 0 },
    })
    const saleB = completeSale(business, {
      items: [{ productId: milk.id, quantity: 1, unitPrice: 50 }],
      payments: { cash: 50, mpesa: 0, credit: 0 },
    })
    refundSale(state, business, saleB.id, 'changed mind')

    const feed = recentSalesForFeed(business, 5)
    expect(feed).toHaveLength(2) // refunded sales stay visible, tagged
    expect(feed[0].id).toBe(saleB.id)
    expect(feed[0].refunded).toBe(true)
    expect(feed[1].id).toBe(saleA.id)
    expect(feed[1].total).toBe(100)
    expect(feed[1].mpesa).toBe(100)
    expect(feed[1].refunded).toBe(false)
  })
})

describe('multi-branch support', () => {
  let state: ReturnType<typeof createInitialState>

  beforeEach(() => {
    state = createInitialState()
    setAppState(state)
  })

  const setupBusiness = () => {
    const business = addBusiness(state, { id: 'biz-mb', name: 'Two Towns', type: 'shop' })
    addProduct(business, {
      id: 'p-mb', name: 'Soap', category: 'Home', price: 80, costPrice: 55,
      stockQuantity: 40, unitOfMeasure: 'piece', lowStockAlert: 5,
    })
    return business
  }

  it('gives every business an implicit main branch and old records keep working', () => {
    const business = setupBusiness()
    expect(business.branches).toHaveLength(1)
    expect(business.branches[0].name).toBe('Main branch')

    // Pre-branch style sale (no branch tag) lands on the main branch.
    const sale = completeSale(business, {
      items: [{ productId: 'p-mb', quantity: 2, unitPrice: 80 }],
      payments: { cash: 160, mpesa: 0, credit: 0 },
    })
    expect(sale.branchId).toBeUndefined()
    expect(branchByIdOr(business, sale.branchId).id).toBe(business.branches[0].id)
  })

  it('keeps stock, sales and staff separate per branch while sharing one catalog', () => {
    const business = setupBusiness()
    const town = addBranch(state, business, 'Kisumu Town')
    const mamboleo = addBranch(state, business, 'Mamboleo')
    expect(business.branches).toHaveLength(3)

    // Deliver 30 soaps only to Mamboleo; main keeps its original 40.
    withBranchScope(mamboleo.id, () => {
      recordStockAdjustment(business, {
        productId: 'p-mb', reason: 'delivery', quantityDelta: 30,
        actor: { name: 'Owner', role: 'owner' },
      })
    })

    const product = business.products[0]
    expect(stockForBranch(business, product, mamboleo.id)).toBe(30)
    expect(stockForBranch(business, product, business.branches[0].id)).toBe(40)
    expect(stockForBranch(business, product, town.id)).toBe(0)

    // Selling at Mamboleo hits Mamboleo stock only.
    withBranchScope(mamboleo.id, () => {
      completeSale(business, {
        items: [{ productId: 'p-mb', quantity: 5, unitPrice: 80 }],
        payments: { cash: 400, mpesa: 0, credit: 0 },
      })
    })
    expect(stockForBranch(business, product, mamboleo.id)).toBe(25)
    expect(stockForBranch(business, product, business.branches[0].id)).toBe(40)

    // Sale is tagged to Mamboleo and branch scoping sees only it.
    const mamboleoScope = branchScope(business, mamboleo.id)
    expect(mamboleoScope.sales).toHaveLength(1)
    expect(mamboleoScope.sales[0].branchId).toBe(mamboleo.id)
    expect(branchScope(business, business.branches[0].id).sales).toHaveLength(0)
    expect(business.sales).toHaveLength(1) // one physical store of records

    // Staff belong to one branch each.
    const townStaff = recordStaff(business, { name: 'Asha', pin: '1111', branchId: town.id })
    const mbStaff = recordStaff(business, { name: 'Baraka', pin: '2222', branchId: mamboleo.id })

    // A Mamboleo PIN cannot open the Kisumu Town till.
    expect(verifyStaffPinForBranch(business, mbStaff.id, '2222', mamboleo.id)).not.toBeNull()
    expect(verifyStaffPinForBranch(business, mbStaff.id, '2222', town.id)).toBeNull()
    expect(verifyStaffPinForBranch(business, townStaff.id, '1111', town.id)).not.toBeNull()

    // Branch staff lists are scoped (fresh snapshot after hiring).
    const staffedScope = branchScope(business, mamboleo.id)
    expect(staffedScope.staff.some((s) => s.id === mbStaff.id)).toBe(true)
    expect(staffedScope.staff.some((s) => s.id === townStaff.id)).toBe(false)
  })

  it('cannot add two branches with the same name', () => {
    const business = setupBusiness()
    addBranch(state, business, 'Mamboleo')
    expect(() => addBranch(state, business, 'mamboleo')).toThrow()
  })
})
