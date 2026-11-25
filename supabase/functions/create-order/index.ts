// POST /functions/v1/create-order
// Body: { store_slug, action: "quote" | "create", payload: {...} }
// Público (verify_jwt = false): o cliente não precisa ter conta.
// Proteções: limite de requisições por IP e por telefone, tamanho máximo,
// preços recalculados no banco, Pix gerado no servidor com a conta Asaas da loja.
import { createClient } from "npm:@supabase/supabase-js@2";
import { clientIp, corsHeaders, json, publicError } from "../_shared/http.ts";
import { AsaasClient, type Credentials, isValidCpf, sha256hex } from "../_shared/payments.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, // só existe no servidor
  { auth: { persistSession: false } },
);

async function allowed(key: string, max: number, windowSec: number) {
  const { data, error } = await supabase.rpc("check_rate_limit", { p_key: key, p_max: max, p_window_seconds: windowSec });
  return !error && data === true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "Método não permitido" }, 405);

  const raw = await req.text();
  if (raw.length > 20_000) return json(req, { error: "Requisição muito grande" }, 413);

  let body: { store_slug?: string; action?: string; payload?: Record<string, any> };
  try { body = JSON.parse(raw); } catch { return json(req, { error: "JSON inválido" }, 400); }

  const slug = String(body.store_slug ?? "");
  if (!/^[a-z0-9-]{3,40}$/.test(slug) || typeof body.payload !== "object" || body.payload === null) {
    return json(req, { error: "Requisição inválida" }, 400);
  }
  const ip = clientIp(req);

  // O CPF nunca vai para o banco: separamos aqui e usamos só no Asaas.
  const cpf = String(body.payload?.customer?.cpf ?? "").replace(/\D/g, "");
  const payload = structuredClone(body.payload);
  if (payload.customer) delete payload.customer.cpf;

  // ---- Prévia (sacola/cupom) ----
  if (body.action === "quote") {
    if (!(await allowed(`quote:${ip}`, 60, 60))) return json(req, { error: "Muitas tentativas. Aguarde um minuto." }, 429);
    const { data, error } = await supabase.rpc("quote_order", { p_store_slug: slug, p_payload: payload });
    if (error) return json(req, { error: publicError(error) }, 422);
    return json(req, {
      subtotal_cents: data.subtotal_cents, discount_cents: data.discount_cents,
      delivery_fee_cents: data.delivery_fee_cents, total_cents: data.total_cents,
      coupon_code: data.coupon_code,
    });
  }

  if (body.action !== "create") return json(req, { error: "Ação inválida" }, 400);

  // ---- Criação do pedido ----
  const phone = String(payload?.customer?.phone ?? "").replace(/\D/g, "");
  if (!(await allowed(`order-ip:${ip}`, 10, 600)) || !(await allowed(`order-phone:${phone}`, 5, 600))) {
    return json(req, { error: "Muitos pedidos em sequência. Aguarde alguns minutos." }, 429);
  }
  const isPix = payload.payment_method === "pix";
  if (isPix && !isValidCpf(cpf)) return json(req, { error: "Informe um CPF válido para pagar com Pix." }, 422);

  const { data: order, error } = await supabase.rpc("create_order", { p_store_slug: slug, p_payload: payload });
  if (error) return json(req, { error: publicError(error) }, 422);

  const result: Record<string, unknown> = {
    number: order.number, public_token: order.public_token, status: order.status, total_cents: order.total_cents,
  };

  if (isPix) {
    try {
      const { data: store } = await supabase.from("stores").select("id").eq("slug", slug).single();
      const { data: cred } = await supabase.rpc("get_payment_credentials", { p_store_id: store!.id });
      const c = cred as Credentials | null;
      if (!c || c.status !== "active" || !c.api_key) throw new Error("conta de pagamento inativa");
      const asaas = new AsaasClient(c.api_key, c.environment);

      const cpfHash = await sha256hex(`${store!.id}:${cpf}`);
      let customerId = (await supabase.rpc("get_payment_customer", { p_store_id: store!.id, p_cpf_hash: cpfHash })).data as string | null;
      if (!customerId) {
        customerId = await asaas.createCustomer(String(payload.customer?.name ?? "Cliente").slice(0, 80), cpf, phone);
        await supabase.rpc("save_payment_customer", { p_store_id: store!.id, p_cpf_hash: cpfHash, p_provider_customer_id: customerId });
      }

      const pix = await asaas.createPix({
        customerId, amountCents: order.total_cents,
        description: `Pedido #${order.number}`, externalReference: order.order_id,
      });
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      const { error: regErr } = await supabase.rpc("register_payment", {
        p_order_id: order.order_id, p_provider: "asaas", p_provider_payment_id: pix.providerPaymentId,
        p_amount_cents: order.total_cents, p_pix_copy_paste: pix.copyPaste, p_expires_at: expiresAt,
      });
      if (regErr) throw regErr;
      result.pix = { copy_paste: pix.copyPaste, qr_code_base64: pix.qrCodeBase64, expires_at: expiresAt };
    } catch (e) {
      console.error("pix_error", order.order_id, (e as Error).message);
      result.pix_error = "Não conseguimos gerar o Pix agora. Faça um novo pedido ou escolha outra forma de pagamento.";
    }
  }

  return json(req, result, 201);
});
