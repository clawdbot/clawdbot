import type { InputProvenance } from "../../sessions/input-provenance.js";
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
