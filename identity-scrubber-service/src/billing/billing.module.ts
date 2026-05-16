import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { LemonSqueezyController } from './lemonsqueezy/lemonsqueezy.controller';
import { LemonSqueezyService } from './lemonsqueezy/lemonsqueezy.service';
import { InMemoryRateLimiter } from './lemonsqueezy/rate-limiter';

@Module({
  controllers: [BillingController, LemonSqueezyController],
  providers: [BillingService, LemonSqueezyService, InMemoryRateLimiter],
  exports: [BillingService, LemonSqueezyService],
})
export class BillingModule {}
