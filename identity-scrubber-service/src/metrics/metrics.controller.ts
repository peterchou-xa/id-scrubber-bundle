import { BadRequestException, Body, Controller, Get, Post, Query } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import type { ScrubEventDto } from './dto/scrub-event.dto';

@Controller('api/metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Post('scrub-events')
  async recordEvent(@Body() body: ScrubEventDto) {
    if (!body || typeof body.count !== 'number' || body.count < 0) {
      throw new BadRequestException('count is required and must be a non-negative number');
    }
    if (!body.byType || typeof body.byType !== 'object') {
      throw new BadRequestException('byType is required and must be an object of pii type → count');
    }
    await this.metrics.record(body);
    return { ok: true };
  }

  @Get('scrub-summary')
  getSummary() {
    return this.metrics.getSummary();
  }

  @Get('scrub-history')
  async getHistory(@Query('hours') hours?: string) {
    const n = hours ? Number(hours) : 24;
    if (hours && (Number.isNaN(n) || n <= 0)) {
      throw new BadRequestException('hours must be a positive number');
    }
    return { rows: await this.metrics.getHistory(n) };
  }
}
