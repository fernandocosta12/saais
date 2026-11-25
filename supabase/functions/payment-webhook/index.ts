// POST /functions/v1/payment-webhook?store=<store_id>   (chamado pelo Asaas do restaurante)
// 1. Valida o token do webhook daquela loja (header asaas-access-token)
// 2. Consulta o pagamento no Asaas com a chave da loja (não confia no corpo)
// 3. Confirma no banco, amarrado à loja e de forma idempotente
import { createClient } from "npm:@supabase/supabase-js@2";
import { AsaasClient, type Credentials, timingSafeEqual } from "../_shared/payments.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HANDLED = new Set(["PAYMENT_RECEIVED", "PAYMENT_CONFIRMED"]);

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const storeId = new URL(req.url).searchParams.get("store") ?? "";
  if (!UUID.test(storeId)) return new Response("bad request", { status: 400 });
  const raw = await req.text();
  if (raw.length > 100_000) return new Response("too large", { status: 413 });

  const { data: cred } = await supabase.rpc("get_payment_credentials", { p_store_id: storeId });
  const c = cred as Credentials | null;
  if (!c || !c.webhook_token) return new Response("unauthorized", { status: 401 });
  if (!timingSafeEqual(req.headers.get("asaas-access-token") ?? "", c.webhook_token)) {
    return new Response("unauthorized", { status: 401 });
  }

  let body: any;
  try { body = JSON.parse(raw); } catch { return new Response("bad request", { status: 400 }); }
  if (!body?.id || !body?.payment?.id) return new Response("ignored", { status: 200 });
  if (!HANDLED.has(String(body.event))) return new Response("ignored", { status: 200 });

  let pay: any;
  try {
    pay = await new AsaasClient(c.api_key, c.environment).getPayment(String(body.payment.id));
  } catch (e) {
    console.error("asaas_get_payment_error", (e as Error).message);
    return new Response("error", { status: 500 }); // o Asaas tenta de novo
  }
  const paid = ["RECEIVED", "CONFIRMED"].includes(pay?.status) && pay?.billingType === "PIX";
  if (!paid) return new Response("ignored", { status: 200 });

  const { data, error } = await supabase.rpc("confirm_store_payment", {
    p_store_id: storeId, p_provider: "asaas", p_event_id: String(body.id),
    p_provider_payment_id: String(pay.id), p_paid_amount_cents: Math.round(Number(pay.value) * 100),
    p_payload: { event: body.event, payment_id: pay.id, status: pay.status, value: pay.value },
  });
  if (error) {
    console.error("confirm_payment_error", error.message);
    return new Response("error", { status: 500 });
  }
  if (data !== "paid" && data !== "already_paid" && data !== "duplicate_event") {
    console.warn("payment_alert", data, pay.id, storeId); // cobrança de fora do sistema, valor divergente etc.
  }
  return new Response("ok", { status: 200 });
});
