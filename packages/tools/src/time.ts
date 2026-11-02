const AGO = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
const ISO = /^(\d{4})-(\d{2})-(\d{2})(T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** `30m`, `2h`, `1d`, `1w` ago, or an ISO 8601 time, as ms; null if it's neither. */
export function parseTime(raw: string, now: number): number | null {
  const ago = /^(\d+)([mhdw])$/.exec(raw);
  if (ago) return now - Number(ago[1]) * AGO[ago[2] as keyof typeof AGO];
  const iso = ISO.exec(raw);
  if (!iso) return null;
  const month = Number(iso[2]) - 1;
  // Date.parse reads a date alone as UTC, which is the wrong day for many people, and rolls February 31 into March.
  const day = new Date(Number(iso[1]), month, Number(iso[3]));
  if (day.getMonth() !== month) return null;
  if (!iso[4]) return day.getTime();
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : at;
}

const two = (n: number) => String(Math.abs(n)).padStart(2, "0");

/** A time to the minute in this process's zone, in a form `parseTime` reads back. */
export function stamp(ms: number): string {
  const d = new Date(ms);
  const offset = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}${offset < 0 ? "-" : "+"}${two(Math.trunc(offset / 60))}:${two(offset % 60)}`;
}
