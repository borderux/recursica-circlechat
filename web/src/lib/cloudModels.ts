// Fork: the "Cloud models" setting on a task. Mirrors
// api/src/lib/cloud-models-rules.ts.

export type CloudModelsSetting =
  | { mode: "cluster_only" }
  | { mode: "cloud_after_wait"; maxStartWaitMinutes: number; maxFinishMinutes: number }
  | { mode: "cloud_now" };

export type CloudModelMode = CloudModelsSetting["mode"];

export const CLOUD_MODE_LABELS: Record<CloudModelMode, string> = {
  cluster_only: "Cluster only",
  cloud_after_wait: "Cloud after a wait",
  cloud_now: "Cloud now",
};

export const MAX_CLOUD_WAIT_MINUTES = 7 * 24 * 60;

// Starting values when someone first picks "Cloud after a wait".
export const DEFAULT_WAIT = { maxStartWaitMinutes: 15, maxFinishMinutes: 120 };

export function formatMinutes(m: number): string {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

export function describeCloudModels(s: CloudModelsSetting | undefined | null): string {
  if (!s) return CLOUD_MODE_LABELS.cluster_only;
  if (s.mode === "cloud_after_wait") {
    return `${CLOUD_MODE_LABELS.cloud_after_wait} (start within ${formatMinutes(s.maxStartWaitMinutes)}, finish within ${formatMinutes(s.maxFinishMinutes)})`;
  }
  return CLOUD_MODE_LABELS[s.mode] ?? s.mode;
}

// A whole number of minutes from 1 to a week, or null when the text isn't one.
export function parseMinutes(text: string): number | null {
  if (!/^\s*\d+\s*$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 && n <= MAX_CLOUD_WAIT_MINUTES ? n : null;
}
