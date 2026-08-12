import type {
  WorkboardReconciliationObservation,
  WorkboardReconciliationPage,
  WorkboardReconciliationSourceObservation,
  WorkboardReconciliationSourceObservationResult,
  WorkboardCard,
  WorkboardExternalExecutionLink,
} from "@openclaw/workboard-contract";
// Plugin runtime types describe activated plugin capabilities exposed to core execution.
// Owner schema module import keeps the ProtocolSchemas registry out of the
// public plugin-sdk dts graph (check-plugin-sdk-exports guards this).
import type { NodePluginToolDescriptor } from "../../../packages/gateway-protocol/src/schema/nodes.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { OperatorScope } from "../../gateway/operator-scopes.js";
import type { PluginRuntimeCore, RuntimeLogger } from "./types-core.js";

export type { RuntimeLogger };

type PluginRuntimeChannel = import("./types-channel.js").PluginRuntimeChannel;

// ── Subagent runtime types ──────────────────────────────────────────

type SubagentRunParams = {
  sessionKey: string;
  message: string;
  /** Add exact tools registered by the calling plugin to the worker's normal tool surface. */
  toolsAlsoAllow?: string[];
  provider?: string;
  model?: string;
  extraSystemPrompt?: string;
  lane?: string;
  lightContext?: boolean;
  deliver?: boolean;
  /** Deliver the completion to the authenticated requester of the current hook invocation. */
  completionDelivery?: "current-requester";
  idempotencyKey?: string;
  cwd?: string;
};

type PluginManagedWorktree = {
  id: string;
  path: string;
  branch: string;
};

type SubagentRunResult = {
  runId: string;
  runtime?: {
    harness: string;
    provider: string;
    model: string;
  };
};

type SubagentWaitParams = {
  runId: string;
  timeoutMs?: number;
};

type SubagentWaitResult = {
  status: "ok" | "error" | "timeout";
  error?: string;
};

type SubagentGetSessionMessagesParams = {
  sessionKey: string;
  limit?: number;
};

type SubagentGetSessionMessagesResult = {
  messages: unknown[];
};

type SubagentDeleteSessionParams = {
  sessionKey: string;
  deleteTranscript?: boolean;
};

type RuntimeNodeListParams = {
  connected?: boolean;
};

type RuntimeNodeListResult = {
  nodes: Array<{
    nodeId: string;
    displayName?: string;
    remoteIp?: string;
    connected?: boolean;
    caps?: string[];
    commands?: string[];
    /** True only for the node host installed alongside this Gateway. */
    gatewayLocal?: boolean;
    /** Advertised commands currently permitted by Gateway node-command policy. */
    invocableCommands?: string[];
    nodePluginTools?: NodePluginToolDescriptor[];
  }>;
};

type RuntimeNodeInvokeParams = {
  nodeId: string;
  command: string;
  params?: unknown;
  timeoutMs?: number;
  idempotencyKey?: string;
  /** Cancel the invocation and any work already dispatched to a first-party node. */
  signal?: AbortSignal;
  /** Requested Gateway scopes. Honored only for bundled or trusted official plugins. */
  scopes?: OperatorScope[];
};

export type RuntimeGatewayRequestOptions = {
  timeoutMs?: number;
  /** Requested Gateway scopes. Honored only for bundled or trusted official plugins. */
  scopes?: OperatorScope[];
};

export type CodexReconciliationTranscriptItem = {
  id: string;
  type: string;
  text?: string;
};

/** Bounded session metadata available to the in-process Codex reconciler. */
export type CodexReconciliationSession = {
  threadId: string;
  sessionId?: string;
  name?: string;
  cwd?: string;
  status: string;
  activeFlags?: string[];
  createdAt?: number;
  updatedAt?: number;
  recencyAt?: number | null;
  source?: string;
  modelProvider?: string;
  cliVersion?: string;
  gitBranch?: string;
  sessionKey?: string;
  archived: boolean;
};

