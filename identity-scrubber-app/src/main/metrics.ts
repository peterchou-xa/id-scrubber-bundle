const METRICS_URL =
  process.env.IDSCRUB_METRICS_URL ?? 'http://localhost:3030/api/metrics/scrub-events';

export interface ScrubMetricEvent {
  count: number;
  byType: Record<string, number>;
  clientId?: string;
}

export async function recordScrubEvent(event: ScrubMetricEvent): Promise<void> {
  try {
    const res = await fetch(METRICS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...event, timestamp: new Date().toISOString() }),
    });
    if (!res.ok) {
      console.warn('[metrics] non-OK response:', res.status, res.statusText);
    }
  } catch (err) {
    console.warn('[metrics] failed to post scrub event:', (err as Error).message);
  }
}
