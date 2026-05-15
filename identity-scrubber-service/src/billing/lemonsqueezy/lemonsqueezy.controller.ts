import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { LemonSqueezyService } from './lemonsqueezy.service';
import { BillingService } from '../billing.service';

interface CheckoutUrlDto {
  machine_id?: string;
  device_id?: string;
  tier?: string;
}

@Controller('api')
export class LemonSqueezyController {
  constructor(
    private readonly ls: LemonSqueezyService,
    private readonly billing: BillingService,
  ) {}

  @Post('checkout-url')
  async checkoutUrl(@Body() body: CheckoutUrlDto): Promise<{ url: string; test_mode: boolean }> {
    const tier = this.ls.assertTier(body?.tier);
    const accountId = await this.billing.resolveAccountId(
      body?.machine_id ?? '',
      body?.device_id ?? '',
    );
    if (!accountId) throw new BadRequestException('invalid_device');
    const url = this.ls.buildCheckoutUrl(tier, accountId);
    return { url, test_mode: this.ls.isTestMode() };
  }

  @Get('license-info')
  async licenseInfo(
    @Query('machine_id') machineId: string,
    @Query('device_id') deviceId: string,
  ): Promise<{ license_key: string | null }> {
    const accountId = await this.billing.resolveAccountId(machineId ?? '', deviceId ?? '');
    if (!accountId) throw new BadRequestException('invalid_device');
    const key = await this.billing.getLicenseKey(accountId);
    return { license_key: key };
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
    await this.ls.processWebhook(parsed as Parameters<LemonSqueezyService['processWebhook']>[0]);
  }
}
