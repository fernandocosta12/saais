// Utilitários HTTP comuns às Edge Functions
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);

const IS_PROD = (Deno.env.get("APP_ENV") ?? "development") === "production";

export function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get("origin") ?? "";
  // Produção: só os domínios listados em ALLOWED_ORIGINS.
  // Desenvolvimento sem lista configurada: libera qualquer origem.
  let allow: string;
  if (ALLOWED_ORIGINS.length === 0) allow = IS_PROD ? "" : "*";
  else allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
}

// Mensagens vindas do banco (raise exception) são seguras para o cliente;
// erros inesperados viram mensagem genérica (não vaza detalhes internos).
const SAFE_DB_ERROR = /^(Loja|A loja|Escolha|A sacola|Item|Quantidade|Um dos|Um adicional|Adicionais|Pedido mínimo|Cupom|Este cupom|Informe|O valor|Forma de)/;
export function publicError(err: unknown): string {
  const msg = (err as { message?: string })?.message ?? "";
  return SAFE_DB_ERROR.test(msg) ? msg : "Não foi possível processar o pedido. Tente novamente.";
}
