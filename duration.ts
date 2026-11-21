const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** Time left as "45m", "5h", "2d 3h" or "2d", rounded to the unit shown, so 1d 23h 50m reads "2d". */
export function until(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MINUTE_MS));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(ms / HOUR_MS);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

