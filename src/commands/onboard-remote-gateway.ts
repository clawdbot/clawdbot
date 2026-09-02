// Remote-Gateway onboarding adapters keep inference detection and activation on the Gateway host.
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
  SystemAgentChatResult,
  SystemAgentSetupActivateResult,
  SystemAgentSetupDetectResult,
  SystemAgentSetupVerifyResult,
} from "../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isGatewayClientRequestError,
  isGatewayTransportError,
  resolveDeviceIdentityForGatewayCall,
  type CallGatewayCliOptions,
} from "../gateway/call.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import type {
  ActivateSetupInferenceParams,
  ActivateSetupInferenceResult,
  SetupInferenceDetection,
  SetupInferenceFailureStatus,
} from "../system-agent/setup-inference.js";
import { t } from "../wizard/i18n/index.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import type { GuidedOnboardingDeps } from "./onboard-guided.js";

const GATEWAY_SETUP_DETECT_TIMEOUT_MS = 40_000;
const GATEWAY_SETUP_ACTIVATE_TIMEOUT_MS = 150_000;
const GATEWAY_CODEX_SETUP_ACTIVATE_TIMEOUT_MS = 480_000;
const GATEWAY_SETUP_VERIFY_TIMEOUT_MS = 30_000;
const GATEWAY_SYSTEM_AGENT_CHAT_TIMEOUT_MS = 190_000;
const GATEWAY_RESTART_WAIT_TIMEOUT_MS = 45_000;
const GATEWAY_RESTART_IDENTITY_ERROR =
  "Inference settings were saved, but the Gateway did not provide a boot identity. Update and restart the remote Gateway, then run onboarding again.";

type CallGateway = <T>(options: CallGatewayCliOptions) => Promise<T>;

type RemoteGatewayInferenceTarget = {
  config: OpenClawConfig;
  gatewayUrl: string;
  token?: string;
  password?: string;
  tlsFingerprint?: string;
};

type RemoteGatewayInferenceOnboardingDeps = {
  callGateway?: CallGateway;
  createPrompter?: GuidedOnboardingDeps["createPrompter"];
  runTui?: typeof import("../tui/tui.js").runTui;
  runGuidedOnboarding?: typeof import("./onboard-guided.js").runGuidedOnboarding;
};

function toSetupInferenceDetection(result: SystemAgentSetupDetectResult): SetupInferenceDetection {
  return {
    candidates: result.candidates.map((candidate) => ({
      kind: candidate.kind,
      ...(candidate.brandId !== undefined ? { brandId: candidate.brandId } : {}),
      label: candidate.label,
      detail: candidate.detail,
      modelRef: candidate.modelRef,
      ...(candidate.icon !== undefined ? { icon: candidate.icon } : {}),
      ...(candidate.website !== undefined ? { website: candidate.website } : {}),
      // Gateway ordering is authoritative; the guided candidate shape no
      // longer permits a second client-side recommendation signal.
      recommended: false,
      ...(candidate.credentials !== undefined ? { credentials: candidate.credentials } : {}),
    })),
    manualProviders: result.manualProviders.map((provider) => ({
      id: provider.id,
      ...(provider.brandId !== undefined ? { brandId: provider.brandId } : {}),
      label: provider.label,
      ...(provider.hint !== undefined ? { hint: provider.hint } : {}),
      ...(provider.icon !== undefined ? { icon: provider.icon } : {}),
      ...(provider.website !== undefined ? { website: provider.website } : {}),
    })),
    authOptions: (result.authOptions ?? []).map((option) =>
      Object.assign(
        {
          id: option.id,
          ...(option.brandId !== undefined ? { brandId: option.brandId } : {}),
          label: option.label,
          kind: option.kind,
          featured: option.featured,
        },
        option.hint !== undefined ? { hint: option.hint } : {},
        option.groupLabel !== undefined ? { groupLabel: option.groupLabel } : {},
        option.icon !== undefined ? { icon: option.icon } : {},
        option.website !== undefined ? { website: option.website } : {},
      ),
    ),
    prepareOptions: (result.prepareOptions ?? []).map((option) =>
      Object.assign(
        {
          id: option.id,
          label: option.label,
        },
        option.brandId !== undefined ? { brandId: option.brandId } : {},
        option.hint !== undefined ? { hint: option.hint } : {},
        option.icon !== undefined ? { icon: option.icon } : {},
        option.website !== undefined ? { website: option.website } : {},
      ),
    ),
    recommendedInstalls: result.recommendedInstalls ?? [],
    unavailableCandidates: (result.unavailableCandidates ?? []).map((candidate) => ({
      id: candidate.id,
      label: candidate.label,
      detail: candidate.detail,
      reason: candidate.reason,
    })),
    workspace: result.workspace,
    ...(result.configuredModel !== undefined ? { configuredModel: result.configuredModel } : {}),
    setupComplete: result.setupComplete,
  };
}

