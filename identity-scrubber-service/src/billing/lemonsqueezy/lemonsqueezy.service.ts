import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { BillingService } from '../billing.service';
import { TIER_PAGES, TIER_PRICE_CENTS, type Tier } from '../billing.constants';

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
      license_key?: string;
      test_mode?: boolean;
    };
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

  private get storeId(): string {
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

  // Build a Lemon Squeezy hosted checkout URL. Embeds account_id and tier
  // as custom_data so the webhook can map the order back to our DB without
  // needing variant-ID lookups. The tier is treated as untrusted input on
  // the webhook side — we verify it against the order amount before
  // granting.
  buildCheckoutUrl(tier: Tier, accountId: string): string {
    const checkoutId = this.checkoutIdFor(tier);
    const base = `https://${this.storeSlug()}.lemonsqueezy.com/checkout/buy/${checkoutId}`;
    const params = new URLSearchParams();
    params.set('checkout[custom][account_id]', accountId);
    params.set('checkout[custom][tier]', tier);
    return `${base}?${params.toString()}`;
  }

  private storeSlug(): string {
    // LS exposes hosted checkouts at <store-slug>.lemonsqueezy.com. The slug
    // is configured separately from the numeric store id; if not provided,
    // fall back to the store id (works when the slug equals the id).
    return process.env.LS_STORE_SLUG ?? this.storeId;
  }

  // Process a verified webhook envelope. Only order_created grants; all
  // other event types are accepted and ignored.
  async processWebhook(envelope: LsWebhookEnvelope): Promise<void> {
    const eventType = envelope.meta?.event_name;
    if (eventType !== 'order_created') {
      this.logger.log(`ignoring LS event: ${eventType ?? '(missing)'}`);
      return;
    }

    const accountId = envelope.meta?.custom_data?.account_id;
    if (!accountId || !/^[0-9a-f-]{36}$/i.test(accountId)) {
      throw new BadRequestException('missing or invalid account_id in custom_data');
    }

    const claimedTier = envelope.meta?.custom_data?.tier;
    const tier = this.assertTier(claimedTier);

    const order = envelope.data;
    const orderId = order?.id != null ? String(order.id) : '';
    const amountCents = Number(order?.attributes?.total ?? 0);
    const licenseKey = order?.attributes?.license_key ?? null;
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
      licenseKey,
    });

    this.logger.log(
      `LS order_created ${orderId} tier=${tier} pages=${TIER_PAGES[tier]} ` +
        `acct=${accountId} granted=${result.granted} test=${testMode}`,
    );
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
