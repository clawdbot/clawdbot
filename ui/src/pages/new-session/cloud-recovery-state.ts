import type { SessionCreateParams } from "../../lib/sessions/create.ts";
import { generateUUID } from "../../lib/uuid.ts";
import {
  clearCloudSessionRecovery,
  parseCloudSessionCreateParams,
  readCloudSessionRecovery,
  type CloudSessionCreateParams,
  type CloudSessionRecovery,
  writeCloudSessionRecovery,
} from "./cloud-recovery.ts";

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

  clear() {
    clearCloudSessionRecovery(this.gatewayUrl, this.recoveryScope, this.sessionKey);
    this.reset();
  }

  clearFor(gatewayUrl: string, recoveryScope: string, sessionKey: string) {
    clearCloudSessionRecovery(gatewayUrl, recoveryScope, sessionKey);
    if (this.owns(gatewayUrl, recoveryScope, sessionKey)) {
      this.reset();
    }
  }

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
  }

  restore(gatewayUrl: string, recoveryScope: string): CloudSessionRecovery | null {
    const recovery = readCloudSessionRecovery(gatewayUrl, recoveryScope);
    if (!recovery) {
      return null;
    }
    this.apply(recovery, true);
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
    if (!writeCloudSessionRecovery(recovery)) {
      return null;
    }
    this.apply(recovery, false);
    return createParams;
  }

  promoteToDispatching(sessionKey: string): boolean {
    const recovery = this.snapshot(sessionKey, "dispatching");
    if (!recovery || !writeCloudSessionRecovery(recovery)) {
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

  private apply(recovery: CloudSessionRecovery, restored: boolean) {
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
  }
}