function isSetupInferenceFailureStatus(value: unknown): value is SetupInferenceFailureStatus {
  return (
    value === "auth" ||
    value === "rate_limit" ||
    value === "billing" ||
    value === "timeout" ||
    value === "format" ||
    value === "unavailable" ||
    value === "unknown"
  );
}

function toSetupInferenceActivationResult(
  result: SystemAgentSetupActivateResult,
): ActivateSetupInferenceResult {
  if (result.ok) {
    if (
      !result.modelRef?.trim() ||
      typeof result.latencyMs !== "number" ||
      !Array.isArray(result.lines)
    ) {
      throw new Error("Gateway returned an invalid successful inference activation result.");
    }
    return {
      ok: true,
      modelRef: result.modelRef,
      latencyMs: result.latencyMs,
      lines: result.lines,
      ...(result.gatewayRestartRequired ? { gatewayRestartRequired: true } : {}),
    };
  }
  if (!isSetupInferenceFailureStatus(result.status) || !result.error?.trim()) {
    throw new Error("Gateway returned an invalid failed inference activation result.");
  }
  return { ok: false, status: result.status, error: result.error };
}

function activationTimeoutMs(kind: ActivateSetupInferenceParams["kind"]): number {
  return kind === "codex-cli"
    ? GATEWAY_CODEX_SETUP_ACTIVATE_TIMEOUT_MS
    : GATEWAY_SETUP_ACTIVATE_TIMEOUT_MS;
}

function bindGatewayConfig(target: RemoteGatewayInferenceTarget): OpenClawConfig {
  return {
    ...target.config,
    gateway: {
      ...target.config.gateway,
      mode: "remote",
      remote: {
        ...target.config.gateway?.remote,
        url: target.gatewayUrl,
      },
    },
  };
}

function assertVerifiedActivation(params: {
  activation: Extract<ActivateSetupInferenceResult, { ok: true }>;
  requestedModelRef?: string;
  verification: SystemAgentSetupVerifyResult;
}): void {
  if (
    params.requestedModelRef &&
    params.activation.modelRef.trim() !== params.requestedModelRef.trim()
  ) {
    throw new Error(
      `Gateway activated ${params.activation.modelRef}, not the selected ${params.requestedModelRef}.`,
    );
  }
  if (!params.verification.ok) {
    throw new Error(`Gateway inference verification failed: ${params.verification.error}`);
  }
  if (params.verification.modelRef.trim() !== params.activation.modelRef.trim()) {
    throw new Error(
      `Gateway verified ${params.verification.modelRef}, not the activated ${params.activation.modelRef}.`,
    );
  }
}

/**
 * Configure missing inference on the selected remote Gateway, then let that
 * Gateway's OpenClaw finish setup before handing off to its normal TUI.
 * The local config is routing input only; every setup mutation runs through
 * Gateway RPC.
 */
