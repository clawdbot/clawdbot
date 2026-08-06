import type {
  CodexAppServerBindingIdentity,
  CodexAppServerThreadBinding,
} from "./app-server/session-binding.js";

export type CodexDiagnosticsTarget = {
  threadId: string;
  identity: CodexAppServerBindingIdentity;
  agentDir: string;
  connectionScope?: "supervision";
  appServerRuntimeFingerprint?: string;
  pendingSupervisionBranch?: CodexAppServerThreadBinding["pendingSupervisionBranch"];
  authProfileId?: string;
  sessionKey?: string;
  sessionId?: string;
  channel?: string;
  channelId?: string;
  accountId?: string;
  messageThreadId?: string | number;
  threadParentId?: string;
};

export type PendingCodexDiagnosticsConfirmation = {
  token: string;
  targets: CodexDiagnosticsTarget[];
  note?: string;
  senderId: string;
  channel: string;
  accountId?: string;
  channelId?: string;
  messageThreadId?: string;
  threadParentId?: string;
  sessionKey?: string;
  scopeKey: string;
  privateRouted?: boolean;
  createdAt: number;
};

/** Runtime state for diagnostics upload throttling and confirmation handshakes. */
export const codexDiagnosticsFeedbackState = {
  lastUploadByThread: new Map<string, number>(),
  lastUploadByScope: new Map<string, number>(),
  pendingConfirmations: new Map<string, PendingCodexDiagnosticsConfirmation>(),
  pendingTokensByScope: new Map<string, string[]>(),
  clear(): void {
    this.lastUploadByThread.clear();
    this.lastUploadByScope.clear();
    this.pendingConfirmations.clear();
    this.pendingTokensByScope.clear();
  },
};
