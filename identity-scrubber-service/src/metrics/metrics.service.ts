import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { PiiType, ScrubEventDto } from './dto/scrub-event.dto';

export interface ScrubSummary {
  totalScrubbed: number;
  totalsByType: Partial<Record<PiiType, number>>;
  totalRuns: number;
}

export interface HourlyTypeRow {
  hour: string;
  piiType: string;
  count: number;
}

@Injectable()
export class MetricsService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async record(event: ScrubEventDto): Promise<void> {
    const entries = Object.entries(event.byType ?? {}).filter(([, n]) => Number(n) > 0);

    await this.ds.transaction(async (tx) => {
      if (entries.length > 0) {
        const valuesSql = entries
          .map((_, i) => `(date_trunc('hour', now()), $${i * 2 + 1}, $${i * 2 + 2})`)
          .join(', ');
        const params = entries.flatMap(([type, n]) => [type, Number(n)]);
        await tx.query(
          `INSERT INTO scrub_metrics_hourly (hour, pii_type, count)
           VALUES ${valuesSql}
           ON CONFLICT (hour, pii_type)
           DO UPDATE SET count = scrub_metrics_hourly.count + EXCLUDED.count`,
          params,
        );
      }

      await tx.query(
        `INSERT INTO scrub_runs_hourly (hour, runs)
         VALUES (date_trunc('hour', now()), 1)
         ON CONFLICT (hour)
         DO UPDATE SET runs = scrub_runs_hourly.runs + 1`,
      );
    });
  }

  async getSummary(): Promise<ScrubSummary> {
    const typeRows = await this.ds.query<Array<{ pii_type: string; total: string }>>(
      `SELECT pii_type, SUM(count)::bigint AS total
       FROM scrub_metrics_hourly
       GROUP BY pii_type`,
    );
    const totalsByType: Partial<Record<PiiType, number>> = {};
    let totalScrubbed = 0;
    for (const r of typeRows) {
      const n = Number(r.total);
      totalsByType[r.pii_type as PiiType] = n;
      totalScrubbed += n;
    }

    const runRows = await this.ds.query<Array<{ total: string }>>(
      `SELECT COALESCE(SUM(runs), 0)::bigint AS total FROM scrub_runs_hourly`,
    );
    const totalRuns = Number(runRows[0]?.total ?? 0);

    return { totalScrubbed, totalsByType, totalRuns };
  }

  async getHistory(hours = 24): Promise<HourlyTypeRow[]> {
    const rows = await this.ds.query<Array<{ hour: Date; pii_type: string; count: string }>>(
      `SELECT hour, pii_type, count
       FROM scrub_metrics_hourly
       WHERE hour >= date_trunc('hour', now()) - ($1 || ' hours')::interval
       ORDER BY hour DESC, pii_type ASC`,
      [hours],
    );
    return rows.map((r) => ({
      hour: r.hour.toISOString(),
      piiType: r.pii_type,
      count: Number(r.count),
    }));
  }
}
