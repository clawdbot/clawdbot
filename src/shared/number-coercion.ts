/** Shared numeric coercion facade for legacy imports inside core. */
export * from "@openclaw/normalization-core/number-coercion";

export function resolveNonNegativeNumber(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
