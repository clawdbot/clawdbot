// Shared param-validation helpers used by all four agent tools.
// Goal: identical validation behavior + identical error shapes everywhere.

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
  if (typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)) {
    opts.timeoutMs = params.timeoutMs;
  }
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
  const value = params.input[params.key];
  const requested =
    typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : params.defaultValue;
  return Math.max(params.hardMin, Math.min(requested, params.hardMax));
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
