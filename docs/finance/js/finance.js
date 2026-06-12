/**
 * finance.js
 * Expense, budget, settlement, and chart module.
 * Supports both:
 * - room-based schema: expenses(room_id), budgets(room_id)
 * - legacy schema without room_id
 */

'use strict';

const CATEGORIES = [
  { key: 'accommodation', label: '숙박', color: '#00658d', cssClass: 'cat-accommodation' },
  { key: 'food', label: '식비', color: '#f59e0b', cssClass: 'cat-food' },
  { key: 'transport', label: '교통', color: '#10b981', cssClass: 'cat-transport' },
  { key: 'activity', label: '활동', color: '#8b5cf6', cssClass: 'cat-activity' },
  { key: 'shopping', label: '쇼핑', color: '#ec4899', cssClass: 'cat-shopping' },
  { key: 'etc', label: '기타', color: '#6b7280', cssClass: 'cat-etc' },
];

let currentUser = null;
let expenses = [];
let budget = 0;
let roomId = new URLSearchParams(location.search).get('roomId');
let pieChart = null;
let editingId = null;

const expenseForm = document.querySelector('#expense-form');
const expenseList = document.querySelector('#expense-list');
const budgetForm = document.querySelector('#budget-form');
const budgetBar = document.querySelector('#budget-bar');
const budgetPct = document.querySelector('#budget-pct');
const budgetRemain = document.querySelector('#budget-remain');
const settlementBox = document.querySelector('#settlement-list');
const chartCanvas = document.querySelector('#pie-chart');
const chartTotal = document.querySelector('#chart-total');
const legendBox = document.querySelector('#chart-legend');
const toastEl = document.querySelector('#toast');
const finUserStatus = document.querySelector('#fin-user-status');
const finLogoutBtn = document.querySelector('#fin-logout-btn');
const finEditWrapper = document.querySelector('#fin-edit-form-wrapper');
const finEditCancelBtn = document.querySelector('#fin-edit-cancel-btn');
const finEditForm = document.querySelector('#edit-expense-form');
const statTotal = document.querySelector('#stat-total');
const statCount = document.querySelector('#stat-count');
const statAvg = document.querySelector('#stat-avg');
const statMax = document.querySelector('#stat-max');

let financeInitialized = false;
let financeInitializing = false;

document.addEventListener('DOMContentLoaded', () => { initFinance(); });

async function initFinance() {
  if (financeInitialized) {
    await loadBudget();
    await loadExpenses();
    return;
  }
  if (financeInitializing) return;
  financeInitializing = true;

  expenseForm?.addEventListener('submit', handleAddExpense);
  budgetForm?.addEventListener('submit', handleSaveBudget);
  finEditForm?.addEventListener('submit', handleEditExpense);
  finEditCancelBtn?.addEventListener('click', cancelEdit);
  finLogoutBtn?.addEventListener('click', handleLogout);

  buildCategoryOptions();

  try {
    supabaseClient.auth.onAuthStateChange((event, session) => {
      if (event === 'INITIAL_SESSION' && !session?.user) return;
      if (event === 'SIGNED_OUT') {
        try {
          const raw = localStorage.getItem('sb-session');
          if (raw && JSON.parse(raw)?.user?.id) return;
        } catch {}
      }
      currentUser = session?.user ?? null;
      renderAuthUI();
    });
  } catch {}

  try {
    await checkAuthState();
  } catch {}

  await loadBudget();
  await loadExpenses();

  financeInitialized = true;
  financeInitializing = false;
}

async function checkAuthState() {
  const { data: { user } } = await supabaseClient.auth.getUser();
  currentUser = user;
  renderAuthUI();
}

function renderAuthUI() {
  if (!finUserStatus || !finLogoutBtn) return;
  if (currentUser) {
    finUserStatus.textContent = currentUser.email;
    finLogoutBtn.classList.remove('d-none');
  } else {
    finUserStatus.textContent = '';
    finLogoutBtn.classList.add('d-none');
  }
}

