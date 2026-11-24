import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Operation = {
  id: string;
  name: string;
  amount: number | string;
  type: "income" | "expense";
  category: string;
  date: string;
};

const defaultBudgetCategories = ["Еда", "Транспорт", "Покупки", "Дом", "Подписки", "Здоровье", "Другое"];

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return json({ error: "Нужен вход в аккаунт." }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "Pro-сервис ещё не настроен." }, 503);

  const admin = createClient(supabaseUrl, serviceRoleKey);
  const token = authorization.slice("Bearer ".length);
  const { data: { user }, error: userError } = await admin.auth.getUser(token);
  if (userError || !user) return json({ error: "Сессия недействительна. Войдите снова." }, 401);

  const { data: entitlement, error: entitlementError } = await admin
    .from("pro_entitlements")
    .select("user_id,payment_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (entitlementError) return json({ error: "Не удалось проверить LifePlan Pro." }, 500);
  if (!entitlement) return json({ error: "Эта функция доступна после активации LifePlan Pro." }, 403);

  const { data: purchase, error: purchaseError } = await admin
    .from("pro_payments")
    .select("status,is_test")
    .eq("payment_id", entitlement.payment_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (purchaseError) return json({ error: "Не удалось подтвердить оплату LifePlan Pro." }, 500);
  if (!purchase || purchase.is_test !== false || purchase.status !== "succeeded") {
    return json({ error: "LifePlan Pro открывается после настоящей оплаты." }, 403);
  }

  let body: { action?: string; budgets?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Некорректный запрос." }, 400);
  }

  if (body.action === "save-budgets") {
    if (!body.budgets || typeof body.budgets !== "object" || Array.isArray(body.budgets)) {
      return json({ error: "Укажи лимиты по категориям." }, 400);
    }

    const entries = Object.entries(body.budgets as Record<string, unknown>);
    if (entries.length > 30) return json({ error: "Можно сохранить не более 30 категорий." }, 400);

    const budgets = Object.create(null) as Record<string, number>;
    for (const [rawCategory, rawAmount] of entries) {
      const category = rawCategory.trim().slice(0, 80);
      const amount = Number(rawAmount);
      if (!category || !Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) {
        return json({ error: "Проверь суммы лимитов. Они должны быть больше нуля." }, 400);
      }
      budgets[category] = amount;
    }

    const { error } = await admin.auth.admin.updateUserById(user.id, {
      user_metadata: { ...(user.user_metadata || {}), lifeplan_pro_budgets: budgets },
    });
    if (error) return json({ error: "Не удалось сохранить лимиты." }, 500);
    return json({ success: true }, 200);
  }

  const { operations, error: operationsError } = await loadUserOperations(admin, user.id);
  if (operationsError) return json({ error: operationsError }, 500);

  if (body.action === "export-csv") {
    if (!operations.length) return json({ error: "Добавь хотя бы одну операцию, чтобы скачать отчёт." }, 404);
    const escapeCell = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const rows = [
      ["Дата", "Тип", "Название", "Категория", "Сумма, ₽"],
      ...operations.map(operation => [
        operation.date || "",
        operation.type === "income" ? "Доход" : "Расход",
        operation.name || "",
        operation.category || "",
        Number(operation.amount) || 0,
      ]),
    ];
    const csv = "\uFEFF" + rows.map(row => row.map(escapeCell).join(";")).join("\r\n");
    return json({ csv, filename: `lifeplan-otchet-${new Date().toISOString().slice(0, 10)}.csv` }, 200);
  }

  if (body.action !== "dashboard") return json({ error: "Неизвестное действие." }, 400);

  const { data: goalRow, error: goalError } = await admin
    .from("goals")
    .select("name,amount")
    .eq("user_id", user.id)
    .maybeSingle();
  if (goalError) return json({ error: "Не удалось загрузить финансовую цель." }, 500);

  const budgets = readBudgets(user.user_metadata?.lifeplan_pro_budgets);
  const now = new Date();
  const currentMonth = operations.filter(operation => isSameMonth(parseDate(operation.date), now));
  const previousMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const expenses = currentMonth.filter(operation => operation.type === "expense");
  const expenseTotal = sum(expenses);
  const incomeTotal = sum(currentMonth.filter(operation => operation.type === "income"));
  const categoryTotals = expenses.reduce((totals, operation) => {
    const category = String(operation.category || "Без категории").trim() || "Без категории";
    totals[category] = (totals[category] || 0) + Number(operation.amount);
    return totals;
  }, Object.create(null) as Record<string, number>);
  const topCategory = Object.entries(categoryTotals).sort((a, b) => b[1] - a[1])[0];
  const previousExpenseTotal = sum(operations.filter(operation =>
    operation.type === "expense" && isSameMonth(parseDate(operation.date), previousMonthDate)
  ));
  const trend = previousExpenseTotal > 0
    ? ` По сравнению с прошлым месяцем расходы ${expenseTotal > previousExpenseTotal ? "выросли" : "снизились"} на ${Math.abs(Math.round((expenseTotal - previousExpenseTotal) / previousExpenseTotal * 100))}%.`
    : "";

  const breachedBudget = Object.entries(budgets).find(([category, limit]) =>
    (categoryTotals[category] || 0) >= limit
  );
  const nearBudget = Object.entries(budgets).find(([category, limit]) =>
    (categoryTotals[category] || 0) >= limit * 0.8
  );
  let insight = "В этом месяце пока нет операций. Добавь доходы и расходы — здесь появятся персональные подсказки.";
  if (currentMonth.length && breachedBudget) {
    insight = `Лимит «${breachedBudget[0]}» достигнут. Уже потрачено ${money(categoryTotals[breachedBudget[0]] || 0)} из ${money(breachedBudget[1])}.${trend}`;
  } else if (currentMonth.length && nearBudget) {
    insight = `В категории «${nearBudget[0]}» осталось меньше 20% лимита. Хороший момент проверить планируемые покупки.${trend}`;
  } else if (topCategory) {
    insight = `Больше всего в этом месяце уходит на «${topCategory[0]}» — ${money(topCategory[1])}. Поставь лимит, чтобы держать эту статью под контролем.${trend}`;
  } else if (currentMonth.length) {
    insight = "Здорово: расходы пока не записаны. Добавляй операции — LifePlan соберёт ясную картину месяца.";
  }

  const budgetCategories = [...new Set([...defaultBudgetCategories, ...Object.keys(categoryTotals)])];
  const budgetRows = budgetCategories.map(category => {
    const spent = categoryTotals[category] || 0;
    const limit = budgets[category] || 0;
    let status = "Задай лимит";
    if (limit && spent >= limit) status = `Превышен на ${money(spent - limit)}`;
    else if (limit) status = `Осталось ${money(limit - spent)}`;
    return {
      category,
      spent,
      limit,
      progress: limit ? Math.min(100, Math.round(spent / limit * 100)) : 0,
      state: limit && spent >= limit ? "over" : limit && spent >= limit * 0.8 ? "near" : "",
      status,
    };
  });

  const goal = goalRow && goalRow.name && Number(goalRow.amount) > 0
    ? buildGoalForecast(goalRow, operations, now)
    : null;
  return json({
    insight,
    monthBalance: incomeTotal - expenseTotal,
    dailySpend: expenseTotal / Math.max(1, now.getDate()),
    topCategory: topCategory?.[0] || "—",
    topCategoryShare: topCategory && expenseTotal
      ? `${Math.round(topCategory[1] / expenseTotal * 100)}% всех расходов`
      : "добавь расходы для анализа",
    budgetRows,
    goal,
  }, 200);
});

