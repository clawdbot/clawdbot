// Gateway Protocol schema module defines operator-originated system events.
import type { Static } from "typebox";
import { Type } from "typebox";
import { lazyCompile } from "../protocol-validator.js";
import { closedObject } from "./closed-object.js";

/** Operator event plus optional presence metadata and exact-session wake routing. */
export const SystemEventParamsSchema = closedObject({
  text: Type.String(),
  idempotencyKey: Type.Optional(Type.String({ minLength: 1 })),
  sessionKey: Type.Optional(Type.String()),
  wake: Type.Optional(Type.Boolean()),
  deviceId: Type.Optional(Type.String()),
  instanceId: Type.Optional(Type.String()),
  host: Type.Optional(Type.String()),
  ip: Type.Optional(Type.String()),
  mode: Type.Optional(Type.String()),
  version: Type.Optional(Type.String()),
  platform: Type.Optional(Type.String()),
  deviceFamily: Type.Optional(Type.String()),
  modelIdentifier: Type.Optional(Type.String()),
  lastInputSeconds: Type.Optional(Type.Number()),
  reason: Type.Optional(Type.String()),
  roles: Type.Optional(Type.Array(Type.String())),
  scopes: Type.Optional(Type.Array(Type.String())),
  tags: Type.Optional(Type.Array(Type.String())),
});

export type SystemEventParams = Static<typeof SystemEventParamsSchema>;
export const validateSystemEventParams = lazyCompile(SystemEventParamsSchema);
