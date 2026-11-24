const STORAGE_KEY = "lifeplan_data";
const LEGACY_DATA = (() => {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
})();

const categories = {
  food: { name: "Еда", color: "#7965ed" },
  transport: { name: "Транспорт", color: "#36b98a" },
  shopping: { name: "Покупки", color: "#f2ad55" },
  entertainment: { name: "Развлечения", color: "#ef7777" },
  study: { name: "Учёба", color: "#55a6df" },
  other: { name: "Другое", color: "#9293a5" }
};

let data = { ...LEGACY_DATA };

if (!Array.isArray(data.operations)) data.operations = [];
if (!data.goal || typeof data.goal !== "object") {
  data.goal = { name: "", amount: 0 };
}

let activeUserId = null;
let cloudSyncQueue = Promise.resolve();
let hasProEntitlement = false;
let proDashboardData = null;
let proDashboardRequestId = 0;
let isOperationsHistoryOpen = false;
const localProDemo = ["localhost", "127.0.0.1"].includes(window.location.hostname)
    && new URLSearchParams(window.location.search).get("pro_demo") === "1";
let localDemoBudgets = {
    "Еда": 18000,
    "Транспорт": 6000,
    "Покупки": 10000,
    "Дом": 32000,
    "Подписки": 1500,
    "Здоровье": 5000,
    "Другое": 7000
};

function saveData() {
  if (!activeUserId) return;
  const userId = activeUserId;
  const snapshot = JSON.parse(JSON.stringify(data));
  cloudSyncQueue = cloudSyncQueue.then(async () => {
    if (activeUserId !== userId) return;
    const operations = snapshot.operations.map(item => ({
      id: item.id,
      user_id: userId,
      name: item.name,
      amount: item.amount,
      type: item.type,
      category: item.category,
      date: item.date
    }));

    if (operations.length) {
      const { error } = await supabaseClient.from("operations").upsert(operations);
      if (error) throw error;
    }

    let deleteQuery = supabaseClient.from("operations").delete().eq("user_id", userId);
    if (operations.length) {
      deleteQuery = deleteQuery.not("id", "in", `(${operations.map(item => item.id).join(",")})`);
    }
    const { error: deleteError } = await deleteQuery;
    if (deleteError) throw deleteError;

    const { error: goalError } = await supabaseClient.from("goals").upsert({
      user_id: userId,
      name: snapshot.goal.name,
      amount: snapshot.goal.amount
    });
    if (goalError) throw goalError;
    return true;
  }).catch(error => {
    console.error("Не удалось сохранить данные в Supabase:", error);
    alert(`Не удалось сохранить данные в облако: ${error.message || "неизвестная ошибка"}`);
    return false;
  });
  return cloudSyncQueue.then(saved => {
    if (saved && hasProEntitlement && activeUserId === userId) refreshProDashboard();
    return saved;
  });
}

async function loadUserData(user) {
  if (!user) {
    activeUserId = null;
    proDashboardData = null;
    data = { operations: [], goal: { name: "", amount: 0 } };
    render();
    setProEntitlement(false);
    return;
  }

  const isSwitchingUser = activeUserId !== user.id;
  activeUserId = user.id;
  if (isSwitchingUser) proDashboardData = null;
  if (isSwitchingUser) setProEntitlement(false);
  const userId = user.id;
  try {
    const [{ data: operations, error: operationsError }, { data: goal, error: goalError }] = await Promise.all([
      supabaseClient.from("operations").select("id,name,amount,type,category,date").eq("user_id", userId).order("id", { ascending: false }),
      supabaseClient.from("goals").select("name,amount").eq("user_id", userId).maybeSingle()
    ]);
    if (operationsError) throw operationsError;
    if (goalError) throw goalError;
    if (activeUserId !== userId) return;

    const migrationKey = `lifeplan_migrated_${userId}`;
    const localOperations = Array.isArray(LEGACY_DATA.operations) ? LEGACY_DATA.operations : [];
    const localGoal = LEGACY_DATA.goal && typeof LEGACY_DATA.goal === "object"
      ? LEGACY_DATA.goal
      : { name: "", amount: 0 };
    const hasLegacyData = localOperations.length > 0 || Boolean(localGoal.name && Number(localGoal.amount) > 0);
    if (!operations.length && !goal && !localStorage.getItem(migrationKey) && hasLegacyData) {
      data = {
        operations: localOperations.map(item => ({
          ...item,
          id: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(item.id))
            ? item.id
            : crypto.randomUUID()
        })),
        goal: localGoal
      };
      if (await saveData()) localStorage.setItem(migrationKey, "true");
    } else {
      data = {
        operations: operations || [],
        goal: goal ? { name: goal.name, amount: Number(goal.amount) } : { name: "", amount: 0 }
      };
    }
    render();
    await refreshProEntitlement(userId);
  } catch (error) {
    console.error("Не удалось загрузить данные из Supabase:", error);
    alert(`Не удалось загрузить финансовые данные: ${error.message || "неизвестная ошибка"}`);
  }
}

function money(value) {
  return new Intl.NumberFormat("ru-RU").format(value) + " ₽";
}

// Добавление операции
function addOperation() {
  const name = document.getElementById("name").value.trim();
  const amount = Number(document.getElementById("amount").value);
  const type = document.getElementById("type").value;
  const category = document.getElementById("category").value.trim();

  if (!name || !category || !Number.isFinite(amount) || amount <= 0) {
    alert("Заполни все поля правильно!");
    return;
  }

  data.operations.unshift({
    id: crypto.randomUUID(),
    name,
    amount,
    type,
    category,
    date: new Date().toLocaleDateString("ru-RU")
  });

  saveData();

  document.getElementById("name").value = "";
  document.getElementById("amount").value = "";
  document.getElementById("category").value = "";

  render();
}

