import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'scrub_metrics_hourly' })
export class ScrubMetricHourly {
  @PrimaryColumn({ type: 'timestamptz' })
  hour: Date;

  @PrimaryColumn({ name: 'pii_type', type: 'text' })
  piiType: string;

  @Column({ type: 'bigint' })
  count: string;
}
