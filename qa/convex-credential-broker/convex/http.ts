import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction } from "./_generated/server";

type ActorRole = "ci" | "maintainer";

class BrokerHttpError extends Error {
  code: string;
  httpStatus: number;

  constructor(httpStatus: number, code: string, message: string) {
    super(message);
    this.name = "BrokerHttpError";
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

function jsonResponse(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function parseBearerToken(request: Request) {
  const header = request.headers.get("authorization")?.trim();
  if (!header) {
    return null;
  }
  const [scheme, token] = header.split(/\s+/u, 2);
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null;
  }
  return token;
}

function resolveAuthRole(token: string | null): ActorRole {
  if (!token) {
    throw new BrokerHttpError(
      401,
      "AUTH_REQUIRED",
      "Missing Authorization: Bearer <secret> header.",
    );
  }
  const maintainerSecret = process.env.OPENCLAW_QA_CONVEX_SECRET_MAINTAINER?.trim();
  const ciSecret = process.env.OPENCLAW_QA_CONVEX_SECRET_CI?.trim();

  if (!maintainerSecret && !ciSecret) {
    throw new BrokerHttpError(
      500,
      "SERVER_MISCONFIGURED",
      "No Convex broker role secrets are configured on this deployment.",
    );
  }
  if (maintainerSecret && token === maintainerSecret) {
    return "maintainer";
  }
  if (ciSecret && token === ciSecret) {
    return "ci";
  }
  throw new BrokerHttpError(401, "AUTH_INVALID", "Credential broker secret is invalid.");
}

function assertMaintainerAdminAuth(token: string | null) {
  if (!token) {
    throw new BrokerHttpError(
      401,
      "AUTH_REQUIRED",
      "Missing Authorization: Bearer <secret> header.",
    );
  }
  const maintainerSecret = process.env.OPENCLAW_QA_CONVEX_SECRET_MAINTAINER?.trim();
  if (!maintainerSecret) {
    throw new BrokerHttpError(
      500,
      "SERVER_MISCONFIGURED",
      "Admin endpoints require OPENCLAW_QA_CONVEX_SECRET_MAINTAINER on this deployment.",
    );
  }
  if (token === maintainerSecret) {
    return;
  }
  const ciSecret = process.env.OPENCLAW_QA_CONVEX_SECRET_CI?.trim();
  if (ciSecret && token === ciSecret) {
    throw new BrokerHttpError(
      403,
      "AUTH_ROLE_MISMATCH",
      "Admin endpoints require maintainer credentials.",
    );
  }
  throw new BrokerHttpError(401, "AUTH_INVALID", "Credential broker secret is invalid.");
}

function asObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

async function parseJsonObject(request: Request) {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new BrokerHttpError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
  const body = asObject(parsed);
  if (!body) {
    throw new BrokerHttpError(400, "INVALID_BODY", "Request body must be a JSON object.");
  }
  return body;
}

function requireString(body: Record<string, unknown>, key: string) {
  const raw = body[key];
  if (typeof raw !== "string") {
    throw new BrokerHttpError(400, "INVALID_BODY", `Expected "${key}" to be a string.`);
  }
  const value = raw.trim();
  if (!value) {
    throw new BrokerHttpError(400, "INVALID_BODY", `Expected "${key}" to be non-empty.`);
  }
  return value;
}

function optionalString(body: Record<string, unknown>, key: string) {
  if (!(key in body) || body[key] === undefined || body[key] === null) {
    return undefined;
  }
  const raw = body[key];
  if (typeof raw !== "string") {
    throw new BrokerHttpError(400, "INVALID_BODY", `Expected "${key}" to be a string.`);
  }
  const value = raw.trim();
  return value.length > 0 ? value : undefined;
}

function requireObject(body: Record<string, unknown>, key: string) {
  const raw = body[key];
  const parsed = asObject(raw);
  if (!parsed) {
    throw new BrokerHttpError(400, "INVALID_BODY", `Expected "${key}" to be a JSON object.`);
  }
  return parsed;
}

function optionalPositiveInteger(body: Record<string, unknown>, key: string) {
  if (!(key in body) || body[key] === undefined || body[key] === null) {
    return undefined;
  }
  const raw = body[key];
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 1) {
    throw new BrokerHttpError(400, "INVALID_BODY", `Expected "${key}" to be a positive integer.`);
  }
  return raw;
}

function optionalBoolean(body: Record<string, unknown>, key: string) {
  if (!(key in body) || body[key] === undefined || body[key] === null) {
    return undefined;
  }
  if (typeof body[key] !== "boolean") {
    throw new BrokerHttpError(400, "INVALID_BODY", `Expected "${key}" to be a boolean.`);
  }
  return body[key];
}

function optionalCredentialStatus(body: Record<string, unknown>, key: string) {
  const value = optionalString(body, key);
  if (!value) {
    return undefined;
  }
  if (value !== "active" && value !== "disabled") {
    throw new BrokerHttpError(
      400,
      "INVALID_BODY",
      `Expected "${key}" to be "active" or "disabled".`,
    );
  }
  return value;
}

function optionalListStatus(body: Record<string, unknown>, key: string) {
  const value = optionalString(body, key);
  if (!value) {
    return undefined;
  }
  if (value !== "active" && value !== "disabled" && value !== "all") {
    throw new BrokerHttpError(
      400,
      "INVALID_BODY",
      `Expected "${key}" to be "active", "disabled", or "all".`,
    );
  }
  return value;
}

function requirePayloadString(payload: Record<string, unknown>, key: string, kind: string): string {
  const raw = payload[key];
  if (typeof raw !== "string") {
    throw new BrokerHttpError(
      400,
      "INVALID_PAYLOAD",
      `Credential payload for kind "${kind}" must include "${key}" as a string.`,
    );
  }
  const value = raw.trim();
  if (!value) {
    throw new BrokerHttpError(
      400,
      "INVALID_PAYLOAD",
      `Credential payload for kind "${kind}" must include a non-empty "${key}" value.`,
    );
  }
  return value;
}

function normalizeCredentialPayloadForKind(kind: string, payload: Record<string, unknown>) {
  if (kind !== "telegram") {
    return payload;
  }

  const groupId = requirePayloadString(payload, "groupId", "telegram");
  if (!/^-?\d+$/u.test(groupId)) {
    throw new BrokerHttpError(
      400,
      "INVALID_PAYLOAD",
      'Credential payload for kind "telegram" must include a numeric "groupId" string.',
    );
  }

  const driverToken = requirePayloadString(payload, "driverToken", "telegram");
  const sutToken = requirePayloadString(payload, "sutToken", "telegram");

  return {
    groupId,
    driverToken,
    sutToken,
  } satisfies Record<string, unknown>;
}

function parseActorRole(body: Record<string, unknown>) {
  const actorRole = requireString(body, "actorRole");
  if (actorRole !== "ci" && actorRole !== "maintainer") {
    throw new BrokerHttpError(
      400,
      "INVALID_ACTOR_ROLE",
      'Expected "actorRole" to be "maintainer" or "ci".',
    );
  }
  return actorRole as ActorRole;
}

function assertRoleAllowed(tokenRole: ActorRole, requestedRole: ActorRole) {
  if (tokenRole !== requestedRole) {
    throw new BrokerHttpError(
      403,
      "AUTH_ROLE_MISMATCH",
      `Secret role "${tokenRole}" cannot be used as actorRole "${requestedRole}".`,
    );
  }
}

function normalizeCredentialId(raw: string) {
  // Convex Ids are opaque strings. We only enforce non-empty shape at HTTP boundary.
  return raw;
}

function normalizeError(error: unknown) {
  if (error instanceof BrokerHttpError) {
    return {
      httpStatus: error.httpStatus,
      payload: {
        status: "error",
        code: error.code,
        message: error.message,
      },
    };
  }
  if (error instanceof Error) {
    return {
      httpStatus: 500,
      payload: {
        status: "error",
        code: "INTERNAL_ERROR",
        message: error.message || "Internal credential broker error.",
      },
    };
  }
  return {
    httpStatus: 500,
    payload: {
      status: "error",
      code: "INTERNAL_ERROR",
      message: "Internal credential broker error.",
    },
  };
}

const http = httpRouter();

http.route({
  path: "/qa-credentials/v1/acquire",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const tokenRole = resolveAuthRole(parseBearerToken(request));
      const body = await parseJsonObject(request);
      const actorRole = parseActorRole(body);
      assertRoleAllowed(tokenRole, actorRole);

      const result = await ctx.runMutation(internal.credentials.acquireLease, {
        kind: requireString(body, "kind"),
        ownerId: requireString(body, "ownerId"),
        actorRole,
        leaseTtlMs: optionalPositiveInteger(body, "leaseTtlMs"),
        heartbeatIntervalMs: optionalPositiveInteger(body, "heartbeatIntervalMs"),
      });

      return jsonResponse(200, result);
    } catch (error) {
      const normalized = normalizeError(error);
      return jsonResponse(normalized.httpStatus, normalized.payload);
    }
  }),
});