// Удаление операции
function deleteOperation(id) {
  data.operations = data.operations.filter(item => item.id !== id);
  saveData();
  render();
}

// Сохранение цели
function saveGoal() {
  const name = document.getElementById("goal").value.trim();
  const amount = Number(document.getElementById("goalAmount").value);

  if (!name || !Number.isFinite(amount) || amount <= 0) {
    alert("Укажи название и сумму цели!");
    return;
  }

  data.goal = { name, amount };

  saveData();
  render();
}

// Отображение цели
function renderGoal(balance) {
  const goal = data.goal;
  const info = document.getElementById("goalInfo");
  const bar = document.getElementById("goalBar");

  if (!goal.name || !goal.amount) {
    info.textContent = "Цель пока не установлена";
    bar.style.width = "0%";
    return;
  }

  const saved = Math.max(0, balance);
  const percent = Math.min(100, Math.round(saved / goal.amount * 100));

  info.textContent =
    `${goal.name}: ${money(saved)} из ${money(goal.amount)} (${percent}%)`;

  bar.style.width = percent + "%";
}

// Отображение операций
function renderOperations(type = "all", showAll = isOperationsHistoryOpen) {
  const container = document.getElementById("operations");
  const sortedOperations = [...data.operations].sort((a, b) => {
    const dateA = parseOperationDate(a.date)?.getTime() || 0;
    const dateB = parseOperationDate(b.date)?.getTime() || 0;
    return dateB - dateA;
  });

  const filtered = type === "all"
    ? sortedOperations
    : sortedOperations.filter(item => item.type === type);

  if (!filtered.length) {
    container.innerHTML = '<p class="empty">Операций пока нет</p>';
    return;
  }

  container.innerHTML = (showAll ? filtered : filtered.slice(0, 10)).map(item => {
    const isIncome = item.type === "income";

    return `
      <div class="operation">
        <div>
          <div class="operation-name">${escapeHTML(item.name)}</div>

          <small>${escapeHTML(item.date || "")}</small>

          <div class="muted">
            ${escapeHTML(item.category || "Без категории")}
          </div>

          <span class="operation-type ${isIncome ? "income" : "expense"}">
            ${isIncome ? "Доход" : "Расход"}
          </span>
        </div>

        <div class="operation-actions">
    <strong class="${isIncome ? "income" : "expense"}">
        ${isIncome ? "+" : "-"}${money(item.amount)}
    </strong>

    <button class="edit-btn" onclick="editOperation('${item.id}')">
        ✏️
    </button>

    <button class="delete-btn" onclick="deleteOperation('${item.id}')">
        ✕
    </button>
        </div>
      </div>
    `;
  }).join("");
}


// Защита текста
function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "'"
  })[char]);
}

// Статистика расходов
function renderChart() {
  const chart = document.getElementById("categoryChart");
  const legend = document.getElementById("categoryLegend");

  const totals = {};

  data.operations
    .filter(item => item.type === "expense")
    .forEach(item => {
      const category = categories[item.category] ? item.category : "other";
      totals[category] = (totals[category] || 0) + item.amount;
    });

  const entries = Object.entries(totals);
  const total = entries.reduce((sum, item) => sum + item[1], 0);

  if (!total) {
    chart.style.background = "#eeeeee";
    legend.innerHTML =
      '<p class="empty">Пока нет данных о расходах</p>';
    return;
  }

  let current = 0;
  const gradients = [];

  entries.forEach(([key, value]) => {
    const start = current;
    current += value / total * 100;

    gradients.push(
      `${categories[key].color} ${start}% ${current}%`
    );
  });

  chart.style.background =
    `conic-gradient(${gradients.join(", ")})`;

  legend.innerHTML = entries.map(([key, value]) => {
    const percent = Math.round(value / total * 100);

    return `
      <div class="legend-item">
        <div class="legend-name">
          <span class="legend-color"
            style="background:${categories[key].color}"></span>
          ${categories[key].name}
        </div>
        <span class="legend-value">
          ${money(value)} · ${percent}%
        </span>
      </div>
    `;
  }).join("");
}

// Обновление приложения
function render() {
    const income = data.operations
        .filter(item => item.type === "income")
        .reduce((sum, item) => sum + item.amount, 0);

    const expenses = data.operations
        .filter(item => item.type === "expense")
        .reduce((sum, item) => sum + item.amount, 0);

    const balance = income - expenses;

    document.getElementById("balance").textContent = money(balance);
    document.getElementById("income").textContent = money(income);
    document.getElementById("expenses").textContent = money(expenses);

    renderOperations();
    renderGoal(balance);
    renderMonthlyStats();
    renderProDashboard();
}

// Переключение операций
window.showOperations = function(type, button) {
    document.querySelectorAll(".operation-tabs .tab")
        .forEach(tab => tab.classList.remove("active"));

    button.classList.add("active");

    renderOperations(type);
};

// Запуск приложения
render();

// Открытие окна редактирования
window.editOperation = function(id) {
    const operation = data.operations.find(item => item.id === id);

    if (!operation) return;

    window.editingOperationId = id;

    document.getElementById("edit-name").value = operation.name;
    document.getElementById("edit-amount").value = operation.amount;
    document.getElementById("edit-type").value = operation.type;
    document.getElementById("edit-category").value = operation.category || "";

    document.getElementById("edit-modal").style.display = "flex";
};

