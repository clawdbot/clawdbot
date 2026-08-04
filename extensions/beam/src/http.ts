import type { IncomingMessage, ServerResponse } from "node:http";
import { getPluginRuntimeGatewayRequestScope } from "openclaw/plugin-sdk/plugin-runtime";
import {
  beginWebhookRequestPipelineOrReject,
  createFixedWindowRateLimiter,
  createWebhookInFlightLimiter,
  readJsonWebhookBodyOrReject,
} from "openclaw/plugin-sdk/webhook-ingress";
import type { BeamStore } from "./store.js";
import { BEAM_HOST_ID, BEAM_MAX_BODY_BYTES, parseBeamUpload } from "./types.js";

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(value));
}

function firstHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
}

type BeamRequestClient = {
  clientIp: string;
  scopes: readonly string[];
};

function currentRequestClient(req: IncomingMessage): BeamRequestClient {
  const client = getPluginRuntimeGatewayRequestScope()?.client;
  return {
    clientIp: client?.clientIp ?? req.socket.remoteAddress ?? "unknown",
    scopes: client?.connect?.scopes ?? [],
  };
}

function canPublish(scopes: readonly string[]): boolean {
  return scopes.includes("operator.write") || scopes.includes("operator.admin");
}

function normalizeControlUiBasePath(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") {
    return "";
  }
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/, "");
}

function catalogSessionUrl(beamId: string, basePath: unknown): string {
  const sessionKey = `catalog:beam:${BEAM_HOST_ID}:${beamId}`;
  return `${normalizeControlUiBasePath(basePath)}/chat?session=${encodeURIComponent(sessionKey)}`;
}

export function createBeamRequestHandler(params: {
  store: BeamStore;
  now?: () => number;
  resolveClient?: (req: IncomingMessage) => BeamRequestClient;
  resolveControlUiBasePath?: () => unknown;
}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const rateLimiter = createFixedWindowRateLimiter({
    windowMs: 60_000,
    maxRequests: 60,
    maxTrackedKeys: 2_048,
  });
  const inFlightLimiter = createWebhookInFlightLimiter({
    maxInFlightPerKey: 2,
    maxTrackedKeys: 2_048,
  });

  return async (req, res) => {
    const client = params.resolveClient?.(req) ?? currentRequestClient(req);
    if (!canPublish(client.scopes)) {
      sendJson(res, 403, { ok: false, error: "operator.write is required" });
      return true;
    }
    const pipeline = beginWebhookRequestPipelineOrReject({
      req,
      res,
      allowMethods: ["POST"],
      requireJsonContentType: true,
      rateLimiter,
      rateLimitKey: client.clientIp,
      inFlightLimiter,
      inFlightKey: client.clientIp,
    });
    if (!pipeline.ok) {
      return true;
    }

    try {
      const contentLength = Number(firstHeader(req, "content-length"));
      if (Number.isFinite(contentLength) && contentLength > BEAM_MAX_BODY_BYTES) {
        sendJson(res, 413, { ok: false, error: "Payload Too Large" });
        return true;
      }
      const body = await readJsonWebhookBodyOrReject({
        req,
        res,
        maxBytes: BEAM_MAX_BODY_BYTES,
        timeoutMs: 10_000,
        emptyObjectOnEmpty: false,
        invalidJsonMessage: "invalid Beam request body",
      });
      if (!body.ok) {
        return true;
      }
      const parsed = parseBeamUpload(body.value);
      if (!parsed.ok) {
        sendJson(res, 400, { ok: false, error: parsed.error });
        return true;
      }
      const receivedAt = params.now?.() ?? Date.now();
      const existing = await params.store.get(parsed.value.beamId);
      await params.store.put({
        ...parsed.value,
        createdAt: existing?.createdAt ?? receivedAt,
        receivedAt,
      });
      sendJson(res, 200, {
        ok: true,
        beamId: parsed.value.beamId,
        url: catalogSessionUrl(parsed.value.beamId, params.resolveControlUiBasePath?.()),
      });
      return true;
    } finally {
      pipeline.release();
    }
  };
}
