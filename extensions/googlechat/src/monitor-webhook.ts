// Googlechat plugin module implements monitor webhook behavior.
import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  normalizeWebhookPath,
  resolveRequestClientIp,
  type FixedWindowRateLimiter,
} from "openclaw/plugin-sdk/webhook-ingress";
import {
  readJsonWebhookBodyOrReject,
  runDetachedWebhookWork,
  type WebhookInFlightLimiter,
} from "openclaw/plugin-sdk/webhook-request-guards";
import {
  resolveWebhookTargetWithAuthOrReject,
  withResolvedWebhookRequestPipeline,
} from "openclaw/plugin-sdk/webhook-targets";
import { verifyGoogleChatRequest } from "./auth.js";
import { parseGoogleChatInboundPayload as normalizeGoogleChatInboundPayload } from "./monitor-event.js";
import type { WebhookTarget } from "./monitor-types.js";
import type { GoogleChatEvent } from "./types.js";

function extractBearerToken(header: unknown): string {
  const authHeader = Array.isArray(header)
    ? typeof header[0] === "string"
      ? header[0]
      : ""
    : typeof header === "string"
      ? header
      : "";
  return normalizeLowercaseStringOrEmpty(authHeader).startsWith("bearer ")
    ? authHeader.slice("bearer ".length).trim()
    : "";
}

const ADD_ON_PREAUTH_MAX_BYTES = 16 * 1024;
const ADD_ON_PREAUTH_TIMEOUT_MS = 3_000;

