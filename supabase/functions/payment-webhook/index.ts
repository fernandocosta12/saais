// POST /functions/v1/payment-webhook  (chamado pelo gateway, não pelo navegador)
// 1. Valida a autenticidade (token/assinatura do gateway)
// 2. Consulta o gateway para confirmar o status real
// 3. Confirma no banco de forma idempotente (mesmo evento 2x não paga 2x)
import { createClient } from "npm:@supabase/supabase-js@2";
import { getProvider } from "../_shared/payments.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const raw = await req.text();
  if (raw.length > 100_000) return new Response("too large", { status: 413 });

  const provider = getProvider();
  let evt;
  try {
    evt = await provider.parseWebhook(req, raw);
  } catch (e) {
    console.error("webhook_parse_error", (e as Error).message);
    return new Response("error", { status: 500 }); // gateway tenta de novo
  }
  if (!evt) return new Response("unauthorized", { status: 401 });
  if (!evt.paid) return new Response("ignored", { status: 200 });

  let payload: unknown = {};
  try { payload = JSON.parse(raw); } catch { /* guarda vazio */ }

  const { data, error } = await supabase.rpc("confirm_payment", {
    p_provider: provider.name, p_event_id: evt.eventId, p_provider_payment_id: evt.providerPaymentId,
    p_paid_amount_cents: evt.paidAmountCents, p_payload: payload,
  });
  if (error) {
    console.error("confirm_payment_error", error.message);
    return new Response("error", { status: 500 });
  }
  if (data === "amount_mismatch" || data === "payment_not_found") {
    console.warn("payment_alert", data, evt.providerPaymentId); // investigar
  }
  return new Response("ok", { status: 200 });
});
