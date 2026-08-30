import type { ErrorShape } from "../../packages/gateway-protocol/src/index.js";

export class SessionMutationAuthorizationChangedError extends Error {
  readonly error: ErrorShape;

  constructor(error: ErrorShape) {
    super(error.message);
    this.name = "SessionMutationAuthorizationChangedError";
    this.error = error;
  }
}

export type SessionMutationTarget = {
  sessionKey: string;
  agentId?: string;
};
