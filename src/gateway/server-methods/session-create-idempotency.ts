import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import {
  ErrorCodes,
  SESSION_CREATE_IDEMPOTENCY_RETENTION_MS,
  errorShape,
  missingScopeErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import { DEDUPE_MAX } from "../server-constants.js";
import type { GatewayInflightResult } from "./inflight.js";
import type { GatewayRequestContext, GatewayRequestHandler } from "./types.js";

type SessionCreateAuthorization = { role: string | null; scopes: readonly string[] };
type SessionCreateEntry = {
  requestIdentity: string;
  authorization: SessionCreateAuthorization;
  expiresAt: number;
  state:
    | { kind: "inflight"; work: Promise<GatewayInflightResult> }
    | { kind: "completed"; result: GatewayInflightResult };
};

const sessionCreatesByContext = new WeakMap<
  GatewayRequestContext,
  Map<string, Map<string, SessionCreateEntry>>
>();

export function idempotentSessionCreate(handler: GatewayRequestHandler): GatewayRequestHandler {
  return async (request) => {
    const idempotencyKey = request.params.idempotencyKey;
    if (typeof idempotencyKey !== "string" || !idempotencyKey) {
      await handler(request);
      return;
    }
    const principal =
      request.client?.authenticatedUserProfile?.profileId ?? request.client?.authenticatedUserId;
    const deviceId = request.client?.connect.device?.id?.trim();
    if (!principal && !deviceId) {
      request.respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "idempotent session creation requires an authenticated principal or device identity",
        ),
      );
      return;
    }
    const owner = principal ? `principal:${principal}` : `device:${deviceId}`;
    let entriesByOwner = sessionCreatesByContext.get(request.context);
    if (!entriesByOwner) {
      entriesByOwner = new Map();
      sessionCreatesByContext.set(request.context, entriesByOwner);
    }
    const now = Date.now();
    let retainedEntryCount = 0;
    for (const [entryOwner, ownerEntries] of entriesByOwner) {
      for (const [key, entry] of ownerEntries) {
        if (entry.state.kind === "completed" && entry.expiresAt <= now) {
          ownerEntries.delete(key);
        }
      }
      if (ownerEntries.size === 0) {
        entriesByOwner.delete(entryOwner);
      } else {
        retainedEntryCount += ownerEntries.size;
      }
    }
    let entries = entriesByOwner.get(owner);
    const requestIdentity = createHash("sha256")
      .update(stableStringify(request.params))
      .digest("hex");
    const authorization: SessionCreateAuthorization = {
      role: request.client?.connect.role ?? null,
      scopes: request.client?.connect.scopes?.toSorted() ?? [],
    };
    const existing = entries?.get(idempotencyKey);
    if (existing) {
      if (existing.requestIdentity !== requestIdentity) {
        request.respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "session creation idempotency key was reused with different parameters",
          ),
        );
        return;
      }
      if (existing.authorization.role !== authorization.role) {
        request.respond(
          false,
          undefined,
          errorShape(ErrorCodes.FORBIDDEN, "session creation authorization changed; start again"),
        );
        return;
      }
      const missingScope = existing.authorization.scopes.find(
        (scope) => !authorization.scopes.includes(scope),
      );
      if (missingScope) {
        request.respond(
          false,
          undefined,
          missingScopeErrorShape({
            missingScope,
            requiredScopes: existing.authorization.scopes,
          }),
        );
        return;
      }
      const result =
        existing.state.kind === "completed" ? existing.state.result : await existing.state.work;
      request.respond(result.ok, result.payload, result.error, {
        ...result.meta,
        cached: true,
      });
      return;
    }
    // Reserve a full owner's capacity for other principals while bounding process-wide state.
    if ((entries?.size ?? 0) >= DEDUPE_MAX || retainedEntryCount >= DEDUPE_MAX * 2) {
      request.respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "session creation capacity is full; retry later"),
      );
      return;
    }
    if (!entries) {
      entries = new Map();
      entriesByOwner.set(owner, entries);
    }
    const releaseEntry = () => {
      entries.delete(idempotencyKey);
      if (entries.size === 0) {
        entriesByOwner.delete(owner);
      }
    };
    // The entry is installed before work begins; in-flight identity is never TTL/cap-evictable.
    const work = Promise.resolve().then(async (): Promise<GatewayInflightResult> => {
      try {
        let result: GatewayInflightResult | undefined;
        await handler({
          ...request,
          respond: (ok, payload, error, meta) => {
            result = { ok, payload, error, meta };
          },
        });
        result ??= {
          ok: false,
          error: errorShape(ErrorCodes.UNAVAILABLE, "session creation was interrupted"),
        };
        if (result.ok) {
          entry.expiresAt = Date.now() + SESSION_CREATE_IDEMPOTENCY_RETENTION_MS;
          entry.state = { kind: "completed", result };
        } else {
          releaseEntry();
        }
        return result;
      } catch (error) {
        releaseEntry();
        throw error;
      }
    });
    const entry: SessionCreateEntry = {
      requestIdentity,
      authorization,
      expiresAt: now + SESSION_CREATE_IDEMPOTENCY_RETENTION_MS,
      state: { kind: "inflight", work },
    };
    entries.set(idempotencyKey, entry);
    const result = await work;
    request.respond(result.ok, result.payload, result.error, result.meta);
  };
}
