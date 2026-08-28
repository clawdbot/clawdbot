import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { normalizeDiagnosticValue } from "openclaw/plugin-sdk/diagnostic-runtime";
import { collectErrorGraphCandidates } from "openclaw/plugin-sdk/error-runtime";
import { createNodeProxyAgent } from "openclaw/plugin-sdk/fetch-runtime";
import {
  OTEL_EXPORTER_OTLP_CERTIFICATE_ENV,
  OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE_ENV,
  OTEL_EXPORTER_OTLP_CLIENT_KEY_ENV,
} from "./service-constants.js";
import type {
  OtelHttpAgentFactory,
  OtelHttpAgentOptions,
  OtelSignalIdentifier,
} from "./service-types.js";

export function normalizeEndpoint(endpoint?: string): string | undefined {
  const trimmed = endpoint?.trim();
  return trimmed || undefined;
}

const SIGNAL_QUALIFIED_OTLP_PATH_PATTERN = /\/v1\/(traces|metrics|logs)$/iu;

function appendOrReplaceSignalPath(value: string, path: string): string {
  const base = value.replace(/\/+$/u, "");
  return SIGNAL_QUALIFIED_OTLP_PATH_PATTERN.test(base)
    ? base.replace(SIGNAL_QUALIFIED_OTLP_PATH_PATTERN, `/${path}`)
    : `${base}/${path}`;
}

