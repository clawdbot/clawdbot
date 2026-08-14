// Shared param-validation helpers used by all four agent tools.
// Goal: identical validation behavior + identical error shapes everywhere.

import { formatByteSize } from "openclaw/plugin-sdk/number-runtime";
import { readPositiveIntegerParam } from "openclaw/plugin-sdk/param-readers";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

type GatewayCallOptions = {
  gatewayUrl?: string;
  gatewayToken?: string;
  timeoutMs?: number;
};

export function readGatewayCallOptions(params: Record<string, unknown>): GatewayCallOptions {
  const opts: GatewayCallOptions = {};
  if (typeof params.gatewayUrl === "string" && params.gatewayUrl.trim()) {
    opts.gatewayUrl = params.gatewayUrl.trim();
  }
  if (typeof params.gatewayToken === "string" && params.gatewayToken.trim()) {
    opts.gatewayToken = params.gatewayToken.trim();
  }
  opts.timeoutMs = readPositiveIntegerParam(params, "timeoutMs");
  return opts;
}

export function readTrimmedString(params: Record<string, unknown>, key: string): string {
  return normalizeOptionalString(params[key]) ?? "";
}

export function readClampedInt(params: {
  input: Record<string, unknown>;
  key: string;
  defaultValue: number;
  hardMin: number;
  hardMax: number;
}): number {
  const requested = readPositiveIntegerParam(params.input, params.key) ?? params.defaultValue;
  return Math.max(params.hardMin, Math.min(requested, params.hardMax));
}

export function humanSize(bytes: number): string {
  return formatByteSize(bytes, {
    style: "legacy-binary",
    maxUnit: "mega",
    separator: " ",
    fractionDigits: (_value, unit) => (unit === "byte" ? null : unit === "kilo" ? 1 : 2),
  });
}
