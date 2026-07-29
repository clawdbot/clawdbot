const SYNODIC_MONTH_DAYS = 29.53059;
const KNOWN_NEW_MOON_MS = Date.parse("2000-01-06T18:14:00.000Z");

export function moonPhaseFraction(date: Date): number {
  const daysSinceEpoch = (date.getTime() - KNOWN_NEW_MOON_MS) / 86_400_000;
  return (
    (((daysSinceEpoch % SYNODIC_MONTH_DAYS) + SYNODIC_MONTH_DAYS) % SYNODIC_MONTH_DAYS) /
    SYNODIC_MONTH_DAYS
  );
}