async function handleLogout() {
  await supabaseClient.auth.signOut();
  showToast(MSG.auth.logoutSuccess);
}

function buildCategoryOptions() {
  ['#add-category', '#edit-category'].forEach((selector) => {
    const select = document.querySelector(selector);
    if (!select || select.dataset.optionsBuilt === '1') return;
    CATEGORIES.forEach(({ key, label }) => {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = label;
      select.append(option);
    });
    select.dataset.optionsBuilt = '1';
  });
}

function hasFinanceRoomContext() {
  return isUuid(roomId);
}

async function loadBudget() {
  try {
    let query = supabaseClient
      .from('budgets')
      .select('amount, created_at')
      .order('created_at', { ascending: false })
      .limit(1);

    if (hasFinanceRoomContext()) {
      query = query.eq('room_id', roomId);
    }

    let { data, error } = await query;
    if (error && hasFinanceRoomContext() && shouldRetryFinanceRoomQuery(error)) {
      ({ data, error } = await supabaseClient
        .from('budgets')
        .select('amount, created_at')
        .order('created_at', { ascending: false })
        .limit(1));
    }

    if (error) throw error;
    budget = data?.[0]?.amount ?? 0;
  } catch {
    budget = 0;
  }

  const input = document.querySelector('#budget-input');
  if (input) input.value = budget || '';
  updateBudgetUI();
}

async function handleSaveBudget(event) {
  event.preventDefault();

  const amount = Number(document.querySelector('#budget-input')?.value);
  if (!amount || amount <= 0) {
    showToast(MSG.budget.inputRequired);
    return;
  }
  if (!currentUser) {
    showToast(MSG.auth.notLoggedIn);
    return;
  }

  let { error } = await supabaseClient
    .from('budgets')
    .insert(buildBudgetPayload(amount, currentUser.id));

  if (error && hasFinanceRoomContext() && shouldRetryFinanceRoomQuery(error)) {
    ({ error } = await supabaseClient
      .from('budgets')
      .insert({ amount, user_id: currentUser.id }));
  }

  if (error) {
    console.error('budget insert failed:', error);
    showToast(MSG.budget.saveFail || '예산 저장에 실패했습니다.');
    return;
  }

  budget = amount;
  showToast(MSG.budget.saveSuccess);
  updateBudgetUI();
}

function updateBudgetUI() {
  if (!budgetBar || !budgetPct || !budgetRemain) return;

  const totalSpent = expenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
  if (!budget) {
    budgetBar.style.width = '0%';
    budgetBar.classList.remove('over-budget');
    budgetPct.textContent = '예산 미설정';
    budgetRemain.textContent = '';
    return;
  }

  const pct = Math.min((totalSpent / budget) * 100, 100).toFixed(1);
  const remain = budget - totalSpent;

  budgetBar.style.width = `${pct}%`;
  budgetPct.textContent = `${pct}% 사용`;

  if (totalSpent > budget) {
    budgetBar.classList.add('over-budget');
    budgetRemain.textContent = `${formatKRW(Math.abs(remain))} 초과`;
    budgetRemain.style.color = '#ba1a1a';
  } else {
    budgetBar.classList.remove('over-budget');
    budgetRemain.textContent = `잔액 ${formatKRW(remain)}`;
    budgetRemain.style.color = '';
  }
}

async function loadExpenses() {
  try {
    let query = supabaseClient
      .from('expenses')
      .select('*')
      .order('expense_date', { ascending: false });

    if (hasFinanceRoomContext()) {
      query = query.eq('room_id', roomId);
    }

    let { data, error } = await query;
    if (error && hasFinanceRoomContext() && shouldRetryFinanceRoomQuery(error)) {
      ({ data, error } = await supabaseClient
        .from('expenses')
        .select('*')
        .order('expense_date', { ascending: false }));
    }

    if (error) throw error;
    expenses = data || [];
  } catch {
    expenses = [];
  }

  finRenderAll();
}

