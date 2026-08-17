import type { Result } from "@openclaw/normalization-core/result";
import type { CodeModeApiVirtualFile } from "./code-mode-namespaces.js";

type CodeModeBridgeMethod =
  | "search"
  | "describe"
  | "call"
  | "callValue"
  | "nodes"
  | "yield"
  | "namespace"
  | "agentSpawn"
  | "agentWait"
  | "skillsList"
  | "skillsRead"
  | "sleep"
  | "swarmNote";

export type CodeModeConfig = {
  timeoutMs: number;
  memoryLimitBytes: number;
  maxOutputBytes: number;
  maxPendingToolCalls: number;
  maxSnapshotBytes: number;
};

export type PendingBridgeRequest = {
  id: string;
  method: CodeModeBridgeMethod;
  args: unknown[];
};

export type SettledBridgeRequest = { id: string } & Result<unknown, string>;

type SerializedCodeModeNamespaceValue =
  | { kind: "array"; items: SerializedCodeModeNamespaceValue[] }
  | { kind: "function"; path: string[] }
  | { kind: "object"; entries: Array<[string, SerializedCodeModeNamespaceValue]> }
  | { kind: "value"; value: unknown };

export type CodeModeNamespaceDescriptor = {
  id: string;
  globalName: string;
  description?: string;
  scope: SerializedCodeModeNamespaceValue;
};

type CodeModeWorkerInput =
  | {
      kind: "exec";
      source: string;
      config: CodeModeConfig;
      catalog: unknown[];
      apiFiles?: CodeModeApiVirtualFile[];
      namespaces: CodeModeNamespaceDescriptor[];
      swarmEnabled?: boolean;
    }
  | {
      kind: "resume";
      snapshotBytes: Uint8Array;
      config: CodeModeConfig;
      settledRequests: SettledBridgeRequest[];
      pendingRequests?: PendingBridgeRequest[];
    };

export type CodeModeWorkerPayload = CodeModeWorkerInput & {
  wasmModule: WebAssembly.Module;
};

export type CodeModeSettlementMode =
  | { kind: "awaiting" }
  | { kind: "draining"; requiredRequestIds: string[] };

export type CodeModeFailurePhase = "input" | "guest" | "bridge" | "host";

export type CodeModeWorkerThreadResult =
  | {
      status: "completed";
      value: unknown;
      output: unknown[];
    }
  | {
      status: "waiting";
      snapshotBytes: Uint8Array;
      pendingRequests: PendingBridgeRequest[];
      canceledRequestIds: string[];
      settlementMode: CodeModeSettlementMode;
      output: unknown[];
    }
  | {
      status: "failed";
      error: string;
      code:
        | "invalid_input"
        | "runtime_unavailable"
        | "timeout"
        | "snapshot_limit_exceeded"
        | "internal_error";
      failurePhase: Extract<CodeModeFailurePhase, "input" | "guest">;
      bridgeDispatchStarted: false;
      output: unknown[];
    };
