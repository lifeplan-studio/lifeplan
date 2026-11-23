import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return json({ error: "Нужен вход в аккаунт." }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const shopId = Deno.env.get("YOOKASSA_SHOP_ID");
  const secretKey = Deno.env.get("YOOKASSA_SECRET_KEY");
  const siteUrl = Deno.env.get("LIFEPLAN_SITE_URL");
  const salesEnabled = Deno.env.get("LIFEPLAN_PRO_SALES_ENABLED") === "true";
  if (!salesEnabled || !supabaseUrl || !serviceRoleKey || !shopId || !secretKey || !siteUrl) {
    return json({ error: "Платёжный сервис ещё не настроен." }, 503);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey);
  const token = authorization.slice("Bearer ".length);
  const { data: { user }, error: userError } = await admin.auth.getUser(token);
  if (userError || !user) return json({ error: "Сессия недействительна. Войдите снова." }, 401);

  const { data: entitlement, error: entitlementError } = await admin
    .from("pro_entitlements").select("user_id").eq("user_id", user.id).maybeSingle();
  if (entitlementError) return json({ error: "Не удалось проверить статус Pro." }, 500);
  if (entitlement) return json({ error: "LifePlan Pro уже активирован." }, 409);

  const idempotenceKey = crypto.randomUUID();
  const credentials = btoa(`${shopId}:${secretKey}`);
  const paymentResponse = await fetch("https://api.yookassa.ru/v3/payments", {
    method: "POST",
    headers: {
      "Authorization": `Basic ${credentials}`,
      "Idempotence-Key": idempotenceKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: { value: "199.00", currency: "RUB" },
      capture: true,
      confirmation: {
        type: "redirect",
        return_url: `${siteUrl.replace(/\/$/, "")}/?pro_payment=return`,
      },
      description: "LifePlan Pro — бессрочный доступ",
      metadata: { user_id: user.id, product: "lifeplan_pro_lifetime" },
    }),
  });
  const payment = await paymentResponse.json();
  if (!paymentResponse.ok) {
    console.error("YooKassa payment creation failed:", payment);
    return json({ error: "ЮKassa не смогла создать платёж. Проверьте настройки магазина." }, 502);
  }

  const { error: insertError } = await admin.from("pro_payments").insert({
    payment_id: payment.id,
    user_id: user.id,
    amount: 199,
    status: payment.status,
  });
  if (insertError) {
    console.error("Could not record pending YooKassa payment:", insertError);
    return json({ error: "Не удалось сохранить платёж." }, 500);
  }

  const confirmationUrl = payment.confirmation?.confirmation_url;
  if (!confirmationUrl) return json({ error: "ЮKassa не вернула ссылку на оплату." }, 502);
  return json({ confirmationUrl }, 200);
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
