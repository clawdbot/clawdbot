export class ReefRelayError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ReefRelayError";
  }
}

export class ReefRelayUnavailableError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ReefRelayUnavailableError";
  }
}

export class ReefProtocolCompatibilityError extends ReefRelayError {
  constructor(
    status: 400 | 404 | 409,
    code: "invalid_request" | "not_found" | "client_upgrade_required",
    readonly upgradeRequired: "reef-relay" | "openclaw-client",
    message: string,
  ) {
    super(status, message, code);
    this.name = "ReefProtocolCompatibilityError";
  }
}
