// POST /functions/v1/payment-maintenance   (chamado só pelo pg_cron, a cada minuto)
// Cancela no Asaas as cobranças Pix que expiraram no nosso sistema, para que
// ninguém consiga pagar um pedido já cancelado (o QR Code do Asaas vale por muito mais tempo).
import { createClient } from "npm:@supabase/supabase-js@2";
import { AsaasClient, AsaasError, type Credentials } from "../_shared/payments.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const secret = req.headers.get("x-cron-secret") ?? "";
  const { data: ok } = await admin.rpc("verify_cron_secret", { p_secret: secret });
  if (ok !== true) return new Response("unauthorized", { status: 401 });

  const { data: rows, error } = await admin.rpc("payments_to_cancel", { p_limit: 50 });
  if (error) { console.error(error.message); return new Response("error", { status: 500 }); }

  const creds = new Map<string, Credentials | null>();
  let canceled = 0, failed = 0;
  for (const r of (rows ?? []) as { payment_id: string; store_id: string; provider: string; provider_payment_id: string }[]) {
    if (!creds.has(r.store_id)) {
      const { data } = await admin.rpc("get_payment_credentials", { p_store_id: r.store_id });
      creds.set(r.store_id, data as Credentials | null);
    }
    const c = creds.get(r.store_id);
    if (!c?.api_key) { await admin.rpc("mark_payment_canceled", { p_payment_id: r.payment_id, p_error: "loja sem conta de pagamento" }); failed++; continue; }
    try {
      await new AsaasClient(c.api_key, c.environment).deletePayment(r.provider_payment_id);
      await admin.rpc("mark_payment_canceled", { p_payment_id: r.payment_id, p_error: null });
      canceled++;
    } catch (e) {
      const err = e as AsaasError;
      // 404 = já não existe no Asaas: considera cancelada
      if (err.status === 404) { await admin.rpc("mark_payment_canceled", { p_payment_id: r.payment_id, p_error: null }); canceled++; }
      else { await admin.rpc("mark_payment_canceled", { p_payment_id: r.payment_id, p_error: err.message }); failed++; }
    }
  }
  return new Response(JSON.stringify({ canceled, failed }), { status: 200, headers: { "Content-Type": "application/json" } });
});