// Сохранение изменений
window.saveEdit = function() {
    const operation = data.operations.find(
        item => item.id === window.editingOperationId
    );

    if (!operation) return;

    const name = document.getElementById("edit-name").value.trim();
    const amount = Number(document.getElementById("edit-amount").value);
    const type = document.getElementById("edit-type").value;
    const category = document.getElementById("edit-category").value.trim();

    if (!name || !category || !Number.isFinite(amount) || amount <= 0) {
        alert("Заполни все поля правильно!");
        return;
    }

    operation.name = name;
    operation.amount = amount;
    operation.type = type;
    operation.category = category;

    saveData();
    render();
    closeEditModal();
};

// Закрытие окна
window.closeEditModal = function() {
    document.getElementById("edit-modal").style.display = "none";
    window.editingOperationId = null;
};

// Сброс финансовой цели
window.resetGoal = function() {
    if (!data.goal.name && !data.goal.amount) {
        alert("У тебя пока нет установленной цели!");
        return;
    }

    const confirmReset = confirm("Ты действительно хочешь сбросить финансовую цель?");

    if (!confirmReset) return;

    data.goal = {
        name: "",
        amount: 0
    };

    document.getElementById("goal").value = "";
    document.getElementById("goalAmount").value = "";

    saveData();
    render();
};

// Получение даты операции
function parseOperationDate(dateString) {
    if (!dateString) return null;

    const parts = dateString.split(".");

    if (parts.length !== 3) return null;

    const [day, month, year] = parts.map(Number);

    const date = new Date(year, month - 1, day);

    if (
        date.getFullYear() !== year ||
        date.getMonth() !== month - 1 ||
        date.getDate() !== day
    ) {
        return null;
    }

    return date;
}

// Сравнение показателей
function compareMonths(current, previous) {
    if (previous === 0) {
        return current === 0 ? "—" : "Новый показатель";
    }

    const change = ((current - previous) / previous) * 100;
    const sign = change > 0 ? "+" : "";

    return `${sign}${change.toFixed(1)}%`;
}

// Отображение месячной статистики
function renderMonthlyStats() {
    const now = new Date();

    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();

    const previousDate = new Date(currentYear, currentMonth - 1, 1);

    const previousYear = previousDate.getFullYear();
    const previousMonth = previousDate.getMonth();

    const currentOperations = data.operations.filter(item => {
        const date = parseOperationDate(item.date);

        return date &&
            date.getFullYear() === currentYear &&
            date.getMonth() === currentMonth;
    });

    const previousOperations = data.operations.filter(item => {
        const date = parseOperationDate(item.date);

        return date &&
            date.getFullYear() === previousYear &&
            date.getMonth() === previousMonth;
    });

    function getTotal(operations, type) {
        return operations
            .filter(item => item.type === type)
            .reduce((sum, item) => sum + Number(item.amount), 0);
    }

    const currentIncome = getTotal(currentOperations, "income");
    const currentExpenses = getTotal(currentOperations, "expense");

    const previousIncome = getTotal(previousOperations, "income");
    const previousExpenses = getTotal(previousOperations, "expense");

    document.getElementById("monthly-income").textContent =
        money(currentIncome);

    document.getElementById("monthly-expenses").textContent =
        money(currentExpenses);

    document.getElementById("monthly-comparison").textContent =
        "Доходы: " + compareMonths(currentIncome, previousIncome);

    document.getElementById("monthly-comparison-details").textContent =
        "Расходы: " + compareMonths(currentExpenses, previousExpenses);
}
// Перемещение разделов в модальные окна
const featureSections = {
    "operations-modal": [
        document.getElementById("transactions"),
        document.getElementById("add-operation-panel")
    ],
    "goals-modal": [
        document.getElementById("goals")
    ],
    "statistics-modal": [
        document.getElementById("monthly-stats")
    ],
    "pro-modal": []
};

const featurePlaceholders = new Map();

function openFeatureModal(modalId) {
    closeFeatureModal();

    if (modalId === "operations-modal") {
        isOperationsHistoryOpen = true;
        renderOperations("all", true);
    }

    const modal = document.getElementById(modalId);
    const content = document.getElementById(
        modalId.replace("-modal", "-modal-content")
    );

    if (!modal || !content) return;

    featureSections[modalId].forEach(section => {
        if (!section) return;

        const placeholder = document.createComment("section-placeholder");
        section.parentNode.insertBefore(placeholder, section);

        featurePlaceholders.set(section, placeholder);
        content.appendChild(section);
    });

    modal.classList.add("active");
    document.body.style.overflow = "hidden";
    if (modalId === "pro-modal") renderProDashboard();
}

function closeFeatureModal() {
    document.querySelectorAll(".feature-overlay.active").forEach(modal => {
        modal.classList.remove("active");
    });

    featurePlaceholders.forEach((placeholder, section) => {
        if (placeholder.parentNode) {
            placeholder.parentNode.insertBefore(section, placeholder);
            placeholder.remove();
        }
    });

    featurePlaceholders.clear();
    document.body.style.overflow = "";
    if (isOperationsHistoryOpen) {
        isOperationsHistoryOpen = false;
        renderOperations("all", false);
        const allTab = document.querySelector('.operation-tabs .tab[onclick*="all"]');
        if (allTab) allTab.classList.add("active");
        document.querySelectorAll('.operation-tabs .tab:not([onclick*="all"])').forEach(tab => tab.classList.remove("active"));
    }
}