function finRenderAll() {
  renderExpenseList();
  renderPieChart();
  renderSettlement();
  renderStats();
  updateBudgetUI();
}

function renderExpenseList() {
  if (!expenseList) return;
  if (!expenses.length) {
    expenseList.innerHTML = `<p class="text-center text-muted py-4">${MSG.expense.noData}</p>`;
    return;
  }

  expenseList.innerHTML = expenses.map((expense) => {
    const category = CATEGORIES.find((item) => item.key === expense.category) ?? CATEGORIES.at(-1);
    const canManage = !!currentUser;

    return `
      <div class="expense-row d-flex align-items-start gap-3 p-3 border-bottom animate-in" data-id="${expense.id}">
        <div class="text-muted small flex-shrink-0" style="min-width:76px;">${escapeHtml(expense.expense_date)}</div>
        <div class="flex-grow-1">
          <span class="category-badge ${category.cssClass}">${category.label}</span>
          <span class="ms-2">${escapeHtml(expense.description)}</span>
          ${expense.payer ? `<small class="text-muted ms-2">결제: ${escapeHtml(expense.payer)}</small>` : ''}
        </div>
        <div class="amount-text flex-shrink-0">${formatKRW(expense.amount)}</div>
        ${canManage ? `
          <div class="d-flex gap-1 flex-shrink-0">
            <button class="btn btn-sm btn-outline-secondary" onclick="startEdit('${expense.id}')">수정</button>
            <button class="btn btn-sm btn-outline-danger" onclick="deleteExpense('${expense.id}')">삭제</button>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

async function handleAddExpense(event) {
  try {
    event.preventDefault();
    if (!currentUser) {
      showToast(MSG.auth.notLoggedIn);
      return;
    }

    const formData = new FormData(event.target);
    const expense_date = formData.get('expense_date')?.trim();
    const category = formData.get('category');
    const amount = Number(formData.get('amount'));
    const description = formData.get('description')?.trim();
    const payer = formData.get('payer')?.trim() || null;

    if (!expense_date || !category || !description) {
      showToast(MSG.expense.inputRequired);
      return;
    }
    if (!amount || amount <= 0) {
      showToast(MSG.expense.amountInvalid);
      return;
    }

    let { error } = await supabaseClient
      .from('expenses')
      .insert(buildExpensePayload({ expense_date, category, amount, description, payer, user_id: currentUser.id }));

    if (error && hasFinanceRoomContext() && shouldRetryFinanceRoomQuery(error)) {
      ({ error } = await supabaseClient
        .from('expenses')
        .insert({ expense_date, category, amount, description, payer, user_id: currentUser.id }));
    }

    if (error) throw error;

    event.target.reset();
    await loadExpenses();
    showToast(MSG.expense.addSuccess);
  } catch (error) {
    console.error('expense insert failed:', error);
    showToast(MSG.common.networkError);
  }
}

function startEdit(id) {
  const expense = expenses.find((item) => String(item.id) === String(id));
  if (!expense || !finEditForm) return;

  editingId = id;
  finEditForm.querySelector('[name="edit-date"]').value = expense.expense_date;
  finEditForm.querySelector('[name="edit-category"]').value = expense.category;
  finEditForm.querySelector('[name="edit-amount"]').value = expense.amount;
  finEditForm.querySelector('[name="edit-description"]').value = expense.description;
  finEditForm.querySelector('[name="edit-payer"]').value = expense.payer ?? '';

  finEditWrapper?.classList.remove('d-none');
  finEditWrapper?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function handleEditExpense(event) {
  event.preventDefault();
  if (!editingId || !currentUser) {
    showToast(MSG.auth.notLoggedIn);
    return;
  }

  const formData = new FormData(event.target);
  const expense_date = formData.get('edit-date')?.trim();
  const category = formData.get('edit-category');
  const amount = Number(formData.get('edit-amount'));
  const description = formData.get('edit-description')?.trim();
  const payer = formData.get('edit-payer')?.trim() || null;

  if (!expense_date || !category || !description || !amount || amount <= 0) {
    showToast(MSG.expense.inputRequired);
    return;
  }

  let query = supabaseClient
    .from('expenses')
    .update({ expense_date, category, amount, description, payer })
    .eq('id', editingId)
    .eq('user_id', currentUser.id);

  if (hasFinanceRoomContext()) {
    query = query.eq('room_id', roomId);
  }

  let { error } = await query;
  if (error && hasFinanceRoomContext() && shouldRetryFinanceRoomQuery(error)) {
    ({ error } = await supabaseClient
      .from('expenses')
      .update({ expense_date, category, amount, description, payer })
      .eq('id', editingId)
      .eq('user_id', currentUser.id));
  }

  if (error) {
    console.error('expense update failed:', error);
    showToast('지출 수정에 실패했습니다.');
    return;
  }

  cancelEdit();
  await loadExpenses();
  showToast(MSG.expense.editSuccess);
}

function cancelEdit() {
  editingId = null;
  finEditWrapper?.classList.add('d-none');
  finEditForm?.reset();
}

async function deleteExpense(id) {
  if (!confirm(MSG.expense.deleteConfirm)) return;
  if (!currentUser) {
    showToast(MSG.auth.notLoggedIn);
    return;
  }

  let query = supabaseClient
    .from('expenses')
    .delete()
    .eq('id', id)
    .eq('user_id', currentUser.id);

  if (hasFinanceRoomContext()) {
    query = query.eq('room_id', roomId);
  }

  let { error } = await query;
  if (error && hasFinanceRoomContext() && shouldRetryFinanceRoomQuery(error)) {
    ({ error } = await supabaseClient
      .from('expenses')
      .delete()
      .eq('id', id)
      .eq('user_id', currentUser.id));
  }

  if (error) {
    console.error('expense delete failed:', error);
    showToast('지출 삭제에 실패했습니다.');
    return;
  }

  await loadExpenses();
}

function renderPieChart() {
  if (!chartCanvas) return;

  const totals = CATEGORIES.map((category) => ({
    ...category,
    total: expenses
      .filter((expense) => expense.category === category.key)
      .reduce((sum, expense) => sum + Number(expense.amount || 0), 0),
  })).filter((category) => category.total > 0);

  const grandTotal = totals.reduce((sum, category) => sum + category.total, 0);
  if (chartTotal) chartTotal.textContent = formatKRW(grandTotal);

  if (pieChart) {
    pieChart.destroy();
    pieChart = null;
  }

  if (!totals.length) {
    if (legendBox) legendBox.innerHTML = '<p class="text-muted small">지출 내역을 추가하면 차트가 표시됩니다.</p>';
    return;
  }

  pieChart = new Chart(chartCanvas, {
    type: 'doughnut',
    data: {
      labels: totals.map((category) => category.label),
      datasets: [{
        data: totals.map((category) => category.total),
        backgroundColor: totals.map((category) => category.color),
        borderWidth: 2,
        borderColor: '#fff',
        hoverOffset: 8,
      }],
    },
    options: {
      cutout: '68%',
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${formatKRW(ctx.parsed)} (${((ctx.parsed / grandTotal) * 100).toFixed(1)}%)`,
          },
        },
      },
    },
  });

  if (legendBox) {
    legendBox.innerHTML = totals.map((category) => `
      <div class="d-flex align-items-center gap-2 mb-1">
        <span class="legend-dot" style="background:${category.color};"></span>
        <span class="small flex-grow-1">${category.label}</span>
        <span class="small fw-semibold">${formatKRW(category.total)}</span>
        <span class="small text-muted">(${((category.total / grandTotal) * 100).toFixed(1)}%)</span>
      </div>
    `).join('');
  }
}

function renderSettlement() {
  if (!settlementBox) return;
  if (!expenses.length) {
    settlementBox.innerHTML = `<p class="text-muted small">${MSG.settlement.noExpense}</p>`;
    return;
  }

  const payerMap = {};
  expenses.forEach(({ payer, amount }) => {
    const name = payer || '미정';
    payerMap[name] = (payerMap[name] ?? 0) + Number(amount || 0);
  });

  const payers = Object.keys(payerMap);
  const total = Object.values(payerMap).reduce((sum, value) => sum + value, 0);
  const fair = total / payers.length;

  const balances = payers.map((name) => ({
    name,
    balance: payerMap[name] - fair,
  }));

  const creditors = balances.filter((item) => item.balance > 0).sort((a, b) => b.balance - a.balance);
  const debtors = balances.filter((item) => item.balance < 0).sort((a, b) => a.balance - b.balance);

  const transfers = [];
  const cred = creditors.map((item) => ({ ...item }));
  const debt = debtors.map((item) => ({ ...item }));

  let ci = 0;
  let di = 0;
  while (ci < cred.length && di < debt.length) {
    const amount = Math.min(cred[ci].balance, -debt[di].balance);
    if (amount > 0.5) {
      transfers.push({ from: debt[di].name, to: cred[ci].name, amount });
    }
    cred[ci].balance += debt[di].balance;
    debt[di].balance += cred[ci].balance < 0 ? cred[ci].balance : 0;
    if (Math.abs(cred[ci].balance) < 0.5) ci++;
    if (Math.abs(debt[di].balance) < 0.5) di++;
  }

  if (!transfers.length) {
    settlementBox.innerHTML = `<p class="text-success fw-semibold">${MSG.settlement.perfect}</p>`;
    return;
  }

  settlementBox.innerHTML = `
    <p class="small text-muted mb-2">1인당 부담 <strong>${formatKRW(Math.round(fair))}</strong></p>
    ${transfers.map((transfer) => `
      <div class="settlement-item animate-in">
        <span class="fw-semibold">${escapeHtml(transfer.from)}</span>
        <span class="settlement-arrow">→</span>
        <span class="fw-semibold">${escapeHtml(transfer.to)}</span>
        <span class="settlement-amount ms-auto">${formatKRW(Math.round(transfer.amount))}</span>
      </div>
    `).join('')}
  `;
}

function renderStats() {
  const total = expenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
  const count = expenses.length;
  const avg = count ? Math.round(total / count) : 0;
  const max = count ? Math.max(...expenses.map((expense) => Number(expense.amount || 0))) : 0;

  if (statTotal) statTotal.textContent = formatKRW(total);
  if (statCount) statCount.textContent = `${count}건`;
  if (statAvg) statAvg.textContent = formatKRW(avg);
  if (statMax) statMax.textContent = formatKRW(max);
}

function buildExpensePayload({ expense_date, category, amount, description, payer, user_id }) {
  const payload = { expense_date, category, amount, description, payer, user_id };
  if (hasFinanceRoomContext()) payload.room_id = roomId;
  return payload;
}

function buildBudgetPayload(amount, userId) {
  const payload = { amount, user_id: userId };
  if (hasFinanceRoomContext()) payload.room_id = roomId;
  return payload;
}

function shouldRetryFinanceRoomQuery(error) {
  const text = `${error?.message || ''} ${error?.details || ''} ${error?.hint || ''}`.toLowerCase();
  return text.includes('room_id') || text.includes('column') || text.includes('schema cache');
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function formatKRW(amount) {
  return `₩${Number(amount ?? 0).toLocaleString('ko-KR')}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function showToast(message) {
  if (!toastEl) {
    alert(message);
    return;
  }
  toastEl.querySelector('.toast-body').textContent = message;
  bootstrap.Toast.getOrCreateInstance(toastEl).show();
}
