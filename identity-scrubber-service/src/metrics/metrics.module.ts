import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { ScrubMetricHourly } from './scrub-metric-hourly.entity';
import { ScrubRunHourly } from './scrub-run-hourly.entity';

@Module({
  imports: [TypeOrmModule.forFeature([ScrubMetricHourly, ScrubRunHourly])],
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