// Нажатия на пункты бокового меню
document.querySelectorAll("[data-modal]").forEach(link => {
    link.addEventListener("click", event => {
        event.preventDefault();
        if (link.dataset.modal !== "pro-modal") showHomePage();
        openFeatureModal(link.dataset.modal);
    });
});

const proSectionDetails = {
    overview: { title: "Обзор месяца", description: "Коротко о твоих финансах за этот месяц." },
    budgets: { title: "Лимиты расходов", description: "Задай бюджет и следи, сколько осталось в каждой категории." },
    goal: { title: "Прогноз цели", description: "Узнай примерный срок накоплений по твоему текущему темпу." },
    export: { title: "Экспорт отчёта", description: "Сохрани историю операций в удобном табличном формате." }
};

function showProSection(section) {
    if (!hasProEntitlement || !proSectionDetails[section]) return;
    closeFeatureModal();
    document.getElementById("home").hidden = true;
    document.getElementById("pro-page").hidden = false;
    document.getElementById("pro-workspace").hidden = false;
    document.getElementById("pro-page-title").textContent = proSectionDetails[section].title;
    document.getElementById("pro-page-description").textContent = proSectionDetails[section].description;
    document.querySelectorAll("[data-pro-panel]").forEach(panel => {
        panel.hidden = panel.dataset.proPanel !== section;
    });
    document.querySelectorAll("[data-pro-section]").forEach(item => {
        item.classList.toggle("active", item.dataset.proSection === section);
    });
    renderProDashboard();
}

function showHomePage() {
    closeFeatureModal();
    document.getElementById("pro-page").hidden = true;
    document.getElementById("home").hidden = false;
    document.querySelectorAll("[data-pro-section]").forEach(item => item.classList.remove("active"));
    document.querySelector('[data-page="home"]').classList.add("active");
}

document.querySelectorAll("[data-pro-section]").forEach(link => {
    link.addEventListener("click", event => {
        event.preventDefault();
        showProSection(link.dataset.proSection);
    });
});

document.querySelectorAll("[data-open-pro-section]").forEach(button => {
    button.addEventListener("click", () => showProSection(button.dataset.openProSection));
});

document.getElementById("pro-page-back").addEventListener("click", showHomePage);
document.getElementById("pro-open-overview").addEventListener("click", () => {
    closeFeatureModal();
    showProSection("overview");
});

document.getElementById("open-history-button").addEventListener("click", () => {
    openFeatureModal("operations-modal");
});

// Возврат на главную
document.querySelector('[data-page="home"]').addEventListener("click", () => {
    showHomePage();
});

// Закрытие при нажатии на затемнённый фон
document.querySelectorAll(".feature-overlay").forEach(modal => {
    modal.addEventListener("click", event => {
        if (event.target === modal) {
            closeFeatureModal();
        }
    });
});

// Закрытие клавишей Escape
document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
        closeFeatureModal();
    }
});

// ======================================
// АВТОРИЗАЦИЯ SUPABASE
// ======================================

let authMode = "login";

const authScreen = document.getElementById("auth-screen");
const loginTab = document.getElementById("login-tab");
const registerTab = document.getElementById("register-tab");
const authTitle = document.getElementById("auth-title");
const authDescription = document.getElementById("auth-description");
const authEmail = document.getElementById("auth-email");
const authPassword = document.getElementById("auth-password");
const authSubmit = document.getElementById("auth-submit");
const authMessage = document.getElementById("auth-message");
const profileButton = document.getElementById("profile-button");
const profileMenu = document.getElementById("account-menu");
const accountEmail = document.getElementById("account-email");
const accountSettingsModal = document.getElementById("account-settings-modal");
const settingsEmail = document.getElementById("settings-email");
const settingsMessage = document.getElementById("settings-message");
const newPasswordInput = document.getElementById("new-password");

function setProEntitlement(isActive) {
    const wasActive = hasProEntitlement;
    hasProEntitlement = isActive;
    const buyButton = document.getElementById("buy-pro-button");
    const message = document.getElementById("pro-purchase-message");
    const preview = document.getElementById("pro-preview");
    const workspace = document.getElementById("pro-workspace");
    const hero = document.querySelector(".pro-hero");
    const heading = document.getElementById("pro-heading");
    const priceRow = document.querySelector(".pro-price-row");
    const testNote = document.querySelector(".pro-test-note");
    const activeNote = document.getElementById("pro-active-note");
    document.getElementById("pro-navigation").hidden = !isActive;
    activeNote.hidden = !isActive;

    preview.hidden = isActive;
    workspace.hidden = !isActive;
    if (!isActive) {
        document.getElementById("pro-page").hidden = true;
        document.getElementById("home").hidden = false;
        document.querySelectorAll("[data-pro-section]").forEach(item => item.classList.remove("active"));
        document.querySelector('[data-page="home"]').classList.add("active");
    }
    hero.classList.toggle("is-unlocked", isActive);
    heading.textContent = isActive ? "LifePlan Pro уже с тобой" : "Твой финансовый план — на уровень выше";
    priceRow.hidden = isActive;
    testNote.hidden = isActive;
    if (isActive) {
        buyButton.hidden = true;
        message.textContent = "LifePlan Pro активирован для этого аккаунта навсегда.";
    } else {
        buyButton.hidden = false;
        proDashboardData = null;
    }
    renderProDashboard();
    if (isActive && !localProDemo && (!wasActive || !proDashboardData)) refreshProDashboard();
}

function getCurrentMonthOperations() {
    const now = new Date();
    return data.operations.filter(item => {
        const date = parseOperationDate(item.date);
        return date && date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
    });
}

