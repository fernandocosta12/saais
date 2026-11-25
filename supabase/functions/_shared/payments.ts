// Integração com o Asaas usando a conta de CADA restaurante.
// A chave de API vem do Vault (via get_payment_credentials) e nunca sai do servidor.
// Docs: https://docs.asaas.com

export type AsaasEnv = "sandbox" | "production";

const BASE: Record<AsaasEnv, string> = {
  sandbox: "https://api-sandbox.asaas.com/v3",
  production: "https://api.asaas.com/v3",
};
export const KEY_PREFIX: Record<AsaasEnv, string> = {
  sandbox: "$aact_hmlg_",
  production: "$aact_prod_",
};

export class AsaasError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export class AsaasClient {
  private apiKey: string;
  private env: AsaasEnv;
  constructor(apiKey: string, env: AsaasEnv) { this.apiKey = apiKey; this.env = env; }

  private async call(path: string, init: RequestInit = {}) {
    let res: Response;
    try {
      res = await fetch(`${BASE[this.env]}${path}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "PedidoDireto/1.0",
          "access_token": this.apiKey,
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (_e) {
      throw new AsaasError(0, "Sem resposta do Asaas");
    }
    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      const desc = data?.errors?.[0]?.description ?? `HTTP ${res.status}`;
      throw new AsaasError(res.status, String(desc));
    }
    return data;
  }

  /** Confere se a chave funciona neste ambiente. */
  async validate(): Promise<void> {
    await this.call("/customers?limit=1");
  }

  /** Nome comercial da conta (opcional, só para o dono conferir). */
  async accountName(): Promise<string | null> {
    try {
      const d = await this.call("/myAccount/commercialInfo");
      return d?.companyName || d?.name || null;
    } catch { return null; }
  }

  async createWebhook(url: string, authToken: string, email: string): Promise<string> {
    const d = await this.call("/webhooks", {
      method: "POST",
      body: JSON.stringify({
        name: "Pedido Direto",
        url, email, authToken,
        enabled: true, interrupted: false, apiVersion: 3, sendType: "SEQUENTIALLY",
        events: ["PAYMENT_RECEIVED", "PAYMENT_CONFIRMED"],
      }),
    });
    return d.id;
  }

  async deleteWebhook(id: string): Promise<void> {
    await this.call(`/webhooks/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async createCustomer(name: string, cpf: string, phone: string): Promise<string> {
    const d = await this.call("/customers", {
      method: "POST",
      // notificationDisabled: o Asaas não manda e-mail/SMS de cobrança ao cliente do restaurante
      body: JSON.stringify({ name, cpfCnpj: cpf, mobilePhone: phone, notificationDisabled: true }),
    });
    return d.id;
  }

  async createPix(i: { customerId: string; amountCents: number; description: string; externalReference: string }) {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
    const pay = await this.call("/payments", {
      method: "POST",
      body: JSON.stringify({
        customer: i.customerId, billingType: "PIX", value: i.amountCents / 100,
        dueDate: today, description: i.description, externalReference: i.externalReference,
      }),
    });
    const qr = await this.call(`/payments/${encodeURIComponent(pay.id)}/pixQrCode`);
    return { providerPaymentId: String(pay.id), copyPaste: String(qr.payload), qrCodeBase64: qr.encodedImage as string | undefined };
  }

  async getPayment(id: string) {
    return await this.call(`/payments/${encodeURIComponent(id)}`);
  }

  async deletePayment(id: string): Promise<void> {
    await this.call(`/payments/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
}

// ---------------------------------------------------------------------
export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

export function randomToken(bytes = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export async function sha256hex(s: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(h), (x) => x.toString(16).padStart(2, "0")).join("");
}

export function isValidCpf(raw: string): boolean {
  const c = String(raw || "").replace(/\D/g, "");
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  const dv = (len: number) => {
    let s = 0;
    for (let i = 0; i < len; i++) s += Number(c[i]) * (len + 1 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(c[9]) && dv(10) === Number(c[10]);
}

export type Credentials = {
  environment: AsaasEnv; status: string; provider_webhook_id: string | null;
  api_key: string; webhook_token: string;
};
