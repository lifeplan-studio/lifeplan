import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const shopId = Deno.env.get("YOOKASSA_SHOP_ID");
  const secretKey = Deno.env.get("YOOKASSA_SECRET_KEY");
  const mode = Deno.env.get("YOOKASSA_MODE") || "test";
  const liveSalesEnabled = Deno.env.get("LIFEPLAN_PRO_LIVE_ENABLED") === "true";
  if (!supabaseUrl || !serviceRoleKey || !shopId || !secretKey || !["test", "live"].includes(mode)) {
    return new Response("Payment service is not configured", { status: 503 });
  }
  if (mode === "live" && !liveSalesEnabled) {
    return new Response("Live payments are not enabled", { status: 503 });
  }

  let notification;
  try {
    notification = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  if (notification?.event !== "payment.succeeded" || !notification.object?.id) {
    return new Response("Ignored", { status: 200 });
  }

  const credentials = btoa(`${shopId}:${secretKey}`);
  const paymentResponse = await fetch(
    `https://api.yookassa.ru/v3/payments/${encodeURIComponent(notification.object.id)}`,
    { headers: { "Authorization": `Basic ${credentials}` } },
  );
  if (!paymentResponse.ok) return new Response("Could not verify payment", { status: 502 });
  const payment = await paymentResponse.json();

  if (
    payment.status !== "succeeded" ||
    payment.paid !== true ||
    payment.test !== (mode === "test") ||
    payment.amount?.currency !== "RUB" ||
    payment.amount?.value !== "199.00" ||
    payment.metadata?.product !== "lifeplan_pro_lifetime" ||
    !payment.metadata?.user_id
  ) {
    return new Response("Payment does not match", { status: 400 });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey);
  const { data: storedPayment, error: lookupError } = await admin
    .from("pro_payments")
    .select("payment_id,user_id,status,is_test")
    .eq("payment_id", payment.id)
    .maybeSingle();
  if (lookupError) return new Response("Could not load payment record", { status: 500 });
  if (
    !storedPayment ||
    storedPayment.user_id !== payment.metadata.user_id ||
    storedPayment.is_test !== (mode === "test")
  ) {
    return new Response("Payment record mismatch", { status: 400 });
  }

  if (mode === "test") {
    const { error: updateTestPaymentError } = await admin.from("pro_payments")
      .update({ status: "test_succeeded" }).eq("payment_id", payment.id);
    if (updateTestPaymentError) return new Response("Could not update test payment", { status: 500 });
    return new Response("Test payment recorded. LifePlan Pro remains locked.", { status: 200 });
  }

  const { error: grantError } = await admin.from("pro_entitlements").upsert({
    user_id: storedPayment.user_id,
    payment_id: payment.id,
    provider: "yookassa",
  });
  if (grantError) return new Response("Could not activate Pro", { status: 500 });

  const { error: updateError } = await admin.from("pro_payments")
    .update({ status: "succeeded" }).eq("payment_id", payment.id);
  if (updateError) return new Response("Could not update payment", { status: 500 });

  return new Response("OK", { status: 200 });
});
