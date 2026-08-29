import { createHmac } from "node:crypto";
import { loadOrCreateProcessDeviceIdentity } from "../../infra/device-identity.js";

/** Stable, keyed receipts do not retain another copy or an offline digest of prompt material. */
export function fingerprintSessionGoalRequest(
  value: Record<string, unknown> | readonly unknown[],
): string {
  const identity = loadOrCreateProcessDeviceIdentity();
  const canonical = JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : item,
  );
  return createHmac("sha256", identity.privateKeyPem)
    .update("openclaw.session-goal.v1\0")
    .update(canonical)
    .digest("hex");
}
