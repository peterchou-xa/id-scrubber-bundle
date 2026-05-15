import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { LemonSqueezyController } from './lemonsqueezy/lemonsqueezy.controller';
import { LemonSqueezyService } from './lemonsqueezy/lemonsqueezy.service';

@Module({
  controllers: [BillingController, LemonSqueezyController],
  providers: [BillingService, LemonSqueezyService],
  exports: [BillingService, LemonSqueezyService],
})
export class BillingModule {}
