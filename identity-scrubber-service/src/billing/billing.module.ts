import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { PolarController } from './polar/polar.controller';
import { PolarService } from './polar/polar.service';

@Module({
  controllers: [BillingController, PolarController],
  providers: [BillingService, PolarService],
  exports: [BillingService, PolarService],
})
export class BillingModule {}
