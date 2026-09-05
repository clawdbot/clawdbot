import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";

const CRON_POSITIVE_DECIMAL_RE = /^(?:\d+(?:\.\d*)?|\.\d+)$/u;

const CRON_DURATION_UNIT_MS = {
  seconds: 1_000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
} as const;

export function parseCronDurationMs(
  value: string,
  unit: keyof typeof CRON_DURATION_UNIT_MS,
  allowNumberSyntax = false,
): number | undefined {
  let trimmed = value.trim();
  // Stagger accepts Number syntax; plain decimal text must keep its exact digits.
  if (allowNumberSyntax && !CRON_POSITIVE_DECIMAL_RE.test(trimmed)) {
    trimmed = String(Number(trimmed));
  }
  if (!CRON_POSITIVE_DECIMAL_RE.test(trimmed)) {
    return undefined;
  }
  const [wholePart, fractionalPart = ""] = trimmed.split(".");
  const wholeDigits = (wholePart || "0").replace(/^0+/u, "") || "0";
  const fractionalDigits = fractionalPart.replace(/0+$/u, "");
  // Days contain 2^10 milliseconds, the largest base-10 scale any supported
  // unit can cancel after trailing decimal zeroes are removed.
  if (wholeDigits.length > String(MAX_DATE_TIMESTAMP_MS).length || fractionalDigits.length > 10) {
    return undefined;
  }

  const scale = 10n ** BigInt(fractionalDigits.length);
  const decimal = BigInt(wholeDigits) * scale + BigInt(fractionalDigits || "0");
  const scaledMilliseconds = decimal * BigInt(CRON_DURATION_UNIT_MS[unit]);
  if (scaledMilliseconds % scale !== 0n) {
    return undefined;
  }
  const milliseconds = scaledMilliseconds / scale;
  return milliseconds > 0n && milliseconds <= BigInt(MAX_DATE_TIMESTAMP_MS)
    ? Number(milliseconds)
    : undefined;
}
