import { getPluginToolMeta } from "../plugins/tools.js";
import { getChannelAgentToolMeta } from "./channel-tool-metadata.js";
import type { FileTarget } from "./tool-mutation.js";
import {
  buildToolFileTarget,
  buildToolInputFileTargets,
  buildToolMutationState,
  buildToolResultFileTargets,
  isSameFileTarget,
  mergeFileTargets,
} from "./tool-mutation.js";
import { isFileTargetNotFoundToolFailure, isToolResultError } from "./tool-result-error.js";
import type {
  CatalogSource,
  ToolSearchCatalogEntry,
  ToolSearchCatalogSession,
} from "./tool-search-types.js";

export type ToolSearchExecutionObservation = {
  sideEffectFree: boolean;
  fileTarget?: FileTarget;
  mutationFallbackFileTargets?: FileTarget[];
  mutationStarted?: boolean;
  observedMutationCompletionVersion?: number;
};

type MutationTargetState = {
  target: FileTarget;
  inFlight: number;
  completionVersion: number;
};

function buildTrackableToolMutationState(
  entry: ToolSearchCatalogEntry,
  input: unknown,
): ReturnType<typeof buildToolMutationState> | undefined {
  if (
    entry.source !== "openclaw" ||
    getPluginToolMeta(entry.tool as Parameters<typeof getPluginToolMeta>[0]) ||
    getChannelAgentToolMeta(entry.tool as never)
  ) {
    return undefined;
  }
  return buildToolMutationState(entry.name, input);
}

export function isSideEffectFreeToolSearchCall(
  entry: ToolSearchCatalogEntry,
  input: unknown,
): boolean {
  const mutation = buildTrackableToolMutationState(entry, input);
  if (!mutation) {
    return false;
  }
  return mutation.replaySafe && !mutation.mutatingAction;
}

export class ToolSearchMutationTelemetry {
  private lastCallSideEffectFree: boolean | undefined;
  private hadTargetlessSideEffects = false;
  private readonly mutationTargetStates: MutationTargetState[] = [];
  private readonly successfulObservationFileTargets: FileTarget[] = [];
  private readonly successfulAbsenceObservationFileTargets: FileTarget[] = [];
  private readonly unverifiedMutationFileTargets: FileTarget[] = [];

  constructor(private readonly cwd?: string) {}

  private isSameFileTarget(a: FileTarget, b: FileTarget): boolean {
    return isSameFileTarget(a, b, process.platform, this.cwd);
  }

  private resolveMutationTargetState(target: FileTarget): MutationTargetState {
    const existing = this.mutationTargetStates.find((state) =>
      this.isSameFileTarget(state.target, target),
    );
    if (existing) {
      existing.target = target;
      return existing;
    }
    const created = { target, inFlight: 0, completionVersion: 0 };
    this.mutationTargetStates.push(created);
    return created;
  }

  private completeMutation(target: FileTarget, started: boolean): void {
    const state = this.resolveMutationTargetState(target);
    if (started) {
      state.inFlight = Math.max(0, state.inFlight - 1);
    }
    state.completionVersion += 1;
    const pendingIndex = this.unverifiedMutationFileTargets.findIndex((candidate) =>
      this.isSameFileTarget(candidate, target),
    );
    if (pendingIndex >= 0) {
      this.unverifiedMutationFileTargets[pendingIndex] = target;
    } else {
      this.unverifiedMutationFileTargets.push(target);
    }
  }

  private completeAuthoritativeAbsence(target: FileTarget): void {
    const state = this.resolveMutationTargetState(target);
    state.completionVersion += 1;
    for (let index = this.unverifiedMutationFileTargets.length - 1; index >= 0; index -= 1) {
      if (this.isSameFileTarget(this.unverifiedMutationFileTargets[index]!, target)) {
        this.unverifiedMutationFileTargets.splice(index, 1);
      }
    }
    const observation: FileTarget = {
      ...(target.path !== undefined ? { path: target.path } : {}),
      ...(target.oldpath !== undefined ? { oldpath: target.oldpath } : {}),
    };
    if (
      !this.successfulAbsenceObservationFileTargets.some((candidate) =>
        this.isSameFileTarget(candidate, observation),
      )
    ) {
      this.successfulAbsenceObservationFileTargets.push(observation);
    }
  }

