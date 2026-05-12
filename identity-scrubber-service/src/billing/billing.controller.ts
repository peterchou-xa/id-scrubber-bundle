import { Body, Controller, Post } from '@nestjs/common';
import { BillingService } from './billing.service';
import type { BalanceQueryDto, ConsumeDto } from './dto/consume.dto';

@Controller('api')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Post('consume')
  consume(@Body() body: ConsumeDto) {
    return this.billing.consume(body);
  }

  @Post('balance')
  balance(@Body() body: BalanceQueryDto) {
    return this.billing.getBalance(body);
  }
}
