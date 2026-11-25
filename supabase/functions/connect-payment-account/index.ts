// POST /functions/v1/connect-payment-account   (painel; exige login — a função valida o token do usuário)
// Body: { action: "connect", store_id, environment: "sandbox"|"production", api_key }
//    ou { action: "disconnect", store_id }
// Só o DONO da loja pode conectar/desconectar. A chave é validada no Asaas,
// o webhook é registrado automaticamente na conta do restaurante e a chave
// vai para o Vault. A chave nunca é devolvida ao navegador.
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/http.ts";
import { AsaasClient, type AsaasEnv, AsaasError, type Credentials, KEY_PREFIX, randomToken } from "../_shared/payments.ts";

const URL_BASE = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(URL_BASE, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "Método não permitido" }, 405);

  // Quem está chamando?
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u, error: uErr } = await admin.auth.getUser(jwt);
  if (uErr || !u?.user) return json(req, { error: "Faça login novamente." }, 401);
  const user = u.user;

  let body: any;
  try { body = JSON.parse(await req.text()); } catch { return json(req, { error: "JSON inválido" }, 400); }
  const storeId = String(body?.store_id ?? "");
  if (!UUID.test(storeId)) return json(req, { error: "Loja inválida" }, 400);

  const { data: member } = await admin.from("store_members").select("role")
    .eq("store_id", storeId).eq("user_id", user.id).maybeSingle();
  if (member?.role !== "owner") return json(req, { error: "Somente o dono da loja pode alterar a conta de pagamento." }, 403);

  const { data: rl } = await admin.rpc("check_rate_limit", { p_key: `connect:${user.id}`, p_max: 10, p_window_seconds: 3600 });
  if (rl !== true) return json(req, { error: "Muitas tentativas. Aguarde um pouco." }, 429);

  const { data: oldCred } = await admin.rpc("get_payment_credentials", { p_store_id: storeId });
  const old = oldCred as Credentials | null;

  // ------------------------------------------------------------- desconectar
  if (body.action === "disconnect") {
    if (old?.api_key && old.provider_webhook_id) {
      try { await new AsaasClient(old.api_key, old.environment).deleteWebhook(old.provider_webhook_id); }
      catch (e) { console.warn("delete_webhook_failed", (e as Error).message); }
    }
    // roda com a sessão do usuário: a função confere de novo se ele é o dono
    const userClient = createClient(URL_BASE, Deno.env.get("SUPABASE_ANON_KEY")!, {
      auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { error } = await userClient.rpc("disconnect_payment_account", { p_store_id: storeId });
    if (error) return json(req, { error: error.message }, 400);
    return json(req, { ok: true });
  }

  // ------------------------------------------------------------- conectar
  if (body.action !== "connect") return json(req, { error: "Ação inválida" }, 400);
  const env = body.environment as AsaasEnv;
  const apiKey = String(body.api_key ?? "").trim();
  if (env !== "sandbox" && env !== "production") return json(req, { error: "Escolha o ambiente." }, 400);
  if (!apiKey.startsWith(KEY_PREFIX[env]) || apiKey.length < 30 || apiKey.length > 300 || /\s/.test(apiKey)) {
    return json(req, {
      error: env === "sandbox"
        ? "Essa não parece uma chave de TESTE do Asaas (ela começa com $aact_hmlg_)."
        : "Essa não parece uma chave de PRODUÇÃO do Asaas (ela começa com $aact_prod_).",
    }, 422);
  }

  const asaas = new AsaasClient(apiKey, env);
  try {
    await asaas.validate();
  } catch (e) {
    const s = (e as AsaasError).status;
    return json(req, { error: s === 401 ? "O Asaas recusou a chave. Confira se copiou inteira e se é do ambiente certo." : "Não foi possível falar com o Asaas agora. Tente de novo." }, 422);
  }

  // remove o webhook anterior (troca de chave/ambiente)
  if (old?.api_key && old.provider_webhook_id) {
    try { await new AsaasClient(old.api_key, old.environment).deleteWebhook(old.provider_webhook_id); }
    catch (e) { console.warn("delete_old_webhook_failed", (e as Error).message); }
  }

  const token = randomToken(32); // 64 caracteres hex
  let webhookId: string;
  try {
    webhookId = await asaas.createWebhook(
      `${URL_BASE}/functions/v1/payment-webhook?store=${storeId}`, token, user.email ?? "",
    );
  } catch (e) {
    console.error("create_webhook_failed", (e as Error).message);
    return json(req, { error: "A chave é válida, mas não conseguimos registrar o aviso de pagamento (webhook) no Asaas: " + (e as Error).message }, 422);
  }

  const accountName = await asaas.accountName();
  const { error } = await admin.rpc("save_payment_account", {
    p_store_id: storeId, p_environment: env, p_api_key: apiKey, p_webhook_token: token,
    p_provider_webhook_id: webhookId, p_account_name: accountName, p_user_id: user.id,
  });
  if (error) {
    try { await asaas.deleteWebhook(webhookId); } catch { /* best effort */ }
    console.error("save_payment_account_error", error.message);
    return json(req, { error: "Não foi possível salvar a conta de pagamento." }, 500);
  }
  return json(req, { ok: true, environment: env, account_name: accountName, key_hint: apiKey.slice(-4) });
});
