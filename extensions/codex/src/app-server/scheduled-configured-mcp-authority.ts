import { isIncognitoSessionKey } from "../incognito-session.js";

/** Limits fresh scheduled-authority capture to authenticated local durable operator turns. */
export function canResolveScheduledConfiguredMcpCreatorAuthority(params: {
  trigger?: string;
  connectionClass: string;
  bindingKind: string;
  bindingSessionKey?: string;
  sessionKey?: string;
  usesSupervisionConnection: boolean;
  preservesNativeModel: boolean;
  senderIsOwner?: boolean;
  senderId?: string | null;
  inputProvenance?: unknown;
  trustedInternalHandoff?: unknown;
  spawnedBy?: string | null;
  scheduledToolPolicy?: unknown;
  hasStaticConfiguredMcp: boolean;
}): boolean {
  return (
    params.trigger === "user" &&
    params.connectionClass === "local-loopback" &&
    params.bindingKind === "session" &&
    Boolean(params.bindingSessionKey) &&
    !isIncognitoSessionKey(params.sessionKey) &&
    !params.usesSupervisionConnection &&
    !params.preservesNativeModel &&
    params.senderIsOwner === true &&
    !params.senderId &&
    params.inputProvenance === undefined &&
    params.trustedInternalHandoff === undefined &&
    !params.spawnedBy &&
    params.scheduledToolPolicy === undefined &&
    params.hasStaticConfiguredMcp
  );
}
