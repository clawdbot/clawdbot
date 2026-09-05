import { clearCurrentProviderAuthState } from "../agents/model-provider-auth.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isSecretRef } from "../config/types.secrets.js";
import { requestActiveCronJobCancellationByPayloadKind } from "../cron/active-jobs.js";
import { resolveSkillWorkshopConfig } from "../skills/workshop/config.js";
import { isRecord } from "../utils.js";
import type { ChannelKind } from "./config-reload-plan.js";
import { reloadPlanNeedsRecovery } from "./config-reload-recovery.js";
import type { GatewayReloadPlan } from "./config-reload.js";
import { GatewayReloadRequiresRecoveryOwnerError } from "./server-reload-contracts.js";

function projectCanonicalSecretRefsOntoRuntime(
  sourceValue: unknown,
  runtimeValue: unknown,
): unknown {
  if (isSecretRef(sourceValue)) {
    return sourceValue;
  }
  if (Array.isArray(sourceValue)) {
    const runtimeArray = Array.isArray(runtimeValue) ? runtimeValue : [];
    return sourceValue.map((entry, index) =>
      projectCanonicalSecretRefsOntoRuntime(entry, runtimeArray[index]),
    );
  }
  if (isRecord(sourceValue)) {
    const runtimeRecord = isRecord(runtimeValue) ? runtimeValue : {};
    const projected: Record<string, unknown> = { ...runtimeRecord };
    for (const [key, entry] of Object.entries(sourceValue)) {
      projected[key] = projectCanonicalSecretRefsOntoRuntime(entry, runtimeRecord[key]);
    }
    return projected;
  }
  return runtimeValue === undefined ? sourceValue : runtimeValue;
}

export function restoreCanonicalSecretRefs(
  runtimeConfig: OpenClawConfig,
  sourceConfig: OpenClawConfig,
): OpenClawConfig {
  return projectCanonicalSecretRefsOntoRuntime(sourceConfig, runtimeConfig) as OpenClawConfig;
}

export function resetPreparedModelRuntimeStateForHotReload(): void {
  clearCurrentProviderAuthState();
}

export function revokeActiveSkillReviewsBeforeConfigPublication(config: OpenClawConfig): void {
  if (resolveSkillWorkshopConfig(config).autonomous.mode === "auto") {
    return;
  }
  // Durable cron convergence may wait on its serialized tail. Abort active reviews
  // at the commit edge so the new mode never publishes with stale write authority.
  requestActiveCronJobCancellationByPayloadKind(
    "skillCollectionReview",
    "Skill collection review disabled by configuration.",
  );
}

export function assertIrreversibleReloadPlanHasRecoveryOwner(
  plan: GatewayReloadPlan,
  restartRecoveryAvailable: boolean | undefined,
): void {
  if (restartRecoveryAvailable !== false) {
    return;
  }
  if (plan.restartGateway) {
    throw new GatewayReloadRequiresRecoveryOwnerError("gateway restart");
  }
  // These plans retire a live service or plugin generation before replacement
  // can be proven. Context cache refresh also needs recovery because it can
  // reject after runtime publication; simple in-place updates stay atomic.
  if (reloadPlanNeedsRecovery(plan)) {
    throw new GatewayReloadRequiresRecoveryOwnerError("irreversible hot reload");
  }
}

export async function disposeMcpRuntimesWithTimeout(params: {
  dispose: () => Promise<void>;
  timeoutMs: number;
  onWarn: (message: string) => void;
  label: string;
}) {
  // MCP runtime disposal may need async provider cleanup. Bound it so config
  // reload can proceed and report the stale runtime risk.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const disposePromise = Promise.resolve()
    .then(params.dispose)
    .catch((error: unknown) => {
      params.onWarn(`${params.label} failed: ${String(error)}`);
    });
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), params.timeoutMs);
    timer.unref?.();
  });
  const result = await Promise.race([disposePromise.then(() => "done" as const), timeoutPromise]);
  if (timer) {
    clearTimeout(timer);
  }
  if (result === "timeout") {
    params.onWarn(`${params.label} exceeded ${params.timeoutMs}ms; continuing`);
  }
}

export async function collectChannelOperationFailures(params: {
  channels: Iterable<ChannelKind>;
  run: (channel: ChannelKind) => Promise<void>;
  onFailure: (channel: ChannelKind, err: unknown) => void;
}): Promise<ChannelKind[]> {
  const failures: ChannelKind[] = [];
  for (const channel of params.channels) {
    try {
      await params.run(channel);
    } catch (err) {
      failures.push(channel);
      params.onFailure(channel, err);
    }
  }
  return failures;
}
