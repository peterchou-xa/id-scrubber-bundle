import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { LemonSqueezyService, type LsValidateResponse } from './lemonsqueezy.service';
import { BillingService } from '../billing.service';
import { InMemoryRateLimiter } from './rate-limiter';
import { TIER_PRICE_CENTS, type Tier } from '../billing.constants';

interface CheckoutUrlDto {
  machine_id?: string;
  device_id?: string;
  tier?: string;
}

interface RedeemDto {
  license_key?: string;
  machine_id?: string;
  device_id?: string;
}

// Per-key: at most 1 LS validate call per 30s. Caps brute-force key guessing.
const REDEEM_KEY_CAPACITY = 1;
const REDEEM_KEY_REFILL_PER_SEC = 1 / 30;

// Per-machine: ~5/min. Bounds any single client.
const REDEEM_MACHINE_CAPACITY = 5;
const REDEEM_MACHINE_REFILL_PER_SEC = 5 / 60;

@Controller('api')
export class LemonSqueezyController {
  private readonly logger = new Logger(LemonSqueezyController.name);

  constructor(
    private readonly ls: LemonSqueezyService,
    private readonly billing: BillingService,
    private readonly rateLimiter: InMemoryRateLimiter,
  ) {}

  @Post('checkout-url')
  async checkoutUrl(
    @Body() body: CheckoutUrlDto,
  ): Promise<{ url: string; test_mode: boolean }> {
    const tier = this.ls.assertTier(body?.tier);
    const accountId = await this.billing.resolveAccountId(
      body?.machine_id ?? '',
      body?.device_id ?? '',
    );
    if (!accountId) throw new BadRequestException('invalid_device');
    const url = this.ls.buildCheckoutUrl(tier, accountId);
    return { url, test_mode: this.ls.isTestMode() };
  }

  // Verify HMAC against the raw body BEFORE parsing JSON. Express has already
  // parsed the body for us into `req.body`, but raw bytes are preserved on
  // `req.rawBody` by the body-parser hook in main.ts.
  @Post('lemonsqueezy/webhook')
  @HttpCode(204)
  async webhook(@Req() req: Request & { rawBody?: Buffer }): Promise<void> {
    const raw = req.rawBody;
    if (!raw || !Buffer.isBuffer(raw)) {
      throw new BadRequestException('missing raw body');
    }
    this.ls.assertSignature(raw, req.headers['x-signature']);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new BadRequestException('invalid json');
    }
    await this.ls.processWebhook(
      parsed as Parameters<LemonSqueezyService['processWebhook']>[0],
    );
  }

  // Manual safety-net redeem. Lets a user paste their LS receipt key when
  // they want reassurance during the webhook-arrival window, or to recover
  // a grant if both webhooks failed permanently. Grant itself is idempotent
  // on ls_order_id so a late webhook after a redeem (or vice versa) is safe.
  @Post('redeem-license-key')
  @HttpCode(200)
  async redeem(@Body() body: RedeemDto): Promise<{
    ok: true;
    prepaid: { usage: number; granted: number } | null;
    pages_added: number;
  }> {
    const licenseKey = typeof body?.license_key === 'string' ? body.license_key.trim() : '';
    if (!licenseKey) throw new BadRequestException('missing license_key');
    const keyTail = licenseKey.slice(-6);
    this.logger.log(`redeem: start key=…${keyTail} mid=${body?.machine_id?.slice(0, 8)}…`);

    const accountId = await this.billing.resolveAccountId(
      body?.machine_id ?? '',
      body?.device_id ?? '',
    );
    if (!accountId) {
      this.logger.warn(`redeem: no account for device (key …${keyTail})`);
      throw new BadRequestException('no_account_for_device');
    }

    const existing = await this.billing.findPurchaseByLicenseKey(licenseKey);
    if (existing) {
      if (existing.account_id !== accountId) {
        this.logger.warn(
          `redeem: key …${keyTail} belongs to acct=${existing.account_id}, redeemed by acct=${accountId}`,
        );
        throw new ForbiddenException('key_belongs_to_other_account');
      }
      this.logger.log(`redeem: key …${keyTail} already bound to acct=${accountId} — 409 already_applied`);
      throw new ConflictException('already_applied');
    }

    // Rate-limit before calling LS. Per-key first (primary defense against
    // brute-force key guessing), then per-machine (bounds any single client).
    if (
      !this.rateLimiter.tryConsume(
        `key:${licenseKey}`,
        REDEEM_KEY_CAPACITY,
        REDEEM_KEY_REFILL_PER_SEC,
      )
    ) {
      throw new HttpException('rate_limited', HttpStatus.TOO_MANY_REQUESTS);
    }
    const machineId = (body?.machine_id ?? '').toLowerCase();
    if (
      machineId &&
      !this.rateLimiter.tryConsume(
        `mid:${machineId}`,
        REDEEM_MACHINE_CAPACITY,
        REDEEM_MACHINE_REFILL_PER_SEC,
      )
    ) {
      throw new HttpException('rate_limited', HttpStatus.TOO_MANY_REQUESTS);
    }

    let validation: LsValidateResponse;
    try {
      validation = await this.ls.validateLicenseKey(licenseKey);
    } catch (e) {
      this.logger.warn(`redeem: LS validate threw: ${(e as Error).message}`);
      throw new HttpException(
        'validate_unavailable',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    this.logger.log(
      `redeem: LS validate → valid=${validation.valid} ` +
        `store=${validation.meta?.store_id} product=${validation.meta?.product_id} ` +
        `order=${validation.meta?.order_id} key_created_at=${validation.license_key?.created_at} ` +
        `error=${validation.error ?? ''}`,
    );

    if (!validation.valid) {
      this.logger.warn(`redeem: LS says invalid (key …${keyTail}): ${validation.error ?? ''}`);
      throw new ForbiddenException('invalid_key');
    }
    if (!this.ls.isOurStore(validation.meta?.store_id)) {
      this.logger.warn(
        `redeem: store mismatch — LS returned ${validation.meta?.store_id}, expected ${this.ls.storeId}`,
      );
      throw new ForbiddenException('invalid_key');
    }

    let tier: Tier;
    try {
      tier = this.ls.tierForProduct(String(validation.meta?.product_id));
    } catch (e) {
      this.logger.warn(
        `redeem: product=${validation.meta?.product_id} order=${validation.meta?.order_id} ` +
          `store=${validation.meta?.store_id} — ${(e as Error).message}. ` +
          `Check LS_PRODUCT_{STARTER,PRO,MAX} env vars.`,
      );
      throw new ForbiddenException('invalid_key');
    }
    const lsOrderId = String(validation.meta?.order_id ?? '');
    if (!lsOrderId) throw new ForbiddenException('invalid_key');

    const grant = await this.billing.grantPrepaid({
      accountId,
      tier,
      lsOrderId,
      amountCents: TIER_PRICE_CENTS[tier],
    });
    await this.billing.setLicenseKeyForOrder(lsOrderId, licenseKey);

    const prepaid = await this.billing.getPrepaidView(accountId);
    this.logger.log(
      `manual redeem: order=${lsOrderId} tier=${tier} acct=${accountId} ` +
        `granted=${grant.granted} pages_added=${grant.pagesAdded}`,
    );
    return { ok: true, prepaid, pages_added: grant.pagesAdded };
  }
}