function createLocalProDemoReport() {
    const monthOperations = getCurrentMonthOperations();
    const expenses = monthOperations.filter(item => item.type === "expense");
    const incomeTotal = monthOperations
        .filter(item => item.type === "income")
        .reduce((total, item) => total + Number(item.amount), 0);
    const expenseTotal = expenses.reduce((total, item) => total + Number(item.amount), 0);
    const categoryTotals = expenses.reduce((totals, item) => {
        const category = item.category || "Без категории";
        totals[category] = (totals[category] || 0) + Number(item.amount);
        return totals;
    }, Object.create(null));
    const topCategory = Object.entries(categoryTotals).sort((a, b) => b[1] - a[1])[0];
    const budgetRows = [...new Set([...Object.keys(localDemoBudgets), ...Object.keys(categoryTotals)])].map(category => {
        const spent = categoryTotals[category] || 0;
        const limit = Number(localDemoBudgets[category]) || 0;
        const progress = limit ? Math.min(100, Math.round(spent / limit * 100)) : 0;
        const state = limit && spent >= limit ? "over" : limit && spent >= limit * .8 ? "near" : "";
        const status = !limit ? "Задай лимит" : spent >= limit ? `Превышен на ${money(spent - limit)}` : `Осталось ${money(limit - spent)}`;
        return { category, spent, limit, progress, state, status };
    });
    const activeBudget = budgetRows.find(row => row.limit && row.spent >= row.limit);
    const nearBudget = budgetRows.find(row => row.limit && row.spent >= row.limit * .8);
    const insight = activeBudget
        ? `Лимит «${activeBudget.category}» достигнут. Уже потрачено ${money(activeBudget.spent)} из ${money(activeBudget.limit)}.`
        : nearBudget
            ? `В категории «${nearBudget.category}» осталось меньше 20% лимита. Хороший момент проверить планируемые покупки.`
            : topCategory
                ? `Больше всего в этом месяце уходит на «${topCategory[0]}» — ${money(topCategory[1])}.`
                : "Добавь операции, чтобы увидеть разбор месяца.";

    let goal = null;
    if (data.goal?.name && Number(data.goal.amount) > 0) {
        const saved = Math.max(0, data.operations.reduce((total, item) =>
            total + (item.type === "income" ? 1 : -1) * Number(item.amount), 0
        ));
        const target = Number(data.goal.amount);
        const progress = Math.min(100, Math.round(saved / target * 100));
        const now = new Date();
        const monthlySavings = [];
        for (let offset = 0; offset < 3; offset += 1) {
            const month = new Date(now.getFullYear(), now.getMonth() - offset, 1);
            const entries = data.operations.filter(item => {
                const date = parseOperationDate(item.date);
                return date && date.getFullYear() === month.getFullYear() && date.getMonth() === month.getMonth();
            });
            if (entries.length) monthlySavings.push(entries.reduce((total, item) =>
                total + (item.type === "income" ? 1 : -1) * Number(item.amount), 0
            ));
        }
        const average = monthlySavings.length ? monthlySavings.reduce((total, amount) => total + amount, 0) / monthlySavings.length : 0;
        const remaining = Math.max(0, target - saved);
        let forecast = "Добавь операции за последние месяцы, чтобы посчитать темп.";
        if (!remaining) forecast = "Цель уже достигнута — поздравляем!";
        else if (average > 0) {
            const date = new Date(now.getFullYear(), now.getMonth() + Math.ceil(remaining / average), 1);
            forecast = `При текущем темпе — примерно ${date.toLocaleDateString("ru-RU", { month: "long", year: "numeric" })}.`;
        } else if (monthlySavings.length) forecast = "Пока темп накоплений не положительный. Попробуй выбрать комфортный ежемесячный взнос.";
        goal = { name: data.goal.name, saved, target, progress, forecast };
    }

    return {
        insight,
        monthBalance: incomeTotal - expenseTotal,
        dailySpend: expenseTotal / Math.max(1, new Date().getDate()),
        topCategory: topCategory?.[0] || "—",
        topCategoryShare: topCategory && expenseTotal ? `${Math.round(topCategory[1] / expenseTotal * 100)}% всех расходов` : "добавь расходы для анализа",
        budgetRows,
        goal,
    };
}

function activateLocalProDemo() {
    const today = new Date();
    const formatDate = date => [date.getDate(), date.getMonth() + 1, date.getFullYear()]
        .map((part, index) => index < 2 ? String(part).padStart(2, "0") : String(part))
        .join(".");
    const sampleOperation = (monthOffset, day, name, amount, type, category) => ({
        id: crypto.randomUUID(),
        date: formatDate(new Date(today.getFullYear(), today.getMonth() + monthOffset, day)),
        name,
        amount,
        type,
        category,
    });

    const monthly = monthOffset => [
        sampleOperation(monthOffset, 1, "Зарплата", 92000, "income", "Доход"),
        sampleOperation(monthOffset, 2, "Аренда", 30000, "expense", "Дом"),
        sampleOperation(monthOffset, 4, "Продукты", 16000, "expense", "Еда"),
        sampleOperation(monthOffset, 7, "Транспорт", 4200, "expense", "Транспорт"),
        sampleOperation(monthOffset, 10, "Покупки", 8000, "expense", "Покупки"),
        sampleOperation(monthOffset, 12, "Подписки", 1300, "expense", "Подписки"),
        sampleOperation(monthOffset, 16, "Аптека", 2500, "expense", "Здоровье"),
        sampleOperation(monthOffset, 20, "Кафе", 4000, "expense", "Еда"),
    ];

    data = {
        operations: [...monthly(-2), ...monthly(-1), ...monthly(0)].reverse(),
        goal: { name: "Отпуск в Японии", amount: 120000 },
    };
    localDemoBudgets = { "Еда": 22000, "Транспорт": 6000, "Покупки": 10000, "Дом": 32000, "Подписки": 1500, "Здоровье": 5000, "Другое": 7000 };
    proDashboardData = createLocalProDemoReport();
    authScreen.classList.add("hidden");
    setAccountUser({ email: "demo@lifeplan.local" });
    setProEntitlement(true);
    document.getElementById("pro-heading").textContent = "Демо LifePlan Pro";
    document.getElementById("pro-purchase-message").textContent = "Примерные данные. Покупка не совершалась, Pro в аккаунте не активирован.";
    render();
}

