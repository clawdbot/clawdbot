import { runWithCronCreatorAuthority } from "../../agents/cron-creator-authority-context.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import { handleChatSend } from "./chat-send-handler.js";
import { resolveGatewayChatCronCreatorAuthorityAdmission } from "./cron-creator-authority-admission.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export type ChatSendExternalAuthorityAdmission = {
  resolve(params: {
    runId: string;
    sessionKey: string;
    spawnedBy?: string;
    client: GatewayRequestHandlerOptions["client"];
    inputProvenance?: InputProvenance;
    hasExplicitOrigin: boolean;
    hasRestoredCronContinuation: boolean;
    isIncognitoEntry: boolean;
    isReconnectResume: boolean;
    isSystemGenerated: boolean;
    turnKind: "btw" | "main";
  }): Readonly<{ runId: string }> | undefined;
  run<T>(authority: Readonly<{ runId: string }>, run: () => T, signal?: AbortSignal): T;
};

const externalAuthorityAdmission: ChatSendExternalAuthorityAdmission = {
  resolve: (params) =>
    resolveGatewayChatCronCreatorAuthorityAdmission({
      runId: params.runId,
      resolvedSessionKey: params.sessionKey,
      spawnedBy: params.spawnedBy,
      client: params.client,
      inputProvenance: params.inputProvenance,
      hasExplicitOrigin: params.hasExplicitOrigin,
      hasRestoredCronContinuation: params.hasRestoredCronContinuation,
      isIncognito: params.isIncognitoEntry || isIncognitoSessionKey(params.sessionKey),
      isReconnectResume: params.isReconnectResume,
      isSystemGenerated: params.isSystemGenerated,
      turnKind: params.turnKind,
      isDirectExternalUser: true,
    }),
  run: (authority, run, signal) => runWithCronCreatorAuthority(authority.runId, run, signal),
};

/** Authenticated external chat entry; internal re-entry must call handleChatSend directly. */
export function handleDirectExternalChatSend(
  options: GatewayRequestHandlerOptions,
  onAdmissionOwned?: () => Promise<boolean>,
): Promise<void> {
  return handleChatSend(options, onAdmissionOwned, externalAuthorityAdmission);
}
