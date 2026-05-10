import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScrubMetricsController } from './scrub-metrics.controller';
import { ScrubMetricsService } from './scrub-metrics.service';
import { ScrubMetricHourly } from './scrub-metric-hourly.entity';
import { ScrubRunHourly } from './scrub-run-hourly.entity';

@Module({
  imports: [TypeOrmModule.forFeature([ScrubMetricHourly, ScrubRunHourly])],
  controllers: [ScrubMetricsController],
  providers: [ScrubMetricsService],
  exports: [ScrubMetricsService],
})
export class ScrubMetricsModule {}
