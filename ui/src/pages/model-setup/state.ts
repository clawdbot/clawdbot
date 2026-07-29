import type {
  SystemAgentSetupActivateResult,
  SystemAgentSetupDetectResult,
  SystemAgentSetupVerifyResult,
  WizardNextResult,
  WizardStep,
} from "../../api/types.ts";

export const MODEL_SETUP_DETECT_TIMEOUT_MS = 20_000;
export const MODEL_SETUP_VERIFY_TIMEOUT_MS = 30_000;
const MODEL_SETUP_ACTIVATE_TIMEOUT_MS = 150_000;
const MODEL_SETUP_CODEX_ACTIVATE_TIMEOUT_MS = 480_000;
export const MODEL_SETUP_AUTH_START_TIMEOUT_MS = 30_000;
export const MODEL_SETUP_WIZARD_NEXT_TIMEOUT_MS = null;

export type ModelSetupPageState =
  | { phase: "loading" }
  | { phase: "ready"; result: SystemAgentSetupDetectResult }
  | { phase: "detect-error"; message: string };

export type ModelSetupActivationState =
  | { phase: "idle" }
  | { phase: "testing"; targetId: string; modelRef: string }
  | {
      phase: "failure";
      targetId: string;
      status: Exclude<NonNullable<SystemAgentSetupActivateResult["status"]>, "ok">;
      error: string;
    }
  | { phase: "success"; modelRef: string; latencyMs?: number };

type ModelSetupVerifyFailure = Extract<SystemAgentSetupVerifyResult, { ok: false }>;

export type ModelSetupVerifyState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "ok"; modelRef: string; latencyMs?: number }
  | { phase: "failed"; status: ModelSetupVerifyFailure["status"]; error: string };

export type ModelSetupWizardState =
  | { phase: "idle" }
  | { phase: "starting"; authChoice: string }
  | {
      phase: "step";
      authChoice: string;
      step: WizardStep;
      busy: boolean;
      validationError: string | null;
    }
  | { phase: "done"; authChoice: string }
  | { phase: "cancelled"; message: string }
  | { phase: "error"; message: string };

export function activationTimeoutForKind(kind: string): number {
  return kind === "codex-cli"
    ? MODEL_SETUP_CODEX_ACTIVATE_TIMEOUT_MS
    : MODEL_SETUP_ACTIVATE_TIMEOUT_MS;
}

export function activationTargetId(kind: string, modelRef: string): string {
  return `${kind}\u0000${modelRef}`;
}

export function mapActivationResult(params: {
  result: SystemAgentSetupActivateResult;
  targetId: string;
  fallbackError: string;
}): ModelSetupActivationState {
  const { result } = params;
  if (result.ok && result.modelRef) {
    return {
      phase: "success",
      modelRef: result.modelRef,
      ...(typeof result.latencyMs === "number" ? { latencyMs: result.latencyMs } : {}),
    };
  }
  return {
    phase: "failure",
    targetId: params.targetId,
    status: result.status && result.status !== "ok" ? result.status : "unknown",
    error: result.error?.trim() || params.fallbackError,
  };
}

export function mapVerifyResult(result: SystemAgentSetupVerifyResult): ModelSetupVerifyState {
  if (result.ok) {
    return {
      phase: "ok",
      modelRef: result.modelRef,
      ...(typeof result.latencyMs === "number" ? { latencyMs: result.latencyMs } : {}),
    };
  }
  return { phase: "failed", status: result.status, error: result.error };
}

export function wizardStateFromResult(
  authChoice: string,
  result: WizardNextResult,
  fallbackError: string,
): ModelSetupWizardState {
  if (!result.done && result.step) {
    return {
      phase: "step",
      authChoice,
      step: result.step,
      busy: false,
      validationError: result.error?.trim() || null,
    };
  }
  if (result.status === "done") {
    return { phase: "done", authChoice };
  }
  if (result.status === "cancelled") {
    return { phase: "cancelled", message: result.error?.trim() || fallbackError };
  }
  return { phase: "error", message: result.error?.trim() || fallbackError };
}

export function initialWizardValue(step: WizardStep): unknown {
  if (step.type === "multiselect") {
    return Array.isArray(step.initialValue) ? [...step.initialValue] : [];
  }
  return step.initialValue;
}
