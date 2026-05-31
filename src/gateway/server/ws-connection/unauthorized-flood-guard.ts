import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import { ErrorCodes, type ErrorShape } from "../../../../packages/gateway-protocol/src/index.js";

export type UnauthorizedFloodGuardOptions = {
  closeAfter?: number;
  logEvery?: number;
};

export type UnauthorizedFloodDecision = {
  shouldClose: boolean;
  shouldLog: boolean;
  count: number;
  suppressedSinceLastLog: number;
};

const DEFAULT_CLOSE_AFTER = 10;
const DEFAULT_LOG_EVERY = 100;

export class UnauthorizedFloodGuard {
  private readonly closeAfter: number;
  private readonly logEvery: number;
  private count = 0;
  private suppressedSinceLastLog = 0;

  constructor(options?: UnauthorizedFloodGuardOptions) {
    this.closeAfter = resolveIntegerOption(options?.closeAfter, DEFAULT_CLOSE_AFTER, { min: 1 });
    this.logEvery = resolveIntegerOption(options?.logEvery, DEFAULT_LOG_EVERY, { min: 1 });
  }

  registerUnauthorized(): UnauthorizedFloodDecision {
    this.count += 1;
    const shouldClose = this.count > this.closeAfter;
    const shouldLog = this.count === 1 || this.count % this.logEvery === 0 || shouldClose;

    if (!shouldLog) {
      this.suppressedSinceLastLog += 1;
      return {
        shouldClose,
        shouldLog: false,
        count: this.count,
        suppressedSinceLastLog: 0,
      };
    }

    const suppressedSinceLastLog = this.suppressedSinceLastLog;
    this.suppressedSinceLastLog = 0;
    return {
      shouldClose,
      shouldLog: true,
      count: this.count,
      suppressedSinceLastLog,
    };
  }

  reset(): void {
    this.count = 0;
    this.suppressedSinceLastLog = 0;
  }
}

export function isUnauthorizedRoleError(error?: ErrorShape): boolean {
  if (!error) {
    return false;
  }
  return (
    error.code === ErrorCodes.INVALID_REQUEST &&
    typeof error.message === "string" &&
    error.message.startsWith("unauthorized role:")
  );
}
