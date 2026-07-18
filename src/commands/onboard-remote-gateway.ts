// Remote-Gateway onboarding adapters keep inference detection and activation on the Gateway host.
import { randomUUID } from "node:crypto";
import type {
  SystemAgentChatResult,
  SystemAgentSetupActivateResult,
  SystemAgentSetupDetectResult,
  SystemAgentSetupVerifyResult,
} from "../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CallGatewayCliOptions } from "../gateway/call.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import type {
  ActivateSetupInferenceParams,
  ActivateSetupInferenceResult,
  SetupInferenceDetection,
  SetupInferenceFailureStatus,
} from "../system-agent/setup-inference.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import type { GuidedOnboardingDeps } from "./onboard-guided.js";

const GATEWAY_SETUP_DETECT_TIMEOUT_MS = 20_000;
const GATEWAY_SETUP_ACTIVATE_TIMEOUT_MS = 150_000;
const GATEWAY_CODEX_SETUP_ACTIVATE_TIMEOUT_MS = 480_000;
const GATEWAY_SETUP_VERIFY_TIMEOUT_MS = 30_000;
const GATEWAY_SYSTEM_AGENT_CHAT_TIMEOUT_MS = 190_000;

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
      label: provider.label,
      ...(provider.hint !== undefined ? { hint: provider.hint } : {}),
      ...(provider.icon !== undefined ? { icon: provider.icon } : {}),
      ...(provider.website !== undefined ? { website: provider.website } : {}),
    })),
    authOptions: (result.authOptions ?? []).map((option) =>
      Object.assign(
        {
          id: option.id,
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

  const request = async <T>(params: {
    method: string;
    payload: unknown;
    timeoutMs: number;
  }): Promise<T> =>
    await callGateway<T>({
      config: boundConfig,
      // Authenticated calls can pin the URL directly. Auth-free loopback
      // Gateways use the equivalently pinned config target because URL
      // overrides intentionally require explicit credentials.
      ...(explicitAuth ? { url: target.gatewayUrl } : {}),
      ...(target.token ? { token: target.token } : {}),
      ...(target.password ? { password: target.password } : {}),
      ...(target.tlsFingerprint ? { tlsFingerprint: target.tlsFingerprint } : {}),
      ignoreEnvUrlOverride: true,
      method: params.method,
      params: params.payload,
      timeoutMs: params.timeoutMs,
    });

  const detect = async (): Promise<SetupInferenceDetection> => {
    const result = await request<SystemAgentSetupDetectResult>({
      method: "openclaw.setup.detect",
      payload: {},
      timeoutMs: GATEWAY_SETUP_DETECT_TIMEOUT_MS,
    });
    const detection = toSetupInferenceDetection(result);
    gatewayWorkspace = detection.workspace;
    return detection;
  };

  const activate = async (
    params: ActivateSetupInferenceParams,
  ): Promise<ActivateSetupInferenceResult> => {
    const result = await request<SystemAgentSetupActivateResult>({
      method: "openclaw.setup.activate",
      payload: {
        kind: params.kind,
        ...(params.modelRef !== undefined ? { modelRef: params.modelRef } : {}),
        ...(params.authChoice !== undefined ? { authChoice: params.authChoice } : {}),
        ...(params.apiKey !== undefined ? { apiKey: params.apiKey } : {}),
        ...(gatewayWorkspace ? { workspace: gatewayWorkspace } : {}),
      },
      timeoutMs: activationTimeoutMs(params.kind),
    });
    const activation = toSetupInferenceActivationResult(result);
    if (!activation.ok) {
      return activation;
    }
    const verification = await request<SystemAgentSetupVerifyResult>({
      method: "openclaw.setup.verify",
      payload: {},
      timeoutMs: GATEWAY_SETUP_VERIFY_TIMEOUT_MS,
    });
    assertVerifiedActivation({
      activation,
      verification,
      ...(params.modelRef ? { requestedModelRef: params.modelRef } : {}),
    });
    return activation;
  };

  await runGuidedOnboarding({}, runtime, {
    detect,
    activate,
    // Setup applies on the remote gateway through its chat; the local
    // custodian flow (question zero, local setup apply, local hatch) is wrong here.
    handoffMode: "chat",
    runSetupMemoryImportStep: async () => {},
    ...(deps.createPrompter ? { createPrompter: deps.createPrompter } : {}),
    runSystemAgentChat: async () => {
      const prompter = await (deps.createPrompter?.() ??
        import("../wizard/clack-prompter.js").then(({ createClackPrompter }) =>
          createClackPrompter(),
        ));
      await prompter.intro("OpenClaw");
      const sessionId = randomUUID();
      let reply = await request<SystemAgentChatResult>({
        method: "openclaw.chat",
        payload: { sessionId, welcomeVariant: "onboarding" },
        timeoutMs: GATEWAY_SYSTEM_AGENT_CHAT_TIMEOUT_MS,
      });

      try {
        for (;;) {
          await prompter.note(reply.reply, "OpenClaw");
          if (reply.action === "exit") {
            await prompter.outro("OpenClaw setup finished.");
            return;
          }
          if (reply.action === "open-agent") {
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
            payload: { sessionId, message },
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