  private recordObservation(
    observation: ToolSearchExecutionObservation,
    expected: "present" | "absent",
  ): void {
    if (!observation.sideEffectFree || !observation.fileTarget) {
      return;
    }
    const observations =
      expected === "absent"
        ? this.successfulAbsenceObservationFileTargets
        : this.successfulObservationFileTargets;
    if (!observations.some((target) => this.isSameFileTarget(target, observation.fileTarget!))) {
      observations.push(observation.fileTarget);
    }
    const verifiedIndex = this.unverifiedMutationFileTargets.findIndex((target) => {
      const targetExpectation = target.expected ?? "present";
      return (
        this.isSameFileTarget(target, observation.fileTarget!) &&
        (targetExpectation === expected || targetExpectation === "unknown")
      );
    });
    const mutationState = this.resolveMutationTargetState(observation.fileTarget);
    if (
      verifiedIndex >= 0 &&
      mutationState.inFlight === 0 &&
      mutationState.completionVersion === observation.observedMutationCompletionVersion
    ) {
      this.unverifiedMutationFileTargets.splice(verifiedIndex, 1);
    }
  }

  private recordTargetlessSideEffect(
    observation: ToolSearchExecutionObservation,
    resultFileTargets?: readonly FileTarget[],
  ): void {
    if (observation.sideEffectFree) {
      return;
    }
    const trackedTargets = mergeFileTargets(
      observation.fileTarget ? [observation.fileTarget] : undefined,
      observation.mutationFallbackFileTargets,
      resultFileTargets,
    );
    if (!trackedTargets || trackedTargets.length === 0) {
      this.hadTargetlessSideEffects = true;
    }
  }

  recordExecution(
    catalog: ToolSearchCatalogSession,
    entry: ToolSearchCatalogEntry,
    input: unknown,
  ): ToolSearchExecutionObservation {
    const mutation = buildTrackableToolMutationState(entry, input);
    const sideEffectFree = mutation?.replaySafe === true && !mutation.mutatingAction;
    const fileTarget = mutation ? buildToolFileTarget(entry.name, input) : undefined;
    const mutationFallbackFileTargets =
      mutation?.mutatingAction === true
        ? buildToolInputFileTargets(entry.name, input, this.cwd)
        : undefined;
    (catalog.callSequence ??= []).push(entry.name);
    (catalog.callSideEffectFreeSequence ??= []).push(sideEffectFree);
    this.lastCallSideEffectFree = sideEffectFree;
    const mutationStarted = mutation?.mutatingAction === true && fileTarget !== undefined;
    if (mutationStarted) {
      this.resolveMutationTargetState(fileTarget).inFlight += 1;
    }
    const observedMutationCompletionVersion =
      sideEffectFree && fileTarget
        ? this.resolveMutationTargetState(fileTarget).completionVersion
        : undefined;
    return {
      sideEffectFree,
      ...(fileTarget ? { fileTarget } : {}),
      ...(mutationFallbackFileTargets ? { mutationFallbackFileTargets } : {}),
      ...(mutationStarted ? { mutationStarted: true } : {}),
      ...(observedMutationCompletionVersion !== undefined
        ? { observedMutationCompletionVersion }
        : {}),
    };
  }

