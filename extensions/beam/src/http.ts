import type { IncomingMessage, ServerResponse } from "node:http";
import { getPluginRuntimeGatewayRequestScope } from "openclaw/plugin-sdk/plugin-runtime";
import { buildControlUiCatalogSharePath } from "openclaw/plugin-sdk/session-catalog-runtime";
import {
  beginWebhookRequestPipelineOrReject,
  createFixedWindowRateLimiter,
  createWebhookInFlightLimiter,
  readJsonWebhookBodyOrReject,
} from "openclaw/plugin-sdk/webhook-ingress";
import type { BeamStore } from "./store.js";
import { BEAM_MAX_BODY_BYTES, BEAM_SESSION_SHARE_ROUTE, parseBeamUpload } from "./types.js";

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(value));
}

type BeamRequestClient = {
  clientIp: string;
  scopes: readonly string[];
  profileId?: string;
};

function currentRequestClient(req: IncomingMessage): BeamRequestClient {
  const client = getPluginRuntimeGatewayRequestScope()?.client;
  return {
    clientIp: client?.clientIp ?? req.socket.remoteAddress ?? "unknown",
    scopes: client?.connect?.scopes ?? [],
    profileId: client?.authenticatedUserProfile?.profileId,
  };
}

function canPublish(scopes: readonly string[]): boolean {
  return scopes.includes("operator.write") || scopes.includes("operator.admin");
}

export function createBeamRequestHandler(params: {
  store: BeamStore;
  now?: () => number;
  resolveClient?: (req: IncomingMessage) => BeamRequestClient;
  resolveControlUiBasePath: () => string | undefined;
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
        // An anonymous replacement must not inherit a previous publisher's identity.
        ...(client.profileId ? { uploaderProfileId: client.profileId } : {}),
        createdAt: existing?.createdAt ?? receivedAt,
        receivedAt,
      });
      sendJson(res, 200, {
        ok: true,
        beamId: parsed.value.beamId,
        url: buildControlUiCatalogSharePath({
          shareRoute: BEAM_SESSION_SHARE_ROUTE,
          threadId: parsed.value.beamId,
          displayName: parsed.value.title,
          basePath: params.resolveControlUiBasePath(),
        }),
      });
      return true;
    } finally {
      pipeline.release();
    }
  };
}
