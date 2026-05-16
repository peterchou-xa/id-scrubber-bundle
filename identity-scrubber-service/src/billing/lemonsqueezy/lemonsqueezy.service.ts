import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { BillingService } from '../billing.service';
import { TIER_PAGES, TIER_PRICE_CENTS, type Tier } from '../billing.constants';

// LS retries each event ~4 times over ~155s. 120s is below that ceiling so
// the 3rd retry naturally falls through to the validate-fallback path; below
// 120s we 500 to let order_created (and earlier retries) land first.
const WEBHOOK_RACE_THRESHOLD_MS = 120_000;
const LS_API_BASE = 'https://api.lemonsqueezy.com';

interface LsWebhookEnvelope {
  meta?: {
    event_name?: string;
    custom_data?: { account_id?: string; tier?: string } | null;
    test_mode?: boolean;
  };
  data?: {
    id?: string | number;
    attributes?: {
      total?: number;
      total_usd?: number;
      test_mode?: boolean;
      // license_key_created payload
      key?: string;
      order_id?: string | number;
      created_at?: string;
    };
  };
}

export interface LsValidateResponse {
  valid: boolean;
  error?: string | null;
  license_key?: {
    id?: number;
    status?: string;
    key?: string;
    created_at?: string;
    expires_at?: string | null;
    test_mode?: boolean;
  };
  meta?: {
    store_id?: number | string;
    order_id?: number | string;
    product_id?: number | string;
  };
}

@Injectable()
export class LemonSqueezyService {
  private readonly logger = new Logger(LemonSqueezyService.name);

  constructor(private readonly billing: BillingService) {}

  private get webhookSecret(): string {
    const s = process.env.LS_WEBHOOK_SECRET;
    if (!s) throw new Error('LS_WEBHOOK_SECRET is not set');
    return s;
  }

  get storeId(): string {
    const s = process.env.LS_STORE_ID;
    if (!s) throw new Error('LS_STORE_ID is not set');
    return s;
  }

  isTestMode(): boolean {
    return (process.env.LS_TEST_MODE ?? '').toLowerCase() === 'true';
  }

  // Product UUID used in the hosted-checkout URL path (/checkout/buy/<uuid>).
  checkoutIdFor(tier: Tier): string {
    const map: Record<Tier, string | undefined> = {
      starter: process.env.LS_STARTER_CHECKOUT_ID,
      pro: process.env.LS_PRO_CHECKOUT_ID,
      max: process.env.LS_MAX_CHECKOUT_ID,
    };
    const v = map[tier];
    if (!v) throw new Error(`LS checkout ID for tier '${tier}' is not configured`);
    return v;
  }

  // Maps an LS product_id (numeric, from validate response) back to one of
  // our tiers via env vars. product_id is the trust anchor in the fallback
  // path — the user can't switch which product they bought at checkout
  // without paying that product's price.
  tierForProduct(productId: string): Tier {
    const map: Record<Tier, string | undefined> = {
      starter: process.env.LS_PRODUCT_STARTER,
      pro: process.env.LS_PRODUCT_PRO,
      max: process.env.LS_PRODUCT_MAX,
    };
    for (const [tier, id] of Object.entries(map) as [Tier, string | undefined][]) {
      if (id && id === productId) return tier;
    }
    throw new Error(`unknown LS product_id: ${productId}`);
  }

  isOurStore(storeId: string | number | undefined): boolean {
    return storeId != null && String(storeId) === this.storeId;
  }

