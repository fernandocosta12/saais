// POST /functions/v1/create-order
// Body: { store_slug, action: "quote" | "create", payload: {...} }
// Público (verify_jwt = false): o cliente não precisa ter conta.
// Proteções: limite de requisições por IP e por telefone, tamanho máximo,
// preços recalculados no banco, Pix gerado no servidor.
import { createClient } from "npm:@supabase/supabase-js@2";
import { clientIp, corsHeaders, json, publicError } from "../_shared/http.ts";
import { getProvider } from "../_shared/payments.ts";

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

  let body: { store_slug?: string; action?: string; payload?: Record<string, unknown> };
  try { body = JSON.parse(raw); } catch { return json(req, { error: "JSON inválido" }, 400); }

  const slug = String(body.store_slug ?? "");
  if (!/^[a-z0-9-]{3,40}$/.test(slug) || typeof body.payload !== "object" || body.payload === null) {
    return json(req, { error: "Requisição inválida" }, 400);
  }
  const ip = clientIp(req);

  // ---- Prévia (sacola/cupom) ----
  if (body.action === "quote") {
    if (!(await allowed(`quote:${ip}`, 60, 60))) return json(req, { error: "Muitas tentativas. Aguarde um minuto." }, 429);
    const { data, error } = await supabase.rpc("quote_order", { p_store_slug: slug, p_payload: body.payload });
    if (error) return json(req, { error: publicError(error) }, 422);
    // devolve só o necessário (sem custo dos itens)
    return json(req, {
      subtotal_cents: data.subtotal_cents, discount_cents: data.discount_cents,
      delivery_fee_cents: data.delivery_fee_cents, total_cents: data.total_cents,
      coupon_code: data.coupon_code,
    });
  }

  if (body.action !== "create") return json(req, { error: "Ação inválida" }, 400);

  // ---- Criação do pedido ----
  const phone = String((body.payload as any)?.customer?.phone ?? "").replace(/\D/g, "");
  if (!(await allowed(`order-ip:${ip}`, 10, 600)) || !(await allowed(`order-phone:${phone}`, 5, 600))) {
    return json(req, { error: "Muitos pedidos em sequência. Aguarde alguns minutos." }, 429);
  }

  const { data: order, error } = await supabase.rpc("create_order", { p_store_slug: slug, p_payload: body.payload });
  if (error) return json(req, { error: publicError(error) }, 422);

  const result: Record<string, unknown> = {
    number: order.number, public_token: order.public_token, status: order.status, total_cents: order.total_cents,
  };

  if (order.payment_method === "pix") {
    try {
      const provider = getProvider();
      const pix = await provider.createPix({
        orderId: order.order_id, amountCents: order.total_cents,
        customerName: String((body.payload as any).customer?.name ?? ""), customerPhone: phone,
        description: `Pedido #${order.number}`,
      });
      const { error: regErr } = await supabase.rpc("register_payment", {
        p_order_id: order.order_id, p_provider: provider.name, p_provider_payment_id: pix.providerPaymentId,
        p_amount_cents: order.total_cents, p_pix_copy_paste: pix.copyPaste, p_expires_at: pix.expiresAt,
      });
      if (regErr) throw regErr;
      result.pix = { copy_paste: pix.copyPaste, qr_code_base64: pix.qrCodeBase64, expires_at: pix.expiresAt };
    } catch (e) {
      console.error("pix_error", order.order_id, (e as Error).message);
      result.pix_error = "Não conseguimos gerar o Pix agora. Tente novamente pelo link de acompanhamento.";
    }
  }

  return json(req, result, 201);
});