function resolveSharedOtelUrl(endpoint: string, path: string): string {
  const endpointWithoutQueryOrFragment = endpoint.split(/[?#]/, 1)[0] ?? endpoint;
  // Trim path separators here, never slash bytes belonging to a collector query.
  const base = endpointWithoutQueryOrFragment.replace(/\/+$/u, "");
  const matchedSignal = base.match(SIGNAL_QUALIFIED_OTLP_PATH_PATTERN)?.[1];
  const requestedSignal = path.slice(path.lastIndexOf("/") + 1);
  if (matchedSignal?.toLowerCase() === requestedSignal.toLowerCase()) {
    return endpoint === endpointWithoutQueryOrFragment ? base : endpoint;
  }
  if (/[?#]/u.test(endpoint)) {
    const url = new URL(endpoint);
    url.pathname = appendOrReplaceSignalPath(url.pathname, path);
    return url.toString();
  }
  return appendOrReplaceSignalPath(endpoint, path);
}

export function resolveSignalOtelUrl(params: {
  signalEndpoint?: string;
  signalEnvEndpoint?: string;
  sharedEnvEndpoint?: string;
  endpoint?: string;
  path: string;
}): string | undefined {
  const signalEndpoint = normalizeEndpoint(params.signalEndpoint ?? params.signalEnvEndpoint);
  const endpoint = signalEndpoint ?? params.endpoint;
  // OTLP parses nonblank env values verbatim even when explicit config takes precedence.
  const signalEnvEndpoint = params.signalEnvEndpoint?.trim() ? params.signalEnvEndpoint : undefined;
  const sharedEnvEndpoint = params.sharedEnvEndpoint?.trim() ? params.sharedEnvEndpoint : undefined;
  const consumedSharedEnvEndpoint = signalEnvEndpoint ? undefined : sharedEnvEndpoint;
  const appendedSharedEnvEndpoint = consumedSharedEnvEndpoint
    ? `${consumedSharedEnvEndpoint}${consumedSharedEnvEndpoint.endsWith("/") ? "" : "/"}${params.path}`
    : undefined;
  const resolvedEndpoint =
    endpoint && URL.canParse(endpoint) && !signalEndpoint
      ? resolveSharedOtelUrl(endpoint, params.path)
      : endpoint;

  for (const candidate of [
    endpoint,
    signalEnvEndpoint ?? sharedEnvEndpoint,
    appendedSharedEnvEndpoint,
    resolvedEndpoint,
  ]) {
    if (candidate && !URL.canParse(candidate)) {
      throw new Error(
        "Configured OpenTelemetry collector endpoint is invalid; check the collector URL",
      );
    }
  }

  return resolvedEndpoint;
}

function readOtelEnvFile(params: {
  signalIdentifier: OtelSignalIdentifier;
  signalSuffix: "CERTIFICATE" | "CLIENT_CERTIFICATE" | "CLIENT_KEY";
  sharedEnvName: string;
  label: string;
}): Buffer | undefined {
  const signalEnvName = `OTEL_EXPORTER_OTLP_${params.signalIdentifier}_${params.signalSuffix}`;
  const filePath =
    normalizeOtelEnvValue(process.env[signalEnvName]) ??
    normalizeOtelEnvValue(process.env[params.sharedEnvName]);
  if (!filePath) {
    return undefined;
  }
  try {
    const material = readFileSync(nodePath.resolve(process.cwd(), filePath));
    if (material.length > 0) {
      return material;
    }
  } catch {
    // Never expose certificate paths or silently downgrade to system trust.
  }
  throw new Error(
    `Configured OpenTelemetry ${params.label} file is missing, empty, or unreadable; refusing insecure export`,
  );
}

function normalizeOtelEnvValue(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

export function resolveOtelHttpAgentOptions(params: {
  url: string | undefined;
  signalIdentifier: OtelSignalIdentifier;
}): OtelHttpAgentFactory | OtelHttpAgentOptions | undefined {
  const { url, signalIdentifier } = params;
  const ca = readOtelEnvFile({
    signalIdentifier,
    signalSuffix: "CERTIFICATE",
    sharedEnvName: OTEL_EXPORTER_OTLP_CERTIFICATE_ENV,
    label: "TLS root certificate",
  });
  const cert = readOtelEnvFile({
    signalIdentifier,
    signalSuffix: "CLIENT_CERTIFICATE",
    sharedEnvName: OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE_ENV,
    label: "mTLS client certificate",
  });
  const key = readOtelEnvFile({
    signalIdentifier,
    signalSuffix: "CLIENT_KEY",
    sharedEnvName: OTEL_EXPORTER_OTLP_CLIENT_KEY_ENV,
    label: "mTLS client private key",
  });
  if ((cert === undefined) !== (key === undefined)) {
    throw new Error(
      "Configured OpenTelemetry mTLS requires both a client certificate and private key; refusing insecure export",
    );
  }
  if (!url) {
    return undefined;
  }
  const agentOptions: OtelHttpAgentOptions = {
    keepAlive: true,
    ...(ca !== undefined ? { ca } : {}),
    ...(cert !== undefined ? { cert } : {}),
    ...(key !== undefined ? { key } : {}),
  };
  try {
    const agent = createNodeProxyAgent({ mode: "env", targetUrl: url, agentOptions });
    if (agent) {
      return () => agent;
    }
  } catch {
    throw new Error("Configured telemetry proxy is invalid or unsupported; refusing direct export");
  }
  return (ca || cert || key) && new URL(url).protocol === "https:" ? agentOptions : undefined;
}

export function resolveSampleRate(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  if (value < 0 || value > 1) {
    return undefined;
  }
  return value;
}

export function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function errorCategory(err: unknown): string {
  try {
    if (err instanceof Error && typeof err.name === "string" && err.name.trim()) {
      return normalizeDiagnosticValue(err.name, "Error");
    }
    return normalizeDiagnosticValue(typeof err, "unknown");
  } catch {
    return "unknown";
  }
}

function readErrorName(err: unknown): string | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const name = (err as { name?: unknown }).name;
  return typeof name === "string" && name.trim() ? name : undefined;
}

export function readErrorCode(err: unknown): string | number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" || typeof code === "number" ? code : undefined;
}

export function findOtlpExporterError(reason: unknown): object | undefined {
  for (const candidate of collectErrorGraphCandidates(reason, (current) =>
    Array.isArray(current)
      ? current
      : [
          current.cause,
          current.reason,
          current.original,
          current.error,
          ...(Array.isArray(current.errors) ? current.errors : []),
        ],
  )) {
    if (
      readErrorName(candidate) === "OTLPExporterError" &&
      candidate &&
      typeof candidate === "object"
    ) {
      return candidate;
    }
  }
  return undefined;
}