export type CodexReconciliationProvider = {
  list(params: {
    hostId: string;
    archived: boolean;
    cursor?: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<{
    hostId: string;
    sessions: CodexReconciliationSession[];
    /** Opaque per-thread transcript capabilities; never part of session metadata. */
    transcriptCapabilities?: Record<string, string>;
    nextCursor?: string;
    complete: boolean;
  }>;
  withTranscript(
    params: {
      hostId: string;
      threadId: string;
      archived: boolean;
      transcriptCapability: string;
      cursor?: string;
      limit?: number;
      signal?: AbortSignal;
    },
    consume: (items: readonly CodexReconciliationTranscriptItem[]) => Promise<void>,
  ): Promise<void>;
};

export type WorkboardReconciliationApplyResult = {
  outcome: "applied" | "duplicate" | "protected" | "stale" | "conflict";
  observationId: string;
  card: WorkboardCard;
  link: Omit<WorkboardExternalExecutionLink, "idempotencyKey">;
};

/** Bounded in-process Workboard mutation seam; never a Gateway request or store handle. */
export type WorkboardReconciliationProvider = {
  list(params: {
    cursor?: unknown;
    limit?: unknown;
    tenant?: unknown;
    boardId?: unknown;
    terminal?: unknown;
    signal?: AbortSignal;
  }): Promise<WorkboardReconciliationPage>;
  apply(
    params: WorkboardReconciliationObservation & { observationId: unknown; signal?: AbortSignal },
  ): Promise<WorkboardReconciliationApplyResult>;
  observeSource(
    params: WorkboardReconciliationSourceObservation & { signal?: AbortSignal },
  ): Promise<WorkboardReconciliationSourceObservationResult>;
};

/** Trusted in-process runtime surface injected into native plugins. */
export type PluginRuntime = PluginRuntimeCore & {
  /** Trusted in-process Codex source for the personal reconciliation plugin; never a Gateway RPC. */
  codexReconciliation: {
    register: (provider: CodexReconciliationProvider) => void;
    /** Returns the provider only when this runtime is bound to the approved consumer plugin. */
    claim: () => CodexReconciliationProvider | undefined;
  };
  /** Trusted in-process Workboard source for the private Codex reconciler; never a Gateway RPC. */
  workboardReconciliation: {
    register: (provider: WorkboardReconciliationProvider) => void;
    /** Returns the provider only when this runtime is bound to the approved consumer plugin. */
    claim: () => WorkboardReconciliationProvider | undefined;
  };
  gateway: {
    /** Whether this process owns an active Gateway request context. */
    isAvailable: () => Promise<boolean>;
    /** Dispatch a Gateway method as the current trusted plugin. */
    request: <T = unknown>(
      method: string,
      params?: Record<string, unknown>,
      options?: RuntimeGatewayRequestOptions,
    ) => Promise<T>;
  };
  subagent: {
    run: (params: SubagentRunParams) => Promise<SubagentRunResult>;
    waitForRun: (params: SubagentWaitParams) => Promise<SubagentWaitResult>;
    getSessionMessages: (
      params: SubagentGetSessionMessagesParams,
    ) => Promise<SubagentGetSessionMessagesResult>;
    deleteSession: (params: SubagentDeleteSessionParams) => Promise<void>;
  };
  nodes: {
    list: (params?: RuntimeNodeListParams) => Promise<RuntimeNodeListResult>;
    invoke: (params: RuntimeNodeInvokeParams) => Promise<unknown>;
  };
  sandbox: {
    resolveWorkspaceAuthority: (params: {
      config: OpenClawConfig;
      agentId?: string;
      confinedToolNames?: readonly string[];
      requiredToolNames?: readonly string[];
      modelProvider?: string;
      modelId?: string;
      sessionKey: string;
    }) => {
      sandboxed: boolean;
      workspaceAccess: "none" | "ro" | "rw";
      confinementError?: string;
    };
    prepareWorkspaceAuthority: (params: {
      config: OpenClawConfig;
      agentId?: string;
      confinedToolNames?: readonly string[];
      requiredToolNames?: readonly string[];
      modelProvider?: string;
      modelId?: string;
      sessionKey: string;
      workspaceDir: string;
    }) => Promise<{
      sandboxed: boolean;
      workspaceAccess: "none" | "ro" | "rw";
      confinementError?: string;
    }>;
  };
  worktrees: {
    resolveCheckoutRoot: (params: { path: string }) => Promise<string | undefined>;
    hasSelfContainedCheckoutMetadata?: (params: { path: string }) => Promise<boolean>;
    create: (params: {
      repoRoot: string;
      name: string;
      baseRef?: string;
      ownerKind: "workboard";
      ownerId: string;
    }) => Promise<PluginManagedWorktree>;
    release: (params: { path: string }) => Promise<void>;
    removeIfLossless: (params: {
      path: string;
      ownerKind: "workboard";
      ownerId: string;
    }) => Promise<boolean>;
  };
  channel: PluginRuntimeChannel;
};

export type CreatePluginRuntimeOptions = {
  subagent?: PluginRuntime["subagent"];
  nodes?: PluginRuntime["nodes"];
  allowGatewaySubagentBinding?: boolean;
};
