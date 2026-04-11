import { readStringValue } from "../shared/string-coerce.js";

export type GatewaySelfPresence = {
  host?: string;
  ip?: string;
  version?: string;
  platform?: string;
};

export function pickGatewaySelfPresence(presence: unknown): GatewaySelfPresence | null {
  if (!Array.isArray(presence)) {
    return null;
  }
  const entries = presence as Array<Record<string, unknown>>;
  const self =
    entries.find((e) => e.mode === "gateway" && e.reason === "self") ??
    // Back-compat: older presence payloads only included a `text` line.
    entries.find((e) => typeof e.text === "string" && e.text.startsWith("Gateway:")) ??
    null;
  if (!self) {
    return null;
  }
  return {
    host: readStringValue(self.host),
    ip: readStringValue(self.ip),
    version: readStringValue(self.version),
    platform: readStringValue(self.platform),
  };
}
