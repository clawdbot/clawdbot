import type { Result } from "@openclaw/normalization-core/result";
import type { CodeModeApiVirtualFile } from "./code-mode-namespaces.js";

export const CODE_MODE_BRIDGE_METHODS = [
  "search",
  "describe",
  "call",
  "callValue",
  "nodes",
  "yield",
  "namespace",
  "agentSpawn",
  "agentWait",
  "skillsList",
  "skillsRead",
  "swarmNote",
] as const;

export type CodeModeBridgeMethod = (typeof CODE_MODE_BRIDGE_METHODS)[number];

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
  /** Exact UTF-8 byte length of the guest's serialized argument payload. */
  argumentBytes?: number;
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

export type CodeModeSnapshotMeasurement = {
  bytes: number;
  serializationMs: number;
};

export type CodeModeWorkerThreadMessage =
  | { kind: "snapshot_started" }
  | ({ kind: "snapshot_produced" } & CodeModeSnapshotMeasurement)
  | { kind: "result"; result: CodeModeWorkerThreadResult };

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
        | "output_limit_exceeded"
        | "snapshot_limit_exceeded"
        | "internal_error";
      failurePhase: Extract<CodeModeFailurePhase, "input" | "guest">;
      bridgeDispatchStarted: false;
      bridgeRequestId?: string;
      output: unknown[];
    };
