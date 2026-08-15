import {
  clearCloudSessionRecovery,
  listCloudSessionRecoveries,
  parseCloudSessionCreateParams,
  promoteCloudSessionRecovery,
  type CloudSessionCreateParams,
  type CloudSessionRecovery,
  writeCloudSessionRecovery,
} from "../../lib/sessions/cloud-recovery.ts";
import type { SessionCreateParams } from "../../lib/sessions/create.ts";
import { generateUUID } from "../../lib/uuid.ts";

export type SubmissionOutcomeReason = "gateway-changed" | "cloud-interrupted";

export function resolveSubmissionOutcomeReason(params: {
  gatewayIdentityChanged: boolean;
  cloudDraftOwned: boolean;
}): SubmissionOutcomeReason {
  return params.gatewayIdentityChanged || !params.cloudDraftOwned
    ? "gateway-changed"
    : "cloud-interrupted";
}

export function resolveScope(
  snapshot: {
    client: { recoveryScope?: string; recoveryScopeReady?: boolean } | null;
    connected: boolean;
  },
  current: string,
  firstBind: boolean,
): { next: string; changed: boolean } {
  // Retain the verified scope until replacement auth arrives; a different scope invalidates it.
  const next =
    snapshot.connected && snapshot.client?.recoveryScopeReady
      ? (snapshot.client.recoveryScope ?? "")
      : current;
  return { next, changed: !firstBind && snapshot.connected && current !== next };
}

export class PendingCloudRecoveryState {
  sessionKey = "";
  messageId = "";
  message = "";
  attachments: unknown[] | undefined;
  profileId = "";
  agentId = "";
  gatewayUrl = "";
  recoveryScope = "";
  phase: CloudSessionRecovery["phase"] = "dispatching";
  createParams: CloudSessionCreateParams | undefined;
  retryAllowed = false;
  restored = false;
  persistent = true;

  clear() {
    if (this.persistent) {
      clearCloudSessionRecovery(this.gatewayUrl, this.recoveryScope, this.sessionKey);
    }
    this.reset();
  }

  clearFor(gatewayUrl: string, recoveryScope: string, sessionKey: string) {
    clearCloudSessionRecovery(gatewayUrl, recoveryScope, sessionKey);
    if (this.owns(gatewayUrl, recoveryScope, sessionKey)) {
      this.reset();
    }
  }

  // Concurrent same-key replacement pages may double-clear recovery; that rare multi-tab flow is
  // accepted in favor of ownership based only on gateway URL, recovery scope, and session key.
  owns(gatewayUrl: string, recoveryScope: string, sessionKey: string): boolean {
    return (
      this.gatewayUrl === gatewayUrl &&
      this.recoveryScope === recoveryScope &&
      this.sessionKey === sessionKey
    );
  }

  reset() {
    this.sessionKey = "";
    this.messageId = "";
    this.message = "";
    this.attachments = undefined;
    this.profileId = "";
    this.agentId = "";
    this.gatewayUrl = "";
    this.recoveryScope = "";
    this.phase = "dispatching";
    this.createParams = undefined;
    this.retryAllowed = false;
    this.restored = false;
    this.persistent = true;
  }

  restore(gatewayUrl: string, recoveryScope: string): CloudSessionRecovery | null {
    const recovery = listCloudSessionRecoveries(gatewayUrl, recoveryScope).find(
      (candidate) => candidate.phase === "creating",
    );
    if (!recovery) {
      return null;
    }
    this.apply(recovery, true, true);
    return recovery;
  }

  capture(): CloudSessionRecovery | null {
    return this.snapshot(this.sessionKey, this.phase);
  }

  stageCreate(params: {
    agentId: string;
    profileId: string;
    message: string;
    attachments?: unknown[];
    gatewayUrl: string;
    recoveryScope: string;
    createParams: SessionCreateParams;
    persistent?: boolean;
  }): CloudSessionCreateParams | null {
    const sessionKey = `agent:${params.agentId}:dashboard:${generateUUID()}`;
    const createParams = parseCloudSessionCreateParams(
      { ...params.createParams, key: sessionKey },
      sessionKey,
      params.agentId,
    );
    if (!createParams) {
      return null;
    }
    const persistent = params.persistent !== false;
    if (!persistent) {
      delete createParams.key;
    }
    const recovery = {
      sessionKey,
      messageId: generateUUID(),
      message: params.message,
      attachments: params.attachments,
      profileId: params.profileId,
      agentId: params.agentId,
      gatewayUrl: params.gatewayUrl,
      recoveryScope: params.recoveryScope,
      phase: "creating",
      createParams,
    } satisfies CloudSessionRecovery;
    if (persistent && !writeCloudSessionRecovery(recovery)) {
      return null;
    }
    this.apply(recovery, false, persistent);
    return createParams;
  }

  promoteToDispatching(sessionKey: string): boolean {
    const previousSessionKey = this.sessionKey;
    const recovery = this.snapshot(sessionKey, "dispatching");
    if (
      !recovery ||
      (this.persistent && !promoteCloudSessionRecovery(previousSessionKey, recovery))
    ) {
      return false;
    }
    this.sessionKey = sessionKey;
    this.phase = "dispatching";
    this.createParams = undefined;
    return true;
  }

  private snapshot(
    sessionKey: string,
    phase: CloudSessionRecovery["phase"],
  ): CloudSessionRecovery | null {
    if (
      !this.sessionKey ||
      !this.messageId ||
      !this.profileId ||
      !this.agentId ||
      (phase === "creating" && !this.createParams)
    ) {
      return null;
    }
    return {
      sessionKey,
      messageId: this.messageId,
      message: this.message,
      attachments: this.attachments ? [...this.attachments] : undefined,
      profileId: this.profileId,
      agentId: this.agentId,
      gatewayUrl: this.gatewayUrl,
      recoveryScope: this.recoveryScope,
      phase,
      ...(phase === "creating" && this.createParams
        ? { createParams: { ...this.createParams } }
        : {}),
    };
  }

  private apply(recovery: CloudSessionRecovery, restored: boolean, persistent: boolean) {
    this.sessionKey = recovery.sessionKey;
    this.messageId = recovery.messageId;
    this.message = recovery.message;
    this.attachments = recovery.attachments;
    this.profileId = recovery.profileId;
    this.agentId = recovery.agentId;
    this.gatewayUrl = recovery.gatewayUrl;
    this.recoveryScope = recovery.recoveryScope;
    this.phase = recovery.phase;
    this.createParams = recovery.createParams;
    this.retryAllowed = true;
    this.restored = restored;
    this.persistent = persistent;
  }
}
