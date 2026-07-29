/** Extracts the gateway's self presence entry from status/presence payloads. */
import { readStringValue } from "@openclaw/normalization-core/string-coerce";

type GatewaySelfPresence = {
  host?: string;
  ip?: string;
  version?: string;
  platform?: string;
  deviceId?: string;
  instanceId?: string;
};

function parseLegacyGatewaySelfText(text: string): Pick<GatewaySelfPresence, "host" | "ip"> {
  const match = text.match(/^Gateway:\s*([^ (·]+)(?:\s*\(([^)]+)\))?/i);
  if (!match) {
    return {};
  }
  return {
    host: readStringValue(match[1]),
    ip: readStringValue(match[2]),
  };
}

/** Picks host, ip, version, and platform from the gateway self presence record. */
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
  const legacy = typeof self.text === "string" ? parseLegacyGatewaySelfText(self.text) : {};
  const result: GatewaySelfPresence = {
    host: readStringValue(self.host) ?? legacy.host,
    ip: readStringValue(self.ip) ?? legacy.ip,
    version: readStringValue(self.version),
    platform: readStringValue(self.platform),
  };
  const deviceId = readStringValue(self.deviceId);
  if (deviceId) {
    result.deviceId = deviceId;
  }
  const instanceId = readStringValue(self.instanceId);
  if (instanceId) {
    result.instanceId = instanceId;
  }
  return result;
}