function renderProDashboard() {
    const workspace = document.getElementById("pro-workspace");
    if (!workspace) return;
    if (!hasProEntitlement) {
        workspace.hidden = true;
        document.getElementById("pro-budget-list").replaceChildren();
        document.getElementById("pro-goal-forecast").replaceChildren();
        return;
    }

    workspace.hidden = false;
    if (!proDashboardData) {
        document.getElementById("pro-insight-text").textContent = "Загружаю персональный финансовый разбор…";
        document.getElementById("pro-budget-list").replaceChildren();
        document.getElementById("pro-goal-forecast").replaceChildren();
        return;
    }
    if (proDashboardData.error) {
        document.getElementById("pro-insight-text").textContent = proDashboardData.error;
        return;
    }

    const report = proDashboardData;
    document.getElementById("pro-insight-text").textContent = report.insight;
    document.getElementById("pro-month-balance").textContent = money(report.monthBalance);
    document.getElementById("pro-daily-spend").textContent = money(report.dailySpend);
    document.getElementById("pro-top-category").textContent = report.topCategory;
    document.getElementById("pro-top-category-share").textContent = report.topCategoryShare;
    document.getElementById("pro-budget-list").innerHTML = report.budgetRows.map(row => `
      <div class="budget-row ${escapeHTML(row.state)}">
        <div class="budget-row-top"><label for="budget-${escapeHTML(row.category)}">${escapeHTML(row.category)}</label><span>${money(row.spent)}</span></div>
        <div class="budget-meter"><span style="width:${row.progress}%"></span></div>
        <div class="budget-row-bottom"><small>${escapeHTML(row.status)}</small><label class="budget-input-wrap"><span>Лимит</span><input id="budget-${escapeHTML(row.category)}" data-budget-input="${escapeHTML(row.category)}" type="number" min="0" step="100" value="${row.limit || ""}" placeholder="₽"></label></div>
      </div>
    `).join("");

    const goalContainer = document.getElementById("pro-goal-forecast");
    if (!report.goal) {
        goalContainer.innerHTML = `
          <div class="forecast-empty"><span class="forecast-icon">◎</span><h5>Сначала выбери цель</h5><p>Добавь цель в разделе «Накопления», и здесь появится прогноз срока.</p></div>
        `;
    } else {
        goalContainer.innerHTML = `
          <div class="goal-forecast-title"><span class="forecast-icon">◎</span><div><small>ТЫ НАКАПЛИВАЕШЬ НА</small><h5>${escapeHTML(report.goal.name)}</h5></div></div>
          <div class="goal-forecast-amounts"><strong>${money(report.goal.saved)}</strong><span>из ${money(report.goal.target)}</span></div>
          <div class="forecast-meter"><span style="width:${report.goal.progress}%"></span></div>
          <div class="forecast-percent">${report.goal.progress}% пути</div>
          <div class="forecast-result"><span>⌁</span><p>${escapeHTML(report.goal.forecast)}</p></div>
          <small class="forecast-caption">Оценка по операциям за последние месяцы. Это ориентир, а не обещание доходности.</small>
        `;
    }
}

async function refreshProDashboard() {
    if (!hasProEntitlement) return;
    if (localProDemo) {
        proDashboardData = createLocalProDemoReport();
        renderProDashboard();
        return;
    }
    if (!activeUserId) return;
    const userId = activeUserId;
    const requestId = ++proDashboardRequestId;
    proDashboardData = null;
    renderProDashboard();

    const { data: report, error } = await supabaseClient.functions.invoke("pro-tools", {
        body: { action: "dashboard" }
    });
    if (requestId !== proDashboardRequestId || activeUserId !== userId || !hasProEntitlement) return;
    if (error) {
        proDashboardData = { error: error.message || "Не удалось загрузить Pro-инструменты." };
    } else {
        proDashboardData = report;
    }
    renderProDashboard();
}

async function saveProBudgets() {
    const message = document.getElementById("pro-budget-message");
    const button = document.getElementById("pro-save-budgets");
    if (!hasProEntitlement) return;

    const nextBudgets = {};
    document.querySelectorAll("[data-budget-input]").forEach(input => {
        const amount = Number(input.value);
        if (input.value && Number.isFinite(amount) && amount > 0) {
            nextBudgets[input.dataset.budgetInput] = amount;
        }
    });

    if (localProDemo) {
        localDemoBudgets = nextBudgets;
        proDashboardData = createLocalProDemoReport();
        renderProDashboard();
        message.textContent = "Демо: лимиты применены только в этом окне.";
        return;
    }

    button.disabled = true;
    message.textContent = "Сохраняем…";
    try {
        const { error } = await supabaseClient.functions.invoke("pro-tools", {
            body: { action: "save-budgets", budgets: nextBudgets }
        });
        if (error) throw error;
        message.textContent = "Лимиты сохранены в аккаунте.";
        await refreshProDashboard();
    } catch (error) {
        message.textContent = error.message || "Не удалось сохранить лимиты.";
    } finally {
        button.disabled = false;
    }
}

