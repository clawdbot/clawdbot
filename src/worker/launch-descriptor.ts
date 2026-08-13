import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import {
  type WorkerConnectParams,
  type WorkerConnectRequestFrame,
  WorkerConnectRequestFrameSchema,
  type WorkerTranscriptMessage,
  WorkerTranscriptMessageSchema,
  type WorkerTranscriptCommitParams,
  WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type {
  WorkerInferenceModelRef,
  WorkerInferenceOptions,
} from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import {
  WORKER_INFERENCE_MAX_CONTEXT_MESSAGES,
  WorkerInferenceModelRefSchema,
  WorkerInferenceOptionsSchema,
} from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";
import type { OperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import { isWorkerToolName, type WorkerToolAuthority } from "./tool-authority.js";
import { isWorkerTranscriptMessageFrameSafe } from "./transcript-message.js";
import {
  parseWorkerConnectionEndpoint,
  type WorkerConnectionEndpoint,
} from "./worker-connection-endpoint.js";

const LAUNCH_VERSION = 3;

export type WorkerBrowserLaunchDescriptor = {
  cdpUrl: string;
  launcherPath: string;
};

type WorkerLaunchAssignment = {
  /** Host placement namespace used for worker-local policy, hooks, and audit attribution. */
  agentId: string;
  operationalRunInstance: OperationalRunInstanceRef;
  /** Opaque host-signed runtime envelope; worker code never parses private identity. */
  agentRuntimeIdentityToken: string;
  runId: string;
  turnId: string;
  prompt: string;
  suppressPromptTranscript: boolean;
  workspaceDir: string;
  modelRef: WorkerInferenceModelRef;
  inferenceOptions: WorkerInferenceOptions;
  systemPrompt?: string;
  initialMessages: WorkerTranscriptMessage[];
  transcript: {
    baseLeafId: WorkerTranscriptCommitParams["baseLeafId"];
    nextSeq: number;
  };
  liveEvents: {
    ackedSeq: number;
    nextSeq: number;
  };
  toolAuthority: WorkerToolAuthority;
  browser?: WorkerBrowserLaunchDescriptor;
};

type WorkerLaunchAdmission = Omit<WorkerConnectParams["admission"], "runId"> & {
  sessionId: string;
};

export type WorkerLaunchDescriptor = {
  version: 3;
  connectionEndpoint: WorkerConnectionEndpoint;
  admission: WorkerLaunchAdmission;
  assignment: WorkerLaunchAssignment;
};

function hasExactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key))
  );
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH
  );
}

function isSafeSequence(value: unknown, minimum: number): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= minimum;
}

function isInferenceOptions(value: unknown): value is WorkerInferenceOptions {
  return Value.Check(WorkerInferenceOptionsSchema, value);
}

function parseToolAuthority(value: unknown): WorkerToolAuthority | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["allowedToolNames"]) ||
    !Array.isArray(value.allowedToolNames) ||
    !value.allowedToolNames.every(isWorkerToolName) ||
    new Set(value.allowedToolNames).size !== value.allowedToolNames.length
  ) {
    return undefined;
  }
  return { allowedToolNames: [...value.allowedToolNames] };
}

function parseBrowserLaunchDescriptor(value: unknown): WorkerBrowserLaunchDescriptor | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["cdpUrl", "launcherPath"]) ||
    typeof value.cdpUrl !== "string" ||
    typeof value.launcherPath !== "string" ||
    !path.isAbsolute(value.launcherPath)
  ) {
    return undefined;
  }
  let cdpUrl: URL;
  try {
    cdpUrl = new URL(value.cdpUrl);
  } catch {
    return undefined;
  }
  const port = Number(cdpUrl.port);
  if (
    cdpUrl.protocol !== "http:" ||
    cdpUrl.hostname !== "127.0.0.1" ||
    cdpUrl.username !== "" ||
    cdpUrl.password !== "" ||
    cdpUrl.port === "" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    cdpUrl.pathname !== "/" ||
    cdpUrl.search !== "" ||
    cdpUrl.hash !== ""
  ) {
    return undefined;
  }
  return {
    cdpUrl: value.cdpUrl,
    launcherPath: value.launcherPath,
  };
}