http.route({
  path: "/qa-credentials/v1/heartbeat",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const tokenRole = resolveAuthRole(parseBearerToken(request));
      const body = await parseJsonObject(request);
      const actorRole = parseActorRole(body);
      assertRoleAllowed(tokenRole, actorRole);

      const result = await ctx.runMutation(internal.credentials.heartbeatLease, {
        kind: requireString(body, "kind"),
        ownerId: requireString(body, "ownerId"),
        actorRole,
        credentialId: normalizeCredentialId(
          requireString(body, "credentialId"),
        ) as Id<"credential_sets">,
        leaseToken: requireString(body, "leaseToken"),
        leaseTtlMs: optionalPositiveInteger(body, "leaseTtlMs"),
      });

      return jsonResponse(200, result);
    } catch (error) {
      const normalized = normalizeError(error);
      return jsonResponse(normalized.httpStatus, normalized.payload);
    }
  }),
});

http.route({
  path: "/qa-credentials/v1/release",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const tokenRole = resolveAuthRole(parseBearerToken(request));
      const body = await parseJsonObject(request);
      const actorRole = parseActorRole(body);
      assertRoleAllowed(tokenRole, actorRole);

      const result = await ctx.runMutation(internal.credentials.releaseLease, {
        kind: requireString(body, "kind"),
        ownerId: requireString(body, "ownerId"),
        actorRole,
        credentialId: normalizeCredentialId(
          requireString(body, "credentialId"),
        ) as Id<"credential_sets">,
        leaseToken: requireString(body, "leaseToken"),
      });

      return jsonResponse(200, result);
    } catch (error) {
      const normalized = normalizeError(error);
      return jsonResponse(normalized.httpStatus, normalized.payload);
    }
  }),
});