function exportProReport() {
    if (!hasProEntitlement) return;
    const button = document.getElementById("pro-export-button");
    const message = document.getElementById("pro-insight-text");
    if (localProDemo) {
        const cell = value => `"${String(value ?? "").replace(/"/g, '""')}"`;
        const rows = [
            ["Дата", "Тип", "Название", "Категория", "Сумма, ₽"],
            ...data.operations.map(item => [item.date, item.type === "income" ? "Доход" : "Расход", item.name, item.category, item.amount])
        ];
        const csv = "\uFEFF" + rows.map(row => row.map(cell).join(";")).join("\r\n");
        const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = "lifeplan-pro-demo.csv";
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        message.textContent = "Демо-отчёт скачан.";
        return;
    }
    button.disabled = true;
    message.textContent = "Готовлю отчёт…";
    supabaseClient.functions.invoke("pro-tools", { body: { action: "export-csv" } })
        .then(({ data: result, error }) => {
            if (error) throw error;
            if (!result?.csv) throw new Error(result?.error || "Не удалось собрать отчёт.");
            const blobUrl = URL.createObjectURL(new Blob([result.csv], { type: "text/csv;charset=utf-8" }));
            const download = document.createElement("a");
            download.href = blobUrl;
            download.download = result.filename || "lifeplan-otchet.csv";
            document.body.appendChild(download);
            download.click();
            download.remove();
            window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
            message.textContent = "Отчёт скачан. Внутри все твои операции.";
        })
        .catch(error => {
            message.textContent = error.message || "Не удалось скачать отчёт.";
        })
        .finally(() => {
            button.disabled = false;
        });
}

async function refreshProEntitlement(userId, retryCount = 0, checkPaymentReturn = false) {
    const message = document.getElementById("pro-purchase-message");
    const returnedFromPayment = checkPaymentReturn || retryCount === 0 && new URLSearchParams(window.location.search).has("pro_payment");
    const { data: entitlement, error } = await supabaseClient
        .from("pro_entitlements")
        .select("user_id,payment_id")
        .eq("user_id", userId)
        .maybeSingle();

    if (error) {
        console.error("Не удалось проверить LifePlan Pro:", error);
        return;
    }

    let purchase = null;
    if (entitlement?.payment_id) {
        const { data, error: paymentError } = await supabaseClient
            .from("pro_payments")
            .select("status,is_test")
            .eq("payment_id", entitlement.payment_id)
            .maybeSingle();
        if (paymentError) console.error("Не удалось проверить платёж LifePlan Pro:", paymentError);
        else purchase = data;
    }

    let latestPayment = purchase;
    if (!latestPayment && returnedFromPayment) {
        const { data, error: latestPaymentError } = await supabaseClient
            .from("pro_payments")
            .select("status,is_test")
            .eq("user_id", userId)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
        if (latestPaymentError) console.error("Не удалось проверить тестовый платёж:", latestPaymentError);
        else latestPayment = data;
    }

    const isPaid = Boolean(entitlement && purchase && purchase.is_test === false && purchase.status === "succeeded");
    setProEntitlement(isPaid);

    if (returnedFromPayment) {
        if (isPaid) {
            message.textContent = "Оплата подтверждена. LifePlan Pro активирован навсегда.";
        } else if (latestPayment?.is_test === true && latestPayment.status === "test_succeeded") {
            message.textContent = "Тестовый платёж подтверждён. Денег не списали, поэтому Pro-функции остались закрыты.";
        } else {
            message.textContent = "Платёж проверяется. Если он прошёл, Pro активируется автоматически в течение минуты.";
        }
        const url = new URL(window.location.href);
        url.searchParams.delete("pro_payment");
        window.history.replaceState({}, "", url);
    }

    const testPaymentFinished = latestPayment?.is_test === true && latestPayment.status === "test_succeeded";
    if (!isPaid && returnedFromPayment && !testPaymentFinished && retryCount < 8) {
        window.setTimeout(() => refreshProEntitlement(userId, retryCount + 1, true), 4000);
    }
}

document.getElementById("buy-pro-button").addEventListener("click", async () => {
    const button = document.getElementById("buy-pro-button");
    const message = document.getElementById("pro-purchase-message");
    button.disabled = true;
    message.textContent = "Готовим переход к оплате…";
    try {
        const { data: result, error } = await supabaseClient.functions.invoke("create-yookassa-payment");
        if (error) throw error;
        if (!result?.confirmationUrl) throw new Error(result?.error || "Не получена ссылка на оплату.");
        window.location.assign(result.confirmationUrl);
    } catch (error) {
        message.textContent = error.message || "Не удалось начать оплату.";
    } finally {
        button.disabled = false;
    }
});

document.getElementById("pro-save-budgets").addEventListener("click", saveProBudgets);
document.getElementById("pro-export-button").addEventListener("click", exportProReport);

function setAccountUser(user) {
    const email = user?.email || "";
    document.getElementById("profile-initial").textContent = email
        ? Array.from(email.trim())[0].toLocaleUpperCase("ru-RU")
        : "?";
    accountEmail.textContent = email || "Почта не указана";
    settingsEmail.textContent = email || "Почта не указана";
    profileButton.hidden = !user;
}

