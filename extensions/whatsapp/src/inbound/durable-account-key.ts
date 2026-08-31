// The account id WhatsApp stores its durable per-account rows under.
import { createHash } from "node:crypto";

/**
 * WhatsApp opens its ingress queue under a hash of the account id, so a host that
 * addresses those rows by the configured id selects none of them. The host cannot
 * derive the transform, so the plugin declares it through the config adapter's
 * `resolveDurableAccountKey`.
 *
 * It lives alone in this module on purpose: `shared.ts` builds the config adapter and
 * must not pull the ingress runtime in behind it.
 */
export function resolveWhatsAppDurableAccountKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}