type ParsedGoogleChatInboundSuccess = {
  raw: Record<string, unknown>;
  addOnBearerToken: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseGoogleChatInboundPayloadOrReject(
  raw: unknown,
  res: ServerResponse,
): ParsedGoogleChatInboundSuccess | null {
  if (!isRecord(raw)) {
    res.statusCode = 400;
    res.end("invalid payload");
    return null;
  }
  const commonEventObject = isRecord(raw.commonEventObject) ? raw.commonEventObject : null;
  const authorizationEventObject = isRecord(raw.authorizationEventObject)
    ? raw.authorizationEventObject
    : null;
  let addOnBearerToken = "";
  if (
    commonEventObject?.hostApp === "CHAT" &&
    typeof authorizationEventObject?.systemIdToken === "string"
  ) {
    addOnBearerToken = authorizationEventObject.systemIdToken.trim();
  }
  return { raw, addOnBearerToken };
}

type GoogleChatWebhookAuthRejection = {
  target: WebhookTarget;
  reason: string;
};

async function verifyGoogleChatTargetAuth(
  target: WebhookTarget,
  bearer: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const verification = await verifyGoogleChatRequest({
    bearer,
    audienceType: target.audienceType,
    audience: target.audience,
    expectedAddOnPrincipal: target.account.config.appPrincipal,
  });
  return verification.ok ? { ok: true } : { ok: false, reason: verification.reason ?? "unknown" };
}

function logGoogleChatWebhookAuthRejections(rejections: GoogleChatWebhookAuthRejection[]): void {
  for (const rejection of rejections) {
    rejection.target.runtime.log?.(
      `[${rejection.target.account.accountId}] Google Chat webhook auth rejected: ${rejection.reason}`,
    );
  }
}

function logGoogleChatWebhookAuthRejectedForTargets(
  targets: readonly WebhookTarget[],
  reason: string,
): void {
  logGoogleChatWebhookAuthRejections(targets.map((target) => ({ target, reason })));
}

async function resolveGoogleChatWebhookTargetWithAuthOrReject(params: {
  targets: readonly WebhookTarget[];
  res: ServerResponse;
  bearer: string;
}): Promise<WebhookTarget | null> {
  const rejections: GoogleChatWebhookAuthRejection[] = [];
  let verifiedTargetCount = 0;
  const selectedTarget = await resolveWebhookTargetWithAuthOrReject({
    targets: params.targets,
    res: params.res,
    isMatch: async (target) => {
      const verification = await verifyGoogleChatTargetAuth(target, params.bearer);
      if (verification.ok) {
        verifiedTargetCount += 1;
        return true;
      }
      rejections.push({ target, reason: verification.reason });
      return false;
    },
  });
  if (!selectedTarget && verifiedTargetCount === 0) {
    logGoogleChatWebhookAuthRejections(rejections);
  }
  return selectedTarget;
}

export function warnAppPrincipalMisconfiguration(params: {
  accountId: string;
  audienceType?: string;
  appPrincipal?: string | null;
  log?: (message: string) => void;
}): void {
  if (params.audienceType !== "app-url") {
    return;
  }
  const principal = params.appPrincipal?.trim();
  if (!principal) {
    params.log?.(
      `[${params.accountId}] appPrincipal is missing for audienceType "app-url"; add-on token verification will fail. Set appPrincipal to the numeric OAuth 2.0 client ID (uniqueId, 21 digits), not an email.`,
    );
  } else if (principal.includes("@")) {
    params.log?.(
      `[${params.accountId}] appPrincipal "${principal}" looks like an email address. Set appPrincipal to the numeric OAuth 2.0 client ID (uniqueId, 21 digits), not an email.`,
    );
  }
}

export function createGoogleChatWebhookRequestHandler(params: {
  webhookTargets: Map<string, WebhookTarget[]>;
  webhookRateLimiter: FixedWindowRateLimiter;
  webhookInFlightLimiter: WebhookInFlightLimiter;
  processEvent: (event: GoogleChatEvent, target: WebhookTarget) => Promise<void>;
}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const path = normalizeWebhookPath(new URL(req.url ?? "/", "http://localhost").pathname);
    // Shared-path registrations use the same gateway proxy settings in normal runtime setup.
    const config = params.webhookTargets.get(path)?.[0]?.config;
    const clientIp =
      resolveRequestClientIp(
        req,
        config?.gateway?.trustedProxies,
        config?.gateway?.allowRealIpFallback === true,
      ) ?? "unknown";

    return await withResolvedWebhookRequestPipeline({
      req,
      res,
      targetsByPath: params.webhookTargets,
      allowMethods: ["POST"],
      requireJsonContentType: true,
      rateLimiter: params.webhookRateLimiter,
      rateLimitKey: `${path}:${clientIp}`,
      inFlightLimiter: params.webhookInFlightLimiter,
      handle: async ({ targets }) => {
        const headerBearer = extractBearerToken(req.headers.authorization);
        let selectedTarget: WebhookTarget | null;
        let parsedInbound: ParsedGoogleChatInboundSuccess;
        const readAndParseEvent = async (
          profile: "pre-auth" | "post-auth",
        ): Promise<ParsedGoogleChatInboundSuccess | null> => {
          const body = await readJsonWebhookBodyOrReject({
            req,
            res,
            profile,
            ...(profile === "pre-auth"
              ? {
                  maxBytes: ADD_ON_PREAUTH_MAX_BYTES,
                  timeoutMs: ADD_ON_PREAUTH_TIMEOUT_MS,
                }
              : {}),
            emptyObjectOnEmpty: false,
            invalidJsonMessage: "invalid payload",
          });
          if (!body.ok) {
            return null;
          }

          return parseGoogleChatInboundPayloadOrReject(body.value, res);
        };

        if (headerBearer) {
          selectedTarget = await resolveGoogleChatWebhookTargetWithAuthOrReject({
            targets,
            res,
            bearer: headerBearer,
          });
          if (!selectedTarget) {
            return true;
          }

          const parsed = await readAndParseEvent("post-auth");
          if (!parsed) {
            return true;
          }
          parsedInbound = parsed;
        } else {
          const parsed = await readAndParseEvent("pre-auth");
          if (!parsed) {
            return true;
          }
          parsedInbound = parsed;

          if (!parsed.addOnBearerToken) {
            logGoogleChatWebhookAuthRejectedForTargets(targets, "missing token");
            res.statusCode = 401;
            res.end("unauthorized");
            return true;
          }

          selectedTarget = await resolveGoogleChatWebhookTargetWithAuthOrReject({
            targets,
            res,
            bearer: parsed.addOnBearerToken,
          });
          if (!selectedTarget) {
            return true;
          }
        }

        if (!selectedTarget || !parsedInbound) {
          res.statusCode = 401;
          res.end("unauthorized");
          return true;
        }

        const dispatchTarget = selectedTarget;
        dispatchTarget.statusSink?.({ lastInboundAt: Date.now() });
        try {
          const admission = await dispatchTarget.ingress.receive(parsedInbound.raw);
          if (admission.kind === "invalid") {
            res.statusCode = 400;
            res.end("invalid payload");
            return true;
          }
          if (admission.kind === "ignored") {
            // Non-turn actions preserve their existing detached webhook path.
            let event: GoogleChatEvent;
            try {
              event = normalizeGoogleChatInboundPayload(parsedInbound.raw).event;
            } catch {
              res.statusCode = 400;
              res.end("invalid payload");
              return true;
            }
            void runDetachedWebhookWork(() => params.processEvent(event, dispatchTarget)).catch(
              (err: unknown) => {
                dispatchTarget.runtime.error?.(
                  `[${dispatchTarget.account.accountId}] Google Chat webhook failed: ${String(err)}`,
                );
              },
            );
          }
        } catch (error) {
          dispatchTarget.runtime.error?.(
            `[${dispatchTarget.account.accountId}] Google Chat durable admission failed: ${String(error)}`,
          );
          res.statusCode = 503;
          res.end("failed to persist event");
          return true;
        }

        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end("{}");
        return true;
      },
    });
  };
}