http.route({
  path: "/qa-credentials/v1/admin/add",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      assertMaintainerAdminAuth(parseBearerToken(request));
      const body = await parseJsonObject(request);
      const kind = requireString(body, "kind");
      const payload = normalizeCredentialPayloadForKind(kind, requireObject(body, "payload"));
      const result = await ctx.runMutation(internal.credentials.addCredentialSet, {
        kind,
        payload,
        note: optionalString(body, "note"),
        actorId: optionalString(body, "actorId"),
        status: optionalCredentialStatus(body, "status"),
      });
      return jsonResponse(200, result);
    } catch (error) {
      const normalized = normalizeError(error);
      return jsonResponse(normalized.httpStatus, normalized.payload);
    }
  }),
});

http.route({
  path: "/qa-credentials/v1/admin/remove",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      assertMaintainerAdminAuth(parseBearerToken(request));
      const body = await parseJsonObject(request);
      const result = await ctx.runMutation(internal.credentials.disableCredentialSet, {
        credentialId: normalizeCredentialId(
          requireString(body, "credentialId"),
        ) as Id<"credential_sets">,
        actorId: optionalString(body, "actorId"),
      });
      return jsonResponse(200, result);
    } catch (error) {
      const normalized = normalizeError(error);
      return jsonResponse(normalized.httpStatus, normalized.payload);
    }
  }),
});

http.route({
  path: "/qa-credentials/v1/admin/list",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      assertMaintainerAdminAuth(parseBearerToken(request));
      const body = await parseJsonObject(request);
      const result = await ctx.runQuery(internal.credentials.listCredentialSets, {
        kind: optionalString(body, "kind"),
        status: optionalListStatus(body, "status"),
        includePayload: optionalBoolean(body, "includePayload"),
        limit: optionalPositiveInteger(body, "limit"),
      });
      return jsonResponse(200, result);
    } catch (error) {
      const normalized = normalizeError(error);
      return jsonResponse(normalized.httpStatus, normalized.payload);
    }
  }),
});

export default http;
