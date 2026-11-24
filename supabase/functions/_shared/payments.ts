// Camada de pagamento: troca de gateway sem mexer no resto do sistema.
// Chaves ficam SOMENTE em secrets da Edge Function (nunca no frontend).

export interface PixCharge {
  providerPaymentId: string;
  copyPaste: string;
  qrCodeBase64?: string;
  expiresAt: string; // ISO
}

export interface WebhookResult {
  eventId: string;
  providerPaymentId: string;
  paid: boolean;
  paidAmountCents: number;
}

export interface PaymentProvider {
  name: string;
  createPix(input: { orderId: string; amountCents: number; customerName: string; customerPhone: string; description: string }): Promise<PixCharge>;
  // Valida a autenticidade do webhook e CONSULTA o gateway para confirmar
  // o status (nunca confiar só no corpo recebido).
  parseWebhook(req: Request, rawBody: string): Promise<WebhookResult | null>;
}

// ---------------------------------------------------------------------
// Asaas (https://docs.asaas.com) — sugestão inicial para o Brasil
class AsaasProvider implements PaymentProvider {
  name = "asaas";
  private base = Deno.env.get("ASAAS_BASE_URL") ?? "https://api-sandbox.asaas.com/v3";
  private key = Deno.env.get("ASAAS_API_KEY") ?? "";
  private webhookToken = Deno.env.get("ASAAS_WEBHOOK_TOKEN") ?? "";

  private async call(path: string, init: RequestInit = {}) {
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", "access_token": this.key, ...(init.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`Asaas ${path} -> ${res.status}`);
    return await res.json();
  }

  async createPix(i: { orderId: string; amountCents: number; customerName: string; customerPhone: string; description: string }): Promise<PixCharge> {
    // TODO: reaproveitar o customer do Asaas por telefone em vez de criar sempre
    const customer = await this.call("/customers", {
      method: "POST",
      body: JSON.stringify({ name: i.customerName, mobilePhone: i.customerPhone, externalReference: i.orderId }),
    });
    const due = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
    const pay = await this.call("/payments", {
      method: "POST",
      body: JSON.stringify({
        customer: customer.id, billingType: "PIX", value: i.amountCents / 100,
        dueDate: due, description: i.description, externalReference: i.orderId,
      }),
    });
    const qr = await this.call(`/payments/${pay.id}/pixQrCode`);
    return {
      providerPaymentId: pay.id,
      copyPaste: qr.payload,
      qrCodeBase64: qr.encodedImage,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };
  }

  async parseWebhook(req: Request, rawBody: string): Promise<WebhookResult | null> {
    // 1) autenticidade: token configurado no painel do Asaas
    const token = req.headers.get("asaas-access-token") ?? "";
    if (!this.webhookToken || !timingSafeEqual(token, this.webhookToken)) return null;
    const body = JSON.parse(rawBody);
    if (!body?.payment?.id || !body?.id) return null;
    // 2) não confia no corpo: consulta o pagamento na API
    const pay = await this.call(`/payments/${body.payment.id}`);
    const paid = ["RECEIVED", "CONFIRMED"].includes(pay.status) && pay.billingType === "PIX";
    return {
      eventId: String(body.id),
      providerPaymentId: pay.id,
      paid,
      paidAmountCents: Math.round(Number(pay.value) * 100),
    };
  }
}

// ---------------------------------------------------------------------
// Mock — só para desenvolvimento local. Bloqueado em produção.
class MockProvider implements PaymentProvider {
  name = "mock";
  async createPix(i: { orderId: string; amountCents: number }): Promise<PixCharge> {
    return {
      providerPaymentId: `mock_${crypto.randomUUID()}`,
      copyPaste: `00020126MOCK${i.orderId}${i.amountCents}`,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };
  }
  async parseWebhook(req: Request, rawBody: string): Promise<WebhookResult | null> {
    const secret = Deno.env.get("MOCK_WEBHOOK_SECRET") ?? "";
    if (!secret || !timingSafeEqual(req.headers.get("x-mock-secret") ?? "", secret)) return null;
    const b = JSON.parse(rawBody);
    return { eventId: b.event_id, providerPaymentId: b.payment_id, paid: true, paidAmountCents: b.amount_cents };
  }
}

export function getProvider(): PaymentProvider {
  const name = Deno.env.get("PAYMENT_PROVIDER") ?? "mock";
  const env = Deno.env.get("APP_ENV") ?? "development";
  if (name === "mock" && env === "production") throw new Error("Gateway mock não pode rodar em produção");
  return name === "asaas" ? new AsaasProvider() : new MockProvider();
}

export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}
