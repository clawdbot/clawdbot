const RESERVED_SUBAGENT_CLAIM_TOKEN: unique symbol = Symbol.for(
  "openclaw.reservedSubagentClaimToken",
);

type ReservedSubagentAdmissionRequest = Record<string | symbol, unknown>;

export function attachReservedSubagentClaimToken(
  request: Record<string, unknown>,
  claimToken: string,
): Record<string, unknown> {
  return Object.assign({}, request, {
    [RESERVED_SUBAGENT_CLAIM_TOKEN]: claimToken,
  });
}

export function readReservedSubagentClaimToken(request: unknown): string | undefined {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return undefined;
  }
  const token = (request as ReservedSubagentAdmissionRequest)[RESERVED_SUBAGENT_CLAIM_TOKEN];
  return typeof token === "string" && token ? token : undefined;
}
