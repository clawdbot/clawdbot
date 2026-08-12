import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

const McpOAuthCredentialPresenceSchema = Type.Boolean();
const McpOAuthAuthorizationPathSchema = Type.String({
  minLength: 1,
  pattern: "^/oauth/mcp/authorize/[^/?#]+$",
});

export const McpOAuthErrorCategorySchema = Type.Union([
  Type.Literal("authorization-denied"),
  Type.Literal("callback-invalid"),
  Type.Literal("exchange-failed"),
  Type.Literal("timed-out"),
]);

export const McpOAuthControlStatusSchema = Type.Union([
  closedObject({
    state: Type.Literal("authorization-required"),
    credentialPresent: Type.Literal(false),
  }),
  closedObject({
    state: Type.Literal("authorizing"),
    credentialPresent: McpOAuthCredentialPresenceSchema,
    authorizationId: NonEmptyString,
    startedAt: Type.Integer({ minimum: 0 }),
  }),
  closedObject({
    state: Type.Literal("ready"),
    credentialPresent: Type.Literal(true),
  }),
  closedObject({
    state: Type.Literal("error"),
    credentialPresent: McpOAuthCredentialPresenceSchema,
    category: McpOAuthErrorCategorySchema,
  }),
]);

export const McpOAuthStatusParamsSchema = closedObject({
  serverName: NonEmptyString,
});

export const McpOAuthStatusResultSchema = closedObject({
  status: McpOAuthControlStatusSchema,
});

export const McpOAuthStartParamsSchema = closedObject({
  serverName: NonEmptyString,
  reauthorize: Type.Optional(Type.Boolean()),
});

export const McpOAuthStartResultSchema = closedObject({
  status: McpOAuthControlStatusSchema,
  authorizationPath: Type.Optional(McpOAuthAuthorizationPathSchema),
});

export const McpOAuthCancelParamsSchema = closedObject({
  serverName: NonEmptyString,
  authorizationId: NonEmptyString,
});

export const McpOAuthCancelResultSchema = closedObject({
  cancelled: Type.Boolean(),
  status: McpOAuthControlStatusSchema,
});

export const McpOAuthDisconnectParamsSchema = closedObject({
  serverName: NonEmptyString,
});

export const McpOAuthDisconnectResultSchema = closedObject({
  status: McpOAuthControlStatusSchema,
});

export type McpOAuthErrorCategory = Static<typeof McpOAuthErrorCategorySchema>;
export type McpOAuthControlStatus = Static<typeof McpOAuthControlStatusSchema>;
export type McpOAuthStatusParams = Static<typeof McpOAuthStatusParamsSchema>;
export type McpOAuthStatusResult = Static<typeof McpOAuthStatusResultSchema>;
export type McpOAuthStartParams = Static<typeof McpOAuthStartParamsSchema>;
export type McpOAuthStartResult = Static<typeof McpOAuthStartResultSchema>;
export type McpOAuthCancelParams = Static<typeof McpOAuthCancelParamsSchema>;
export type McpOAuthCancelResult = Static<typeof McpOAuthCancelResultSchema>;
export type McpOAuthDisconnectParams = Static<typeof McpOAuthDisconnectParamsSchema>;
export type McpOAuthDisconnectResult = Static<typeof McpOAuthDisconnectResultSchema>;
