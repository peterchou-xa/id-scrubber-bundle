import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Polar } from '@polar-sh/sdk';
import { validateEvent, WebhookVerificationError } from '@polar-sh/sdk/webhooks';
import { BillingService } from '../billing.service';
import { TIER_PAGES, type Tier } from '../billing.constants';

const UUID_RE = /^[0-9a-f-]{36}$/i;

@Injectable()
export class PolarService {
  private readonly logger = new Logger(PolarService.name);
  private _client: Polar | null = null;

  constructor(private readonly billing: BillingService) {}

  // 'sandbox' (default) points the SDK at https://sandbox-api.polar.sh;
  // 'production' at the live API. Access tokens, products, and webhook secrets
  // are fully separated between the two environments.
  private get server(): 'sandbox' | 'production' {
    return (process.env.POLAR_SERVER ?? 'sandbox') === 'production'
      ? 'production'
      : 'sandbox';
  }

  // The UI shows a "TEST MODE" chip whenever we're pointed at the sandbox.
  isTestMode(): boolean {
    return this.server === 'sandbox';
  }

  private get client(): Polar {
    if (this._client) return this._client;
    const accessToken = process.env.POLAR_ACCESS_TOKEN;
    if (!accessToken) throw new Error('POLAR_ACCESS_TOKEN is not set');
    this._client = new Polar({ accessToken, server: this.server });
    return this._client;
  }

  private get webhookSecret(): string {
    const s = process.env.POLAR_WEBHOOK_SECRET;
    if (!s) throw new Error('POLAR_WEBHOOK_SECRET is not set');
    return s;
  }

  // One Polar product per tier. Unlike Lemon Squeezy, the same product UUID is
  // used both to create the checkout and to identify the order in the webhook,
  // so a single map covers both directions.
  private productIdFor(tier: Tier): string {
    const map: Record<Tier, string | undefined> = {
      starter: process.env.POLAR_PRODUCT_STARTER,
      pro: process.env.POLAR_PRODUCT_PRO,
      max: process.env.POLAR_PRODUCT_MAX,
    };
    const id = map[tier];
    if (!id) throw new Error(`POLAR_PRODUCT_${tier.toUpperCase()} is not set`);
    return id;
  }

  // Maps the product_id carried on order.paid back to one of our tiers.
  // product_id is the trust anchor: a user cannot change which product they
  // checked out into without paying that product's price, so it accurately
  // represents what they bought. Returns null for unrelated products so the
  // webhook can ignore orders that aren't ours.
  tierForProduct(productId: string | null | undefined): Tier | null {
    if (!productId) return null;
    const map: Record<Tier, string | undefined> = {
      starter: process.env.POLAR_PRODUCT_STARTER,
      pro: process.env.POLAR_PRODUCT_PRO,
      max: process.env.POLAR_PRODUCT_MAX,
    };
    for (const [tier, id] of Object.entries(map) as [Tier, string | undefined][]) {
      if (id && id === productId) return tier;
    }
    return null;
  }

  // Create a hosted Polar checkout session for this tier, embedding the
  // resolved account UUID in metadata so the order.paid webhook can grant
  // pages back to the right account. Returns the hosted-checkout URL.
  async createCheckoutUrl(tier: Tier, accountId: string): Promise<string> {
    const productId = this.productIdFor(tier);
    const successUrl = process.env.POLAR_CHECKOUT_SUCCESS_URL || undefined;
    const checkout = await this.client.checkouts.create({
      products: [productId],
      successUrl,
      metadata: { account_id: accountId, tier },
    });
    return checkout.url;
  }

  // Verify the Standard Webhooks signature over the raw body and return the
  // parsed event. validateEvent base64-encodes the secret internally, so we
  // pass the raw secret from the Polar dashboard as-is.
  verifyAndParse(rawBody: Buffer, headers: Record<string, unknown>): unknown {
    const normalized: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (typeof v === 'string') normalized[k] = v;
      else if (Array.isArray(v) && typeof v[0] === 'string') normalized[k] = v[0];
    }
    try {
      return validateEvent(rawBody, normalized, this.webhookSecret);
    } catch (e) {
      if (e instanceof WebhookVerificationError) {
        throw new UnauthorizedException('invalid signature');
      }
      throw e;
    }
  }

  // Dispatch a verified event. order.paid is the only grant path; everything
  // else (order.created, refunds, subscriptions, benefit grants) is ignored
  // in v1. Idempotency lives in grantPrepaid on provider_order_id.
  async processEvent(event: unknown): Promise<void> {
    const e = event as { type?: string; data?: Record<string, unknown> };
    if (e.type !== 'order.paid') {
      this.logger.log(`ignoring Polar event: ${e.type ?? '(missing)'}`);
      return;
    }
    return this.handleOrderPaid(e.data ?? {});
  }

  private async handleOrderPaid(order: Record<string, unknown>): Promise<void> {
    const orderId = typeof order.id === 'string' ? order.id : '';
    if (!orderId) throw new BadRequestException('missing order id');

    const metadata = (order.metadata ?? {}) as Record<string, unknown>;
    const accountId =
      typeof metadata.account_id === 'string' ? metadata.account_id : '';
    if (!accountId || !UUID_RE.test(accountId)) {
      // No usable account bridge — retrying won't help, so ack and move on.
      this.logger.warn(
        `Polar order.paid ${orderId}: missing/invalid account_id in metadata — ignoring`,
      );
      return;
    }

    const productId =
      typeof order.productId === 'string'
        ? order.productId
        : typeof order.product_id === 'string'
          ? (order.product_id as string)
          : null;
    const tier = this.tierForProduct(productId);
    if (!tier) {
      this.logger.warn(
        `Polar order.paid ${orderId}: product ${productId} is not one of ours — ignoring`,
      );
      return;
    }

    // Polar is a Merchant of Record, so total_amount can include tax. We store
    // it for analytics but derive the entitlement from product → tier, not from
    // the amount.
    const amountCents = Number(
      (order.totalAmount ?? order.total_amount ?? 0) as number,
    );

    const result = await this.billing.grantPrepaid({
      accountId,
      tier,
      providerOrderId: orderId,
      amountCents,
    });

    this.logger.log(
      `Polar order.paid ${orderId} tier=${tier} pages=${TIER_PAGES[tier]} ` +
        `acct=${accountId} granted=${result.granted}`,
    );
  }

  assertTier(value: unknown): Tier {
    if (value === 'starter' || value === 'pro' || value === 'max') return value;
    throw new BadRequestException('invalid tier');
  }
}
