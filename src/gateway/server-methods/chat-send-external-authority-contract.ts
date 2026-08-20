import type { CronCreatorAuthorityCapability } from "../../agents/cron-creator-authority-context.js";
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
  }): CronCreatorAuthorityCapability | undefined;
  run<T>(capability: CronCreatorAuthorityCapability, run: () => T, signal?: AbortSignal): T;
};
