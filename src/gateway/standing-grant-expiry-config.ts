// Leaf module: standing-grant expiry policy read from config. Kept free of
// store/db imports so eager gateway startup wiring can use it without pulling
// the grants store out of its lazy server-method boundary.

/** Normalizes tools.exec.grantExpiryDays: whole days >= 1, else null (until revoked). */
export function resolveGrantExpiryDaysConfig(cfg: {
  tools?: { exec?: { grantExpiryDays?: number } };
}): number | null {
  const days = cfg.tools?.exec?.grantExpiryDays;
  return typeof days === "number" && Number.isFinite(days) && days >= 1 ? Math.floor(days) : null;
}
