// Shared param-validation helpers used by all four agent tools.
// Goal: identical validation behavior + identical error shapes everywhere.

import { formatByteSize } from "openclaw/plugin-sdk/number-runtime";
import { readPositiveIntegerParam } from "openclaw/plugin-sdk/param-readers";

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
  const value = params[key];
  return typeof value === "string" ? value.trim() : "";
}

export function readBoolean(
  params: Record<string, unknown>,
  key: string,
  defaultValue = false,
): boolean {
  const value = params[key];
  if (typeof value === "boolean") {
    return value;
  }
  return defaultValue;
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