function parseAssignment(value: unknown): WorkerLaunchAssignment | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      [
        "agentId",
        "runId",
        "operationalRunInstance",
        "agentRuntimeIdentityToken",
        "turnId",
        "prompt",
        "suppressPromptTranscript",
        "workspaceDir",
        "modelRef",
        "inferenceOptions",
        "initialMessages",
        "transcript",
        "liveEvents",
        "toolAuthority",
      ],
      ["systemPrompt", "browser"],
    )
  ) {
    return undefined;
  }
  if (
    !isIdentifier(value.agentId) ||
    !isIdentifier(value.runId) ||
    !isRecord(value.operationalRunInstance) ||
    !isIdentifier(value.operationalRunInstance.instanceId) ||
    value.operationalRunInstance.runId !== value.runId ||
    typeof value.agentRuntimeIdentityToken !== "string" ||
    value.agentRuntimeIdentityToken.length < 1 ||
    value.agentRuntimeIdentityToken.length > 16_384 ||
    !isIdentifier(value.turnId) ||
    typeof value.prompt !== "string" ||
    typeof value.suppressPromptTranscript !== "boolean" ||
    !isIdentifier(value.workspaceDir) ||
    !path.isAbsolute(value.workspaceDir) ||
    (value.systemPrompt !== undefined && typeof value.systemPrompt !== "string") ||
    !Array.isArray(value.initialMessages) ||
    value.initialMessages.length > WORKER_INFERENCE_MAX_CONTEXT_MESSAGES ||
    !value.initialMessages.every((message) => Value.Check(WorkerTranscriptMessageSchema, message))
  ) {
    return undefined;
  }
  const toolAuthority = parseToolAuthority(value.toolAuthority);
  if (!toolAuthority) {
    return undefined;
  }
  const browser =
    value.browser === undefined ? undefined : parseBrowserLaunchDescriptor(value.browser);
  if (value.browser !== undefined && !browser) {
    return undefined;
  }
  if (
    !Value.Check(WorkerInferenceModelRefSchema, value.modelRef) ||
    !isInferenceOptions(value.inferenceOptions)
  ) {
    return undefined;
  }
  if (
    !isRecord(value.transcript) ||
    !hasExactKeys(value.transcript, ["baseLeafId", "nextSeq"]) ||
    (value.transcript.baseLeafId !== null && !isIdentifier(value.transcript.baseLeafId)) ||
    !isSafeSequence(value.transcript.nextSeq, 1)
  ) {
    return undefined;
  }
  if (
    !isRecord(value.liveEvents) ||
    !hasExactKeys(value.liveEvents, ["ackedSeq", "nextSeq"]) ||
    !isSafeSequence(value.liveEvents.ackedSeq, 0) ||
    !isSafeSequence(value.liveEvents.nextSeq, 1) ||
    value.liveEvents.nextSeq !== value.liveEvents.ackedSeq + 1
  ) {
    return undefined;
  }
  return {
    ...value,
    operationalRunInstance: Object.freeze({
      instanceId: value.operationalRunInstance.instanceId,
      runId: value.runId,
    }),
    toolAuthority,
    ...(browser ? { browser } : {}),
  } as WorkerLaunchAssignment;
}

export function buildWorkerConnectParams(
  descriptor: Pick<WorkerLaunchDescriptor, "admission" | "assignment">,
): WorkerConnectParams {
  return {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: {
      id: GATEWAY_CLIENT_IDS.WORKER,
      version: descriptor.admission.handshake.openclawVersion,
      platform: process.platform,
      mode: GATEWAY_CLIENT_MODES.WORKER,
    },
    role: "worker",
    admission: {
      ...descriptor.admission,
      runId: descriptor.assignment.runId,
    },
  };
}

export function parseWorkerLaunchDescriptor(value: unknown): WorkerLaunchDescriptor {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["version", "connectionEndpoint", "admission", "assignment"]) ||
    value.version !== LAUNCH_VERSION
  ) {
    throw new Error("invalid worker launch descriptor");
  }
  const connectionEndpoint = parseWorkerConnectionEndpoint(value.connectionEndpoint);
  const assignment = parseAssignment(value.assignment);
  if (!connectionEndpoint || !assignment || !isRecord(value.admission)) {
    throw new Error("invalid worker launch descriptor");
  }
  const candidate: WorkerLaunchDescriptor = {
    version: LAUNCH_VERSION,
    connectionEndpoint,
    admission: value.admission as WorkerLaunchAdmission,
    assignment,
  };
  const frame: WorkerConnectRequestFrame = {
    type: "req",
    id: "launch-validation",
    method: "connect",
    params: buildWorkerConnectParams(candidate),
  };
  if (
    !Value.Check(WorkerConnectRequestFrameSchema, frame) ||
    candidate.admission.sessionId === null ||
    candidate.admission.ownerEpoch < 1 ||
    !isWorkerTranscriptMessageFrameSafe({
      role: "user",
      content: [{ type: "text", text: candidate.assignment.prompt }],
      timestamp: Number.MAX_SAFE_INTEGER,
    })
  ) {
    throw new Error("invalid worker launch descriptor");
  }
  return candidate;
}