  acceptResult(
    catalog: ToolSearchCatalogSession,
    entry: ToolSearchCatalogEntry,
    observation: ToolSearchExecutionObservation,
    result: unknown,
  ): void {
    const resultIsError = isToolResultError(result);
    const resultFileTargets = buildTrackableToolMutationState(entry, {})?.mutatingAction
      ? buildToolResultFileTargets(entry.name, result, { includeDeleted: true })
      : undefined;
    this.recordTargetlessSideEffect(observation, resultFileTargets);
    if (resultIsError) {
      catalog.callFailureCount = (catalog.callFailureCount ?? 0) + 1;
      if (observation.mutationStarted && observation.fileTarget) {
        this.completeMutation({ ...observation.fileTarget, expected: "unknown" }, true);
      }
      for (const target of mergeFileTargets(
        resultFileTargets,
        observation.mutationFallbackFileTargets,
      ) ?? []) {
        this.completeMutation({ ...target, expected: "unknown" }, false);
      }
      if (
        observation.fileTarget &&
        isFileTargetNotFoundToolFailure(result, observation.fileTarget, this.cwd)
      ) {
        this.recordObservation(observation, "absent");
      }
      return;
    }
    if (observation.mutationStarted && observation.fileTarget) {
      this.completeMutation(observation.fileTarget, true);
    }
    if (resultFileTargets !== undefined) {
      for (const target of resultFileTargets) {
        if (target.expected === "absent") {
          // A successful patch delete is authoritative for both this runtime
          // and the outer Code Mode continuation.
          this.completeAuthoritativeAbsence(target);
        } else {
          this.completeMutation(target, false);
        }
      }
    }
    this.recordObservation(observation, "present");
  }

  recordFailure(
    catalog: ToolSearchCatalogSession,
    observation?: ToolSearchExecutionObservation,
    error?: unknown,
  ): void {
    catalog.callFailureCount = (catalog.callFailureCount ?? 0) + 1;
    if (observation) {
      this.recordTargetlessSideEffect(observation);
    }
    if (observation?.mutationStarted && observation.fileTarget) {
      this.completeMutation({ ...observation.fileTarget, expected: "unknown" }, true);
    }
    for (const target of observation?.mutationFallbackFileTargets ?? []) {
      this.completeMutation({ ...target, expected: "unknown" }, false);
    }
    if (
      observation?.fileTarget &&
      isFileTargetNotFoundToolFailure(error, observation.fileTarget, this.cwd)
    ) {
      this.recordObservation(observation, "absent");
    }
  }

  snapshot() {
    return {
      lastCallSideEffectFree: this.lastCallSideEffectFree,
      hadTargetlessSideEffects: this.hadTargetlessSideEffects,
      successfulObservationFileTargets: this.successfulObservationFileTargets,
      successfulAbsenceObservationFileTargets: this.successfulAbsenceObservationFileTargets,
      unverifiedMutationFileTargets: this.unverifiedMutationFileTargets,
    };
  }
}

export function buildToolSearchTelemetry(
  catalog: ToolSearchCatalogSession,
  runtime: {
    lastCallSideEffectFree: boolean | undefined;
    hadTargetlessSideEffects: boolean;
    successfulObservationFileTargets: readonly FileTarget[];
    successfulAbsenceObservationFileTargets: readonly FileTarget[];
    unverifiedMutationFileTargets: readonly FileTarget[];
  },
) {
  const sources: Record<CatalogSource, number> = { openclaw: 0, mcp: 0, client: 0 };
  for (const entry of catalog.entries) {
    sources[entry.source] += 1;
  }
  return {
    catalogSize: catalog.entries.length,
    sources,
    searchCount: catalog.searchCount,
    describeCount: catalog.describeCount,
    callCount: catalog.callCount,
    failures: catalog.callFailureCount ?? 0,
    ...(catalog.callSequence ? { callSequence: [...catalog.callSequence] } : {}),
    ...(catalog.callSideEffectFreeSequence
      ? { callSideEffectFreeSequence: [...catalog.callSideEffectFreeSequence] }
      : {}),
    ...(typeof runtime.lastCallSideEffectFree === "boolean"
      ? { lastCallSideEffectFree: runtime.lastCallSideEffectFree }
      : {}),
    hadTargetlessSideEffects: runtime.hadTargetlessSideEffects,
    successfulObservationFileTargets: [...runtime.successfulObservationFileTargets],
    successfulAbsenceObservationFileTargets: [...runtime.successfulAbsenceObservationFileTargets],
    unverifiedMutationFileTargets: [...runtime.unverifiedMutationFileTargets],
  };
}
