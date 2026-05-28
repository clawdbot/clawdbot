import type { OpenClawConfig } from "../../../config/config.js";
import {
  resolveSessionLockMaxHoldFromTimeout,
  resolveSessionWriteLockOptions,
} from "../../session-write-lock.js";
import { UNKNOWN_TOOL_THRESHOLD } from "../../tool-loop-detection.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

export function resolveEmbeddedAttemptSessionWriteLockOptions(params: {
  config?: OpenClawConfig;
  compactionTimeoutMs: number;
  env?: NodeJS.ProcessEnv;
}): { timeoutMs: number; staleMs: number; maxHoldMs: number } {
  // Bound embedded-attempt lock holds to the compaction window, not the full run timeout.
  // With defaults this permits roughly 900s compaction time plus the shared 120s
  // timeout grace before the watchdog releases a stuck live-process lock.
  return resolveSessionWriteLockOptions(params.config, {
    env: params.env,
    maxHoldMsFallback: resolveSessionLockMaxHoldFromTimeout({
      timeoutMs: params.compactionTimeoutMs,
    }),
  });
}

export function resolveAttemptStreamAuthProfileId(
  params: Pick<EmbeddedRunAttemptParams, "authProfileId" | "runtimePlan">,
): string | undefined {
  return params.runtimePlan?.auth.forwardedAuthProfileId;
}

export function resolveUnknownToolGuardThreshold(loopDetection?: {
  enabled?: boolean;
  unknownToolThreshold?: number;
}): number {
  // The unknown-tool guard is a safety net against the model hallucinating a
  // tool name or calling a tool that has since been removed from the allowlist
  // (for example after a `skills.allowBundled` config change). After `threshold`
  // consecutive unknown-tool attempts the stream wrapper rewrites the assistant
  // message content to tell the model to stop, which breaks otherwise-infinite
  // Tool-not-found loops against the provider. Unlike the genericRepeat /
  // pingPong / pollNoProgress detectors this guard has no false-positive
  // surface because the tool is objectively not registered in this run, so it
  // stays on regardless of `tools.loopDetection.enabled`.
  const raw = loopDetection?.unknownToolThreshold;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return UNKNOWN_TOOL_THRESHOLD;
}

export function shouldRunLlmOutputHooksForAttempt(params: { promptErrorSource: string | null }) {
  return params.promptErrorSource !== "hook:before_agent_run";
}

export function resolveAttemptToolPolicyMessageProvider(params: {
  messageProvider?: string;
  messageChannel?: string;
}): string | undefined {
  return params.messageProvider ?? params.messageChannel;
}