function readBudgets(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([category, amount]) => category.length <= 80 && Number.isFinite(Number(amount)) && Number(amount) > 0)
    .slice(0, 30)
    .map(([category, amount]) => [category, Number(amount)]));
}

function parseDate(value: unknown): Date | null {
  const text = String(value || "");
  const dotted = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const parts = dotted
    ? [Number(dotted[3]), Number(dotted[2]) - 1, Number(dotted[1])]
    : iso
      ? [Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])]
      : null;
  if (!parts) return null;
  const date = new Date(parts[0], parts[1], parts[2]);
  return date.getFullYear() === parts[0] && date.getMonth() === parts[1] && date.getDate() === parts[2]
    ? date
    : null;
}

function isSameMonth(date: Date | null, reference: Date): boolean {
  return Boolean(date && date.getFullYear() === reference.getFullYear() && date.getMonth() === reference.getMonth());
}

function sum(operations: Operation[]): number {
  return operations.reduce((total, operation) => total + Number(operation.amount), 0);
}

function money(value: number): string {
  return `${new Intl.NumberFormat("ru-RU").format(value)} ₽`;
}

function buildGoalForecast(goal: { name: string; amount: number | string }, operations: Operation[], now: Date) {
  const currentBalance = operations.reduce((balance, operation) =>
    balance + (operation.type === "income" ? 1 : -1) * Number(operation.amount), 0
  );
  const saved = Math.max(0, currentBalance);
  const target = Number(goal.amount);
  const remaining = Math.max(0, target - saved);
  const progress = Math.min(100, Math.round(saved / target * 100));
  const monthlySavings: number[] = [];

  for (let offset = 0; offset < 3; offset += 1) {
    const month = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    const monthOperations = operations.filter(operation => isSameMonth(parseDate(operation.date), month));
    if (monthOperations.length) {
      monthlySavings.push(monthOperations.reduce((total, operation) =>
        total + (operation.type === "income" ? 1 : -1) * Number(operation.amount), 0
      ));
    }
  }

  const average = monthlySavings.length
    ? monthlySavings.reduce((total, amount) => total + amount, 0) / monthlySavings.length
    : 0;
  let forecast = "Запиши операции за этот месяц, чтобы рассчитать темп.";
  if (remaining === 0) forecast = "Цель уже достигнута — поздравляем!";
  else if (average > 0) {
    const finishDate = new Date(now.getFullYear(), now.getMonth() + Math.ceil(remaining / average), 1);
    forecast = `При текущем темпе — примерно ${finishDate.toLocaleDateString("ru-RU", { month: "long", year: "numeric" })}.`;
  } else if (monthlySavings.length) forecast = "Пока темп накоплений не положительный. Попробуй выбрать комфортный ежемесячный взнос.";

  return {
    name: String(goal.name).slice(0, 120),
    saved,
    target,
    progress,
    forecast,
  };
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function loadUserOperations(admin: ReturnType<typeof createClient>, userId: string) {
  const rows: Operation[] = [];
  const pageSize = 1000;
  const maximumRows = 50000;

  for (let offset = 0; offset < maximumRows; offset += pageSize) {
    const { data, error } = await admin
      .from("operations")
      .select("id,name,amount,type,category,date")
      .eq("user_id", userId)
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) return { operations: rows, error: "Не удалось загрузить операции для Pro." };
    rows.push(...((data || []) as Operation[]));
    if ((data || []).length < pageSize) return { operations: rows, error: null };
  }

  return { operations: rows, error: "В отчёте больше 50 000 операций. Разбей выгрузку по периодам." };
}
