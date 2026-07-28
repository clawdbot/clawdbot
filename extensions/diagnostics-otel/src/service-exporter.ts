import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { createNodeProxyAgent } from "openclaw/plugin-sdk/fetch-runtime";
import { lowCardinalityAttr } from "./service-attributes.js";
import {
  OTEL_EXPORTER_OTLP_CERTIFICATE_ENV,
  OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE_ENV,
  OTEL_EXPORTER_OTLP_CLIENT_KEY_ENV,
} from "./service-constants.js";
import type {
  OtelHttpAgentFactory,
  OtelHttpAgentOptions,
  OtelLogger,
  OtelSignalIdentifier,
} from "./service-types.js";

export function normalizeEndpoint(endpoint?: string): string | undefined {
  const trimmed = endpoint?.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : undefined;
}

function resolveOtelUrl(endpoint: string | undefined, path: string): string | undefined {
  if (!endpoint) {
    return undefined;
  }
  const endpointWithoutQueryOrFragment = endpoint.split(/[?#]/, 1)[0] ?? endpoint;
  if (/\/v1\/(?:traces|metrics|logs)$/i.test(endpointWithoutQueryOrFragment)) {
    return endpoint;
  }
  if (/[?#]/u.test(endpoint)) {
    try {
      const url = new URL(endpoint);
      const basePath = url.pathname.replace(/\/+$/u, "");
      url.pathname = `${basePath}/${path}`;
      return url.toString();
    } catch {
      // Fall back to the historical concatenation path for non-URL test doubles.
    }
  }
  return `${endpoint}/${path}`;
}

export function resolveSignalOtelUrl(params: {
  signalEndpoint?: string;
  signalEnvEndpoint?: string;
  endpoint?: string;
  path: string;
}): string | undefined {
  return resolveOtelUrl(
    normalizeEndpoint(params.signalEndpoint ?? params.signalEnvEndpoint) ?? params.endpoint,
    params.path,
  );
}

function readOtelEnvFile(params: {
  signalIdentifier: OtelSignalIdentifier;
  signalSuffix: "CERTIFICATE" | "CLIENT_CERTIFICATE" | "CLIENT_KEY";
  sharedEnvName: string;
  logger: OtelLogger;
  warning: string;
}): Buffer | undefined {
  const signalEnvName = `OTEL_EXPORTER_OTLP_${params.signalIdentifier}_${params.signalSuffix}`;
  const filePath =
    normalizeOtelEnvValue(process.env[signalEnvName]) ??
    normalizeOtelEnvValue(process.env[params.sharedEnvName]);
  if (!filePath) {
    return undefined;
  }
  try {
    return readFileSync(nodePath.resolve(process.cwd(), filePath));
  } catch {
    params.logger.warn(`diagnostics-otel: ${params.warning}`);
    return undefined;
  }
}

function normalizeOtelEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveOtelHttpAgentOptions(params: {
  url: string | undefined;
  signalIdentifier: OtelSignalIdentifier;
  logger: OtelLogger;
}): OtelHttpAgentFactory | undefined {
  const { url, signalIdentifier, logger } = params;
  if (!url) {
    return undefined;
  }
  const ca = readOtelEnvFile({
    signalIdentifier,
    signalSuffix: "CERTIFICATE",
    sharedEnvName: OTEL_EXPORTER_OTLP_CERTIFICATE_ENV,
    logger,
    warning: "failed to read root certificate file",
  });
  const cert = readOtelEnvFile({
    signalIdentifier,
    signalSuffix: "CLIENT_CERTIFICATE",
    sharedEnvName: OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE_ENV,
    logger,
    warning: "failed to read client certificate chain file",
  });
  const key = readOtelEnvFile({
    signalIdentifier,
    signalSuffix: "CLIENT_KEY",
    sharedEnvName: OTEL_EXPORTER_OTLP_CLIENT_KEY_ENV,
    logger,
    warning: "failed to read client certificate private key file",
  });
  const agentOptions: OtelHttpAgentOptions = {
    keepAlive: true,
    ...(ca !== undefined ? { ca } : {}),
    ...(cert !== undefined ? { cert } : {}),
    ...(key !== undefined ? { key } : {}),
  };
  try {
    const agent = createNodeProxyAgent({ mode: "env", targetUrl: url, agentOptions });
    return agent ? () => agent : undefined;
  } catch {
    logger.warn(
      `diagnostics-otel: env proxy agent unavailable for OTLP ${signalIdentifier.toLowerCase()} exporter; falling back to default Node agent`,
    );
    return undefined;
  }
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
      return lowCardinalityAttr(err.name, "Error");
    }
    return lowCardinalityAttr(typeof err, "unknown");
  } catch {
    return "unknown";
  }
}

function collectNestedErrorCandidates(err: unknown): unknown[] {
  const queue: unknown[] = [err];
  const seen = new Set<unknown>();
  const candidates: unknown[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current == null || seen.has(current)) {
      continue;
    }
    seen.add(current);
    candidates.push(current);

    if (Array.isArray(current)) {
      for (const item of current) {
        if (item != null && !seen.has(item)) {
          queue.push(item);
        }
      }
      continue;
    }
    if (typeof current !== "object") {
      continue;
    }

    const record = current as Record<string, unknown>;
    for (const nested of [record.cause, record.reason, record.original, record.error]) {
      if (nested != null && !seen.has(nested)) {
        queue.push(nested);
      }
    }
    if (Array.isArray(record.errors)) {
      for (const nested of record.errors) {
        if (nested != null && !seen.has(nested)) {
          queue.push(nested);
        }
      }
    }
  }

  return candidates;
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
  for (const candidate of collectNestedErrorCandidates(reason)) {
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
