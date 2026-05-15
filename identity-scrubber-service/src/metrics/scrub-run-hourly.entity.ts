import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'scrub_runs_hourly' })
export class ScrubRunHourly {
  @PrimaryColumn({ type: 'timestamptz' })
  hour: Date;

  @Column({ type: 'bigint' })
  runs: string;
}
