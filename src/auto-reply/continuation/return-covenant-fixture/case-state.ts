import { performance } from "node:perf_hooks";
import { stableStringify } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PendingContinuationDelegate } from "../types.js";
import type {
  PreparedReturnCovenantDatabaseProfiles,
  ReturnCovenantDatabaseReceipt,
  ReturnCovenantProfileActivation,
} from "./database.js";
import type {
  ReturnCovenantGatewayBinding,
  ReturnCovenantGatewayRestart,
} from "./gateway-generation.js";
import {
  ReturnCovenantProtocolError,
  sha256ReturnCovenant,
  type ReturnCovenantCasePlan,
  type ReturnCovenantEffects,
  type ReturnCovenantForm,
  type ReturnCovenantPhaseRequest,
  type ReturnCovenantPlan,
} from "./protocol.js";

export type ReturnCovenantClock = {
  monotonicNow(): number;
  wallNow(): number;
};

export const systemReturnCovenantClock: ReturnCovenantClock = {
  monotonicNow: () => performance.now(),
  wallNow: () => Date.now(),
};

export type ReturnCovenantAcceptanceReceipt = {
  caseHandle: string;
  prepareReceiptId: string;
  accepted: true;
  completionHeld: true;
  receiptId: string;
  heldResultId: string;
  capturedAuthorityGeneration: string;
  resultMarker: string;
  originEvidence: {
    source: "product-owned";
    observedForm: ReturnCovenantForm;
    receiptId: string;
    typedToolExecutions: number;
    bracketParses: number;
    rawFinalText: boolean;
  };
};

export type ReturnCovenantLifecycleReceipt = {
  edge: ReturnCovenantCasePlan["lifecycleEdge"];
  occurredAfterAcceptance: true;
  completedBeforeRelease: true;
  preSessionId: string | null;
  postSessionId: string;
  successorIdentity: string;
  receiptId: string;
  acceptedDispatchReceiptId: string;
  generationAdvanced: boolean;
  effectiveAuthorityUnchanged: boolean;
  operations?: {
    deletionObserved: true;
    deletionReceiptId: string;
    recreationObserved: true;
    recreationReceiptId: string;
  };
  restart?: {
    stoppedAfterAcceptance: true;
    restartedBeforeRelease: true;
    replayRecovered: true;
    receiptId: string;
    originalGatewayPid: number;
    originalGatewayStartFingerprint: string;
    replacementGatewayPid: number;
    replacementGatewayStartFingerprint: string;
    gatewayCommandSha256: string;
    runtimeConfigSha256: string;
    processGroupId: number;
    replacementGatewayEndpoint: string;
  };
};

export type ReturnCovenantReleaseReceipt = {
  caseHandle: string;
  released: true;
  receiptId: string;
  transitionReceiptId: string;
  acceptedDispatchReceiptId: string;
  heldResultId: string;
  resultMarker: string;
  capturedAuthorityGeneration: string;
};

export type ReturnCovenantCaseState = {
  acceptance?: ReturnCovenantAcceptanceReceipt;
  caseHandle: string;
  casePlan: ReturnCovenantCasePlan;
  childSessionKey?: string;
  closed: boolean;
  database: ReturnCovenantDatabaseReceipt;
  delegate?: PendingContinuationDelegate;
  deliveryId?: string;
  form: ReturnCovenantForm;
  gatewayPhases: Partial<
    Record<
      "prepare" | "dispatch" | "transition" | "release" | "observe" | "cleanup",
      ReturnCovenantGatewayBinding
    >
  >;
  lifecycle?: ReturnCovenantLifecycleReceipt;
  observation?: Record<string, unknown>;
  observationFaultApplied?: boolean;
  phase: "prepared" | "dispatched" | "transitioned" | "released" | "observed";
  postSessionId: string;
  preSessionId: string | null;
  release?: ReturnCovenantReleaseReceipt;
  releasedAtMonotonic?: number;
  releasedAtWall?: number;
  request: Extract<ReturnCovenantPhaseRequest, { phase: "prepare" }>;
  resultMarker: string;
  resultText: string;
  startedAt: string;
  wakeCount: number;
};

export type ReturnCovenantRunCleanupReceipt = {
  completed: true;
  receiptId: string;
  observationSetSha256: string;
  phaseChainSha256: string;
  driverAttestationSha256: string;
  runtimeConfigSha256: string;
  runtimeArtifactManifestSha256: string;
};

export type ReturnCovenantFixtureContext = {
  clock: ReturnCovenantClock;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  faults?: ReturnCovenantFixtureFaults;
  plan: ReturnCovenantPlan;
  profiles: PreparedReturnCovenantDatabaseProfiles;
};

export type ReturnCovenantFixtureFaults = {
  afterProfileActivated?: (activation: ReturnCovenantProfileActivation) => Promise<void> | void;
  beforeObserve?: (params: {
    context: ReturnCovenantFixtureContext;
    state: ReturnCovenantCaseState;
  }) => Promise<void> | void;
};

export type ReturnCovenantGatewayInvocation = {
  gateway: ReturnCovenantGatewayBinding;
  restart?: ReturnCovenantGatewayRestart;
};

export const returnCovenantOwnerA = {
  type: "human" as const,
  id: "return-covenant-owner-a",
};
export const returnCovenantOwnerB = {
  type: "human" as const,
  id: "return-covenant-owner-b",
};

export function returnCovenantExecutionKey(caseId: string, form: ReturnCovenantForm): string {
  return `${caseId}:${form}`;
}

export function returnCovenantReceiptId(prefix: string, values: unknown): string {
  return `${prefix}-${sha256ReturnCovenant(stableStringify(values)).slice(0, 32)}`;
}

export function requireReturnCovenantCasePhase(
  state: ReturnCovenantCaseState,
  phase: ReturnCovenantCaseState["phase"],
): void {
  if (state.phase !== phase || state.closed) {
    throw new ReturnCovenantProtocolError(
      "phase-order",
      `case ${state.casePlan.id}/${state.form} is ${state.phase}, expected ${phase}`,
      409,
    );
  }
}

export function returnCovenantCurrentSessionId(state: ReturnCovenantCaseState): string {
  return state.lifecycle?.postSessionId ?? state.preSessionId ?? state.postSessionId;
}

export function returnCovenantObservedEffects(
  state: ReturnCovenantCaseState,
  promptAdoptions: number,
  channelDeliveries: number,
): ReturnCovenantEffects {
  return {
    promptAdoptions,
    wakes: state.wakeCount,
    channelDeliveries,
  };
}
