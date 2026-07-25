export const MICRO_USD_PER_USD = 1_000_000;

export function isUsdRepresentableAsMicroUsd(value: number): boolean {
  if (!Number.isFinite(value)) {
    return false;
  }
  const scaled = value * MICRO_USD_PER_USD;
  const rounded = Math.round(scaled);
  if (!Number.isSafeInteger(rounded)) {
    return false;
  }
  // Round-trip because multiplication alone can drift off an integral micro-USD value.
  return rounded / MICRO_USD_PER_USD === value;
}
