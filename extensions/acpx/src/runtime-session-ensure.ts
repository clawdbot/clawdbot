import {
  AcpxRuntime as BaseAcpxRuntime,
  isRequestedModelUnsupportedError,
  type SessionAgentOptions,
} from "acpx/runtime";
import { AcpRuntimeError, type AcpRuntime, type AcpRuntimeHandle } from "../runtime-api.js";

type RuntimeEnsureInput = Parameters<AcpRuntime["ensureSession"]>[0];
type DelegateEnsureInput = Parameters<BaseAcpxRuntime["ensureSession"]>[0];

const SESSION_ID_NOT_FOUND_PATTERN = /(?:session|thread)\s+["'\w-]+\s+not found/i;
const RESOURCE_NOT_FOUND_SESSION_PATTERN =
  /resource[_ ]not[_ ]found\s*[:(-]?\s*(?:session|thread)\b/i;

function isMissingResumeTargetText(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.toLowerCase();
  return (
    RESOURCE_NOT_FOUND_SESSION_PATTERN.test(value) ||
    normalized.includes("session not found") ||
    normalized.includes("thread not found") ||
    normalized.includes("unknown session") ||
    normalized.includes("unknown thread") ||
    normalized.includes("invalid session identifier") ||
    normalized.includes("no rollout found for thread id") ||
    SESSION_ID_NOT_FOUND_PATTERN.test(value)
  );
}

function hasMissingResumeTargetHint(value: unknown, depth = 0): boolean {
  if (depth > 5) {
    return false;
  }
  if (isMissingResumeTargetText(value)) {
    return true;
  }
  if (value instanceof Error && isMissingResumeTargetText(value.message)) {
    return true;
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  return Object.values(value).some((entry) => hasMissingResumeTargetHint(entry, depth + 1));
}

export async function withResumeEnsureErrorNormalization<T>(params: {
  input: RuntimeEnsureInput;
  run: () => Promise<T>;
}): Promise<T> {
  try {
    return await params.run();
  } catch (error) {
    if (!params.input.resumeSessionId?.trim() || !hasMissingResumeTargetHint(error)) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : "resume target not found";
    throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", detail, {
      cause: error,
      detailCode: "SESSION_RESUME_REQUIRED",
    });
  }
}

export function prepareResumeSafeSessionInput(params: {
  input: RuntimeEnsureInput;
  markFresh: (sessionKey: string) => void;
}): RuntimeEnsureInput {
  const { input } = params;
  if (input.mode !== "oneshot" || !input.resumeSessionId?.trim()) {
    return input;
  }
  // ACPX permits a one-shot reconnect to create a fresh backend session. Keep an explicitly
  // resumed follow-up connected until OpenClaw closes it after the turn instead.
  params.markFresh(input.sessionKey);
  return { ...input, mode: "persistent" };
}

export function withAcpxSessionOptions(input: RuntimeEnsureInput): DelegateEnsureInput {
  const existingOptions = (input as { sessionOptions?: SessionAgentOptions }).sessionOptions;
  const model = input.model?.trim() || existingOptions?.model;
  const sessionOptions = model ? { ...existingOptions, model } : existingOptions;
  return {
    ...input,
    ...(sessionOptions ? { sessionOptions } : {}),
  } as DelegateEnsureInput;
}

// ACPX owns the distinction between missing model capability and an invalid model id.
// Retry only the former so explicit model mistakes remain visible to the caller.
export async function ensureDelegateSessionWithModelFallback(
  delegate: BaseAcpxRuntime,
  input: RuntimeEnsureInput,
): Promise<AcpRuntimeHandle> {
  try {
    return await delegate.ensureSession(withAcpxSessionOptions(input));
  } catch (error) {
    const capabilityMissing =
      isRequestedModelUnsupportedError(error) && error.reason === "missing-capability";
    if (!input.model || !capabilityMissing) {
      throw error;
    }
    return await delegate.ensureSession(withAcpxSessionOptions({ ...input, model: undefined }));
  }
}

export function withSessionResumeCapability<T extends object>(
  handle: T,
  record: unknown,
): T & { sessionResumeSupported?: boolean } {
  const agentCapabilities =
    typeof record === "object" && record !== null
      ? (record as { agentCapabilities?: unknown }).agentCapabilities
      : undefined;
  if (typeof agentCapabilities !== "object" || agentCapabilities === null) {
    return handle;
  }
  const capabilities = agentCapabilities as {
    loadSession?: unknown;
    sessionCapabilities?: { resume?: unknown } | null;
  };
  const resumeCapability = capabilities.sessionCapabilities?.resume;
  return {
    ...handle,
    sessionResumeSupported:
      capabilities.loadSession === true ||
      resumeCapability === true ||
      (typeof resumeCapability === "object" && resumeCapability !== null),
  };
}
