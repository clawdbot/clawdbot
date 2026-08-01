// Gateway Protocol schema module defines operator-originated system events.
import { Type } from "typebox";
import { lazyCompile } from "../protocol-validator.js";
import { closedObject } from "./closed-object.js";

/** Backward-compatible system-presence marker for removing retained input recency. */
export const SYSTEM_PRESENCE_CLEAR_LAST_INPUT_TAG = "system-presence-clear-last-input";
/** Non-sensitive overwrite for Gateways that accept tags but do not interpret the clear marker. */
export const SYSTEM_PRESENCE_LEGACY_CLEAR_LAST_INPUT_SECONDS = 2_592_000;

/** Operator event plus optional presence metadata and exact-session wake routing. */
const SystemEventParamsSchema = closedObject({
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

export const validateSystemEventParams = lazyCompile(SystemEventParamsSchema);
