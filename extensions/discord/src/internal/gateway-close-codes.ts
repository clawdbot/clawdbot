import { GatewayCloseCodes } from "discord-api-types/v10";

const fatalGatewayCloseCodes = new Set<GatewayCloseCodes>([
  GatewayCloseCodes.AuthenticationFailed,
  GatewayCloseCodes.InvalidShard,
  GatewayCloseCodes.ShardingRequired,
  GatewayCloseCodes.InvalidAPIVersion,
  GatewayCloseCodes.InvalidIntents,
  GatewayCloseCodes.DisallowedIntents,
]);

const nonResumableGatewayCloseCodes = new Set<GatewayCloseCodes>([
  GatewayCloseCodes.NotAuthenticated,
  GatewayCloseCodes.InvalidSeq,
  GatewayCloseCodes.SessionTimedOut,
  GatewayCloseCodes.AlreadyAuthenticated,
]);

export function isFatalGatewayCloseCode(code: GatewayCloseCodes): boolean {
  return fatalGatewayCloseCodes.has(code);
}

export function canResumeAfterGatewayClose(code: GatewayCloseCodes): boolean {
  return !nonResumableGatewayCloseCodes.has(code);
}
