import { lazyCompile } from "./protocol-validator.js";
import {
  SessionsDispatchParamsSchema,
  SessionsMoveParamsSchema,
} from "./schema/session-placement.js";

export const validateSessionsDispatchParams = lazyCompile(SessionsDispatchParamsSchema);
export const validateSessionsMoveParams = lazyCompile(SessionsMoveParamsSchema);