  // Constant-time HMAC-SHA256 verification of the raw request body.
  verifyHmac(rawBody: Buffer, signatureHex: string | undefined): boolean {
    if (!signatureHex || typeof signatureHex !== 'string') return false;
    const expected = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(rawBody)
      .digest('hex');
    const a = Buffer.from(expected, 'hex');
    let b: Buffer;
    try {
      b = Buffer.from(signatureHex, 'hex');
    } catch {
      return false;
    }
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  buildCheckoutUrl(tier: Tier, accountId: string): string {
    const checkoutId = this.checkoutIdFor(tier);
    const base = `https://${this.storeSlug()}.lemonsqueezy.com/checkout/buy/${checkoutId}`;
    const params = new URLSearchParams();
    params.set('checkout[custom][account_id]', accountId);
    params.set('checkout[custom][tier]', tier);
    return `${base}?${params.toString()}`;
  }

  private storeSlug(): string {
    return process.env.LS_STORE_SLUG ?? this.storeId;
  }

  // Process a verified webhook envelope. Dispatches by event_name.
  async processWebhook(envelope: LsWebhookEnvelope): Promise<void> {
    const eventType = envelope.meta?.event_name;
    if (eventType === 'order_created') {
      return this.handleOrderCreated(envelope);
    }
    if (eventType === 'license_key_created') {
      return this.handleLicenseKeyCreated(envelope);
    }
    this.logger.log(`ignoring LS event: ${eventType ?? '(missing)'}`);
  }

  private async handleOrderCreated(envelope: LsWebhookEnvelope): Promise<void> {
    const accountId = envelope.meta?.custom_data?.account_id;
    if (!accountId || !/^[0-9a-f-]{36}$/i.test(accountId)) {
      throw new BadRequestException('missing or invalid account_id in custom_data');
    }

    const tier = this.assertTier(envelope.meta?.custom_data?.tier);

    const order = envelope.data;
    const orderId = order?.id != null ? String(order.id) : '';
    const amountCents = Number(order?.attributes?.total ?? 0);
    const testMode = !!(envelope.meta?.test_mode ?? order?.attributes?.test_mode);

    if (!orderId) throw new BadRequestException('missing order id');

    // custom_data is untrusted — a tampered checkout URL could claim a
    // higher tier than the buyer is actually paying for. Reject unless the
    // order amount matches the expected price for the claimed tier.
    const expectedCents = TIER_PRICE_CENTS[tier];
    if (amountCents !== expectedCents) {
      this.logger.warn(
        `LS order ${orderId}: amount ${amountCents}c does not match tier ${tier} ` +
          `expected ${expectedCents}c — refusing to grant`,
      );
      throw new BadRequestException('amount does not match claimed tier');
    }

    const result = await this.billing.grantPrepaid({
      accountId,
      tier,
      lsOrderId: orderId,
      amountCents,
    });

    this.logger.log(
      `LS order_created ${orderId} tier=${tier} pages=${TIER_PAGES[tier]} ` +
        `acct=${accountId} granted=${result.granted} test=${testMode}`,
    );
  }

  // license_key_created normally just populates purchases.license_key for
  // the row that order_created already inserted. If the matching row doesn't
  // exist yet, return 500 for a short race window so LS retries; after that
  // window we fall through to a validate-based grant so the order isn't lost
  // if order_created never lands.
  private async handleLicenseKeyCreated(envelope: LsWebhookEnvelope): Promise<void> {
    const accountId = envelope.meta?.custom_data?.account_id;
    if (!accountId || !/^[0-9a-f-]{36}$/i.test(accountId)) {
      throw new BadRequestException('missing or invalid account_id in custom_data');
    }

    const attr = envelope.data?.attributes ?? {};
    const orderId = attr.order_id != null ? String(attr.order_id) : '';
    const licenseKey = typeof attr.key === 'string' ? attr.key : '';
    const createdAt = attr.created_at ? new Date(attr.created_at).getTime() : Date.now();
    if (!orderId) throw new BadRequestException('missing order_id');
    if (!licenseKey) throw new BadRequestException('missing license key');

    const updated = await this.billing.setLicenseKeyForOrder(orderId, licenseKey);
    if (updated) {
      this.logger.log(`LS license_key_created bound to order ${orderId}`);
      return;
    }

    const ageMs = Date.now() - createdAt;
    if (ageMs < WEBHOOK_RACE_THRESHOLD_MS) {
      this.logger.log(
        `LS license_key_created for order ${orderId}: no matching purchases row yet ` +
          `(age=${Math.round(ageMs / 1000)}s) — 500 to retry`,
      );
      // 500 → LS retries this event, giving order_created its own retry window.
      throw new InternalServerErrorException('purchase not yet recorded; retry');
    }

    // Fallback grant path. order_created appears to be permanently lost;
    // verify the license with LS, derive the tier from variant_id, and grant.
    this.logger.warn(
      `LS license_key_created for order ${orderId}: order_created absent after ` +
        `${Math.round(ageMs / 1000)}s — falling back to validate-based grant`,
    );

    const validation = await this.validateLicenseKey(licenseKey);
    if (!validation.valid) {
      throw new InternalServerErrorException(`license validate returned invalid: ${validation.error ?? ''}`);
    }
    if (!this.isOurStore(validation.meta?.store_id)) {
      throw new InternalServerErrorException('license belongs to a different LS store');
    }
    const tier = this.tierForProduct(String(validation.meta?.product_id));
    const validatedOrderId = String(validation.meta?.order_id ?? orderId);
    await this.billing.grantPrepaid({
      accountId,
      tier,
      lsOrderId: validatedOrderId,
      amountCents: TIER_PRICE_CENTS[tier],
    });
    await this.billing.setLicenseKeyForOrder(validatedOrderId, licenseKey);
    this.logger.log(
      `LS license_key_created fallback granted: order=${validatedOrderId} tier=${tier} acct=${accountId}`,
    );
  }

  // POST /v1/licenses/validate. Auth is the license key itself, so no
  // LS_API_KEY is needed. Used by both the webhook fallback and the manual
  // redeem endpoint.
  async validateLicenseKey(licenseKey: string): Promise<LsValidateResponse> {
    const res = await fetch(`${LS_API_BASE}/v1/licenses/validate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({ license_key: licenseKey }).toString(),
    });
    // Both 200 (valid) and 400 (invalid) return a JSON body with `valid`.
    // Anything else (5xx, network) means we can't trust the answer.
    if (res.status !== 200 && res.status !== 400) {
      throw new Error(`LS validate HTTP ${res.status}`);
    }
    return (await res.json()) as LsValidateResponse;
  }

  assertTier(value: unknown): Tier {
    if (value === 'starter' || value === 'pro' || value === 'max') return value;
    throw new BadRequestException('invalid tier');
  }

  // Used by /lemonsqueezy/webhook controller to bail out before parsing JSON.
  assertSignature(rawBody: Buffer, header: unknown): void {
    const sig = typeof header === 'string' ? header : Array.isArray(header) ? header[0] : '';
    if (!this.verifyHmac(rawBody, sig)) {
      throw new UnauthorizedException('invalid signature');
    }
  }
}