export async function runRemoteGatewayInferenceOnboarding(
  target: RemoteGatewayInferenceTarget,
  runtime: RuntimeEnv = defaultRuntime,
  deps: RemoteGatewayInferenceOnboardingDeps = {},
): Promise<void> {
  const callGateway = deps.callGateway ?? (await import("../gateway/call.js")).callGatewayCli;
  const runGuidedOnboarding =
    deps.runGuidedOnboarding ?? (await import("./onboard-guided.js")).runGuidedOnboarding;
  const boundConfig = bindGatewayConfig(target);
  const explicitAuth = Boolean(target.token || target.password);
  let gatewayWorkspace: string | undefined;

  const request = async <T>(
    params: Pick<
      CallGatewayCliOptions,
      "method" | "params" | "onHelloOk" | "signal" | "deviceIdentity"
    > & { timeoutMs: number },
  ): Promise<T> =>
    await callGateway<T>({
      ...params,
      config: boundConfig,
      // Authenticated calls can pin the URL directly. Auth-free loopback
      // Gateways use the equivalently pinned config target because URL
      // overrides intentionally require explicit credentials.
      ...(explicitAuth ? { url: target.gatewayUrl } : {}),
      ...(target.token ? { token: target.token } : {}),
      ...(target.password ? { password: target.password } : {}),
      ...(target.tlsFingerprint ? { tlsFingerprint: target.tlsFingerprint } : {}),
      ignoreEnvUrlOverride: true,
    });

  const detect = async (): Promise<SetupInferenceDetection> => {
    const result = await request<SystemAgentSetupDetectResult>({
      method: "openclaw.setup.detect",
      params: {},
      timeoutMs: GATEWAY_SETUP_DETECT_TIMEOUT_MS,
    });
    const detection = toSetupInferenceDetection(result);
    gatewayWorkspace = detection.workspace;
    return detection;
  };

  const activate = async (
    params: ActivateSetupInferenceParams,
  ): Promise<ActivateSetupInferenceResult> => {
    let activationBootId: string | undefined;
    const result = await request<SystemAgentSetupActivateResult>({
      method: "openclaw.setup.activate",
      params: {
        kind: params.kind,
        ...(params.modelRef !== undefined ? { modelRef: params.modelRef } : {}),
        ...(params.authChoice !== undefined ? { authChoice: params.authChoice } : {}),
        ...(params.apiKey !== undefined ? { apiKey: params.apiKey } : {}),
        ...(gatewayWorkspace ? { workspace: gatewayWorkspace } : {}),
      },
      timeoutMs: activationTimeoutMs(params.kind),
      onHelloOk: (hello) => {
        activationBootId = hello.server.bootId?.trim();
      },
    });
    const activation = toSetupInferenceActivationResult(result);
    if (!activation.ok) {
      return activation;
    }
    const restartBootId = activation.gatewayRestartRequired ? activationBootId : undefined;
    if (activation.gatewayRestartRequired && !restartBootId) {
      throw new Error(GATEWAY_RESTART_IDENTITY_ERROR);
    }
    const restartDeadline = Date.now() + GATEWAY_RESTART_WAIT_TIMEOUT_MS;
    let retryDelayMs = 250;
    for (;;) {
      const remainingBeforeAttemptMs = restartDeadline - Date.now();
      if (restartBootId && remainingBeforeAttemptMs <= 0) {
        throw new Error(
          "Inference settings were saved, but the Gateway did not finish restarting and verifying inference. Check the remote Gateway, then run onboarding again.",
        );
      }
      const restartWait = new AbortController();
      let requestedDelay = retryDelayMs;
      try {
        const verification = await request<SystemAgentSetupVerifyResult>({
          method: "openclaw.setup.verify",
          params: {},
          timeoutMs: restartBootId
            ? Math.min(GATEWAY_SETUP_VERIFY_TIMEOUT_MS, remainingBeforeAttemptMs)
            : GATEWAY_SETUP_VERIFY_TIMEOUT_MS,
          signal: restartWait.signal,
          onHelloOk: (hello) => {
            if (!restartBootId) {
              return;
            }
            const bootId = hello.server.bootId?.trim();
            // Verification runs inference. Cancel at hello so an old healthy
            // listener cannot bill another completion or satisfy the restart.
            if (!bootId || bootId === restartBootId) {
              restartWait.abort(bootId ? "unchanged-boot" : "missing-boot");
            }
          },
        });
        if (!restartBootId || verification.ok || verification.status !== "unavailable") {
          assertVerifiedActivation({
            activation,
            verification,
            ...(params.modelRef ? { requestedModelRef: params.modelRef } : {}),
          });
          return activation;
        }
      } catch (error) {
        if (restartWait.signal.reason === "missing-boot") {
          throw new Error(GATEWAY_RESTART_IDENTITY_ERROR, { cause: error });
        }
        const retryable =
          restartBootId &&
          (restartWait.signal.reason === "unchanged-boot" ||
            isGatewayTransportError(error) ||
            (isGatewayClientRequestError(error) && error.retryable));
        if (!retryable) {
          throw error;
        }
        if (isGatewayClientRequestError(error)) {
          requestedDelay = error.retryAfterMs ?? retryDelayMs;
        }
      }
      await delay(Math.min(requestedDelay, Math.max(0, restartDeadline - Date.now())));
      retryDelayMs = Math.min(retryDelayMs * 2, 2_000);
    }
  };

  await runGuidedOnboarding({}, runtime, {
    detect,
    activate,
    // Setup applies on the remote gateway through its chat; the local
    // custodian flow (question zero, local setup apply, local hatch) is wrong here.
    handoffMode: "chat",
    runSetupMemoryImportStep: async () => ({ status: "skipped", providers: [] }),
    ...(deps.createPrompter ? { createPrompter: deps.createPrompter } : {}),
    runSystemAgentChat: async () => {
      const prompter = await (deps.createPrompter?.() ??
        import("../wizard/clack-prompter.js").then(({ createClackPrompter }) =>
          createClackPrompter(),
        ));
      await prompter.intro("OpenClaw");
      // One-shot RPCs have different connections. Preserve a signed device
      // owner across chat replies even when loopback shared auth needs no device.
      const deviceIdentity = resolveDeviceIdentityForGatewayCall();
      const sessionId = randomUUID();
      let reply = await request<SystemAgentChatResult>({
        method: "openclaw.chat",
        deviceIdentity,
        params: { sessionId, welcomeVariant: "onboarding" },
        timeoutMs: GATEWAY_SYSTEM_AGENT_CHAT_TIMEOUT_MS,
      });

      let agentDraft: SystemAgentChatResult["agentDraft"];
      try {
        for (;;) {
          await prompter.note(reply.reply, "OpenClaw");
          if (reply.action === "exit") {
            await prompter.outro("OpenClaw setup finished.");
            return;
          }
          if (reply.action === "open-agent") {
            agentDraft = reply.agentDraft;
            await prompter.outro("Opening your agent…");
            break;
          }
          const message = await prompter.text({
            message: "Reply to OpenClaw",
            ...(reply.sensitive ? { sensitive: true } : {}),
            validate: (value) => (value.trim() ? undefined : "Required"),
          });
          reply = await request<SystemAgentChatResult>({
            method: "openclaw.chat",
            deviceIdentity,
            params: { sessionId, message },
            timeoutMs: GATEWAY_SYSTEM_AGENT_CHAT_TIMEOUT_MS,
          });
        }
      } catch (error) {
        if (error instanceof WizardCancelledError) {
          await prompter.outro("OpenClaw setup paused.");
          return;
        }
        throw error;
      }

      // Keep resolved credentials in-process; child argv is observable to
      // other local users and must never carry the Gateway secret.
      const runTui = deps.runTui ?? (await import("../tui/tui.js")).runTui;
      await runTui({
        config: boundConfig,
        deliver: false,
        ...(agentDraft === "hatch" ? { message: t("wizard.finalize.bootstrapHatchMessage") } : {}),
        boundGateway: {
          url: target.gatewayUrl,
          ...(target.token ? { token: target.token } : {}),
          ...(target.password ? { password: target.password } : {}),
          ...(target.tlsFingerprint ? { tlsFingerprint: target.tlsFingerprint } : {}),
        },
      });
    },
  });
}
