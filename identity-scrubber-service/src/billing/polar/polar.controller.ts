import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { PolarService } from './polar.service';
import { BillingService } from '../billing.service';

interface CheckoutUrlDto {
  machine_id?: string;
  device_id?: string;
  tier?: string;
}

@Controller('api')
export class PolarController {
  constructor(
    private readonly polar: PolarService,
    private readonly billing: BillingService,
  ) {}

  // Resolve (machine_id, device_id) -> account UUID server-side (same trust
  // model as /consume), then create a Polar checkout session embedding that
  // UUID in metadata. The renderer only ever knows the device IDs; the account
  // UUID never leaves the server except inside the Polar round-trip.
  @Post('checkout-url')
  async checkoutUrl(
    @Body() body: CheckoutUrlDto,
  ): Promise<{ url: string; test_mode: boolean }> {
    const tier = this.polar.assertTier(body?.tier);
    const accountId = await this.billing.resolveAccountId(
      body?.machine_id ?? '',
      body?.device_id ?? '',
    );
    if (!accountId) throw new BadRequestException('invalid_device');
    const url = await this.polar.createCheckoutUrl(tier, accountId);
    return { url, test_mode: this.polar.isTestMode() };
  }

  // The only endpoint that grants prepaid pages. Verify the Standard Webhooks
  // signature over the raw bytes BEFORE trusting the body, then dispatch.
  // Raw bytes are preserved on req.rawBody by the body-parser hook in main.ts.
  @Post('polar/webhook')
  @HttpCode(204)
  async webhook(@Req() req: Request & { rawBody?: Buffer }): Promise<void> {
    const raw = req.rawBody;
    if (!raw || !Buffer.isBuffer(raw)) {
      throw new BadRequestException('missing raw body');
    }
    const event = this.polar.verifyAndParse(raw, req.headers);
    await this.polar.processEvent(event);
  }
}