function closeAccountMenu() {
    profileMenu.hidden = true;
    profileButton.setAttribute("aria-expanded", "false");
}

profileButton.addEventListener("click", () => {
    const isOpen = !profileMenu.hidden;
    profileMenu.hidden = isOpen;
    profileButton.setAttribute("aria-expanded", String(!isOpen));
});

document.addEventListener("click", event => {
    if (!event.target.closest(".profile-menu-wrap")) closeAccountMenu();
});

document.getElementById("account-settings-button").addEventListener("click", () => {
    closeAccountMenu();
    settingsMessage.textContent = "";
    settingsMessage.className = "settings-message";
    newPasswordInput.value = "";
    accountSettingsModal.style.display = "flex";
    newPasswordInput.focus();
});

function closeAccountSettings() {
    accountSettingsModal.style.display = "none";
}

document.getElementById("close-account-settings").addEventListener("click", closeAccountSettings);
accountSettingsModal.addEventListener("click", event => {
    if (event.target === accountSettingsModal) closeAccountSettings();
});

document.getElementById("save-account-settings").addEventListener("click", async () => {
    const password = newPasswordInput.value;
    if (password.length < 6) {
        settingsMessage.textContent = "Пароль должен содержать минимум 6 символов.";
        settingsMessage.className = "settings-message error";
        return;
    }

    const saveButton = document.getElementById("save-account-settings");
    saveButton.disabled = true;
    settingsMessage.textContent = "Сохраняем…";
    settingsMessage.className = "settings-message";
    try {
        const { error } = await supabaseClient.auth.updateUser({ password });
        if (error) throw error;
        settingsMessage.textContent = "Пароль обновлён.";
        settingsMessage.className = "settings-message success";
        newPasswordInput.value = "";
    } catch (error) {
        settingsMessage.textContent = error.message || "Не удалось обновить пароль.";
        settingsMessage.className = "settings-message error";
    } finally {
        saveButton.disabled = false;
    }
});

document.getElementById("logout-button").addEventListener("click", async () => {
    closeAccountMenu();
    const { error } = await supabaseClient.auth.signOut();
    if (error) {
        alert(error.message || "Не удалось выйти из аккаунта.");
        return;
    }
    setAccountUser(null);
    authMessage.textContent = "";
    authScreen.classList.remove("hidden");
});

// Переключение между входом и регистрацией
function setAuthMode(mode) {
    authMode = mode;

    loginTab.classList.toggle("active", mode === "login");
    registerTab.classList.toggle("active", mode === "register");

    if (mode === "login") {
        authTitle.textContent = "С возвращением!";
        authDescription.textContent = "Войди в свой аккаунт";
        authSubmit.textContent = "Войти";
        authPassword.autocomplete = "current-password";
    } else {
        authTitle.textContent = "Создай аккаунт";
        authDescription.textContent = "Зарегистрируйся в LifePlan";
        authSubmit.textContent = "Зарегистрироваться";
        authPassword.autocomplete = "new-password";
    }

    authMessage.textContent = "";
    authPassword.value = "";
}

loginTab.addEventListener("click", () => {
    setAuthMode("login");
});

registerTab.addEventListener("click", () => {
    setAuthMode("register");
});

// Отправка формы
authSubmit.addEventListener("click", async () => {
    const email = authEmail.value.trim();
    const password = authPassword.value;

    authMessage.textContent = "";

    if (!email || !password) {
        authMessage.textContent = "Заполни почту и пароль!";
        return;
    }

    if (password.length < 6) {
        authMessage.textContent = "Пароль должен содержать минимум 6 символов";
        return;
    }

    authSubmit.disabled = true;
    authSubmit.textContent = "Подождите...";

try {
    let result;

    if (authMode === "register") {
        result = await supabaseClient.auth.signUp({
            email: email,
            password: password,
            options: {
                emailRedirectTo: "https://lifeplan-studio.github.io/lifeplan/"
            }
        });
    } else {
        result = await supabaseClient.auth.signInWithPassword({
            email: email,
            password: password
        });
    }

    if (result.error) {
        throw result.error;
    }

    if (authMode === "register" && !result.data.session) {
        authMessage.style.color = "#28b879";
        authMessage.textContent =
            "Проверь почту и подтверди регистрацию по ссылке.";

        return;
    }

    authScreen.classList.add("hidden");
    if (result.data.user) setAccountUser(result.data.user);

} catch (error) {
    authMessage.style.color = "#ed6969";
    authMessage.textContent =
        error.message || "Произошла ошибка. Попробуй ещё раз.";
} finally {
    authSubmit.disabled = false;
    authSubmit.textContent =
        authMode === "login" ? "Войти" : "Зарегистрироваться";
}
});
// Проверка существующей сессии
async function checkAuthSession() {
    try {
        const { data: sessionData, error } =
            await supabaseClient.auth.getSession();

        if (error) throw error;

        if (sessionData.session) {
            setAccountUser(sessionData.session.user);
            authScreen.classList.add("hidden");
            await loadUserData(sessionData.session.user);
        } else {
            setAccountUser(null);
            await loadUserData(null);
        }
    } catch (error) {
        authMessage.textContent =
            "Не удалось проверить авторизацию. Обнови страницу.";
    }
}

if (localProDemo) {
    activateLocalProDemo();
} else {
    checkAuthSession();

    supabaseClient.auth.onAuthStateChange((event, session) => {
        setAccountUser(session?.user || null);
        authScreen.classList.toggle("hidden", Boolean(session));
        setTimeout(() => loadUserData(session?.user || null), 0);
    });
}

















