// Whatsapp helper module supports config accessors behavior.
import { normalizeWhatsAppAllowFromEntries } from "./normalize-target.js";

export function formatWhatsAppConfigAllowFromEntries(allowFrom: Array<string | number>): string[] {
  return normalizeWhatsAppAllowFromEntries(allowFrom);
}
