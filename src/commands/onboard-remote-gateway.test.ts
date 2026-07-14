import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CallGatewayCliOptions } from "../gateway/call.js";
import type { RuntimeEnv } from "../runtime.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import type { GuidedOnboardingDeps } from "./onboard-guided.js";
import { runRemoteGatewayInferenceOnboarding } from "./onboard-remote-gateway.js";

type RemoteGatewayInferenceTarget = Parameters<typeof runRemoteGatewayInferenceOnboarding>[0];
type RemoteGatewayInferenceOnboardingDeps = NonNullable<
  Parameters<typeof runRemoteGatewayInferenceOnboarding>[2]
>;

type GatewayCall = NonNullable<RemoteGatewayInferenceOnboardingDeps["callGateway"]>;
type RunGuidedOnboarding = NonNullable<RemoteGatewayInferenceOnboardingDeps["runGuidedOnboarding"]>;

function makeRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn() as unknown as RuntimeEnv["exit"],
  };
}

function makeLocalConfig(): OpenClawConfig {
  return {
    wizard: { securityAcknowledgedAt: "2026-07-11T00:00:00.000Z" },
    agents: {
      defaults: {
        workspace: "/client/workspace",
        model: { primary: "openai/local-only" },
      },
    },
    gateway: {
      mode: "remote",
      remote: { url: "wss://configured.example/ws", token: "configured-token" },
    },
  };
}

function makeTarget(
  config: OpenClawConfig,
  auth: { token?: string; password?: string },
): RemoteGatewayInferenceTarget {
  return {
    config,
    gatewayUrl: "wss://selected.example/ws",
    ...auth,
    tlsFingerprint: "sha256:selected",
  };
}

function detectResult() {
  return {
    candidates: [
      {
        kind: "claude-cli",
        label: "Claude Code",
        detail: "logged in",
        modelRef: "claude-cli/opus",
        recommended: true,
        credentials: true,
      },
      {
        kind: "codex-cli",
        label: "Codex",
        detail: "logged in",
        modelRef: "openai/gpt-5.5",
        recommended: false,
        credentials: true,
      },
    ],
    manualProviders: [],
    workspace: "/gateway/workspace",
    setupComplete: false,
  } as const;
}

function exerciseGuidedAdapters(): RunGuidedOnboarding {
  const run: RunGuidedOnboarding = async (_opts, runtime, deps) => {
    const guidedDeps: GuidedOnboardingDeps = deps ?? {};
    if (!guidedDeps.detect || !guidedDeps.activate || !guidedDeps.runCrestodianChat) {
      throw new Error("remote guided adapters missing");
    }
    const detection = await guidedDeps.detect();
    const selected = detection.candidates[0];
    if (!selected) {
      throw new Error("remote detection returned no candidate");
    }
    const activation = await guidedDeps.activate({
      kind: selected.kind,
      modelRef: selected.modelRef,
      // The adapter must replace this client-side context with Gateway detection.workspace.
      workspace: "/client/workspace",
      surface: "cli",
      runtime,
    });
    if (activation.ok) {
      await guidedDeps.runCrestodianChat("/client/workspace", runtime, true);
    }
  };
  return vi.fn(run);
}

function asGatewayCall(mock: ReturnType<typeof vi.fn>): GatewayCall {
  return mock as unknown as GatewayCall;
}

describe("runRemoteGatewayInferenceOnboarding", () => {
  it.each([
    { label: "token", auth: { token: "selected-token" }, secret: "selected-token" },
    {
      label: "password",
      auth: { password: "selected-password" },
      secret: "selected-password",
    },
  ])(
    "pins $label across detect, activate, verify, Crestodian, and in-process TUI",
    async ({ auth, secret }) => {
      const localConfig = makeLocalConfig();
      const localConfigBefore = structuredClone(localConfig);
      const order: string[] = [];
      const remoteConfig: { modelRef?: string } = {};
      const callGatewayMock = vi.fn(async (options: CallGatewayCliOptions): Promise<unknown> => {
        expect(options.url).toBe("wss://selected.example/ws");
        expect(options.token).toBe(auth.token);
        expect(options.password).toBe(auth.password);
        expect(options.tlsFingerprint).toBe("sha256:selected");
        expect(options.ignoreEnvUrlOverride).toBe(true);
        expect(options.config?.gateway?.remote?.url).toBe("wss://selected.example/ws");
        order.push(options.method);

        if (options.method === "crestodian.setup.detect") {
          expect(options.timeoutMs).toBe(20_000);
          return detectResult();
        }
        if (options.method === "crestodian.setup.activate") {
          expect(options.timeoutMs).toBe(150_000);
          expect(options.params).toEqual({
            kind: "claude-cli",
            modelRef: "claude-cli/opus",
            workspace: "/gateway/workspace",
          });
          remoteConfig.modelRef = "claude-cli/opus";
          return {
            ok: true,
            modelRef: remoteConfig.modelRef,
            latencyMs: 250,
            lines: ["Default model: claude-cli/opus"],
          };
        }
        if (options.method === "crestodian.setup.verify") {
          expect(options.timeoutMs).toBe(30_000);
          expect(remoteConfig.modelRef).toBe("claude-cli/opus");
          return { ok: true, modelRef: remoteConfig.modelRef, latencyMs: 100 };
        }
        if (options.method === "crestodian.chat") {
          expect(options.timeoutMs).toBe(190_000);
          expect(remoteConfig.modelRef).toBe("claude-cli/opus");
          expect(options.params).toEqual({
            sessionId: expect.any(String),
            welcomeVariant: "onboarding",
          });
          return {
            sessionId: (options.params as { sessionId: string }).sessionId,
            reply: "Inference is ready. I can configure the rest.",
            action: "open-agent",
          };
        }
        throw new Error(`unexpected Gateway method ${options.method}`);
      });
      const runTui = vi.fn(async (options: Record<string, unknown>) => {
        order.push("tui");
        expect(options).toEqual({
          config: expect.objectContaining({
            gateway: expect.objectContaining({
              remote: expect.objectContaining({ url: "wss://selected.example/ws" }),
            }),
          }),
          deliver: false,
          boundGateway: {
            url: "wss://selected.example/ws",
            ...auth,
            tlsFingerprint: "sha256:selected",
          },
        });
        return { exitReason: "exit" as const };
      });
      const text = vi.fn(async () => "unexpected");
      const prompter = createWizardPrompter({ text });
      const runtime = makeRuntime();

      await runRemoteGatewayInferenceOnboarding(makeTarget(localConfig, auth), runtime, {
        callGateway: asGatewayCall(callGatewayMock),
        createPrompter: () => prompter,
        runGuidedOnboarding: exerciseGuidedAdapters(),
        runTui,
      });

      expect(order).toEqual([
        "crestodian.setup.detect",
        "crestodian.setup.activate",
        "crestodian.setup.verify",
        "crestodian.chat",
        "tui",
      ]);
      expect(remoteConfig.modelRef).toBe("claude-cli/opus");
      expect(localConfig).toEqual(localConfigBefore);
      expect(text).not.toHaveBeenCalled();
      expect(process.argv).not.toContain(secret);
      expect(
        JSON.stringify([prompter.note, prompter.outro, runtime.log, runtime.error]),
      ).not.toContain(secret);
    },
  );

  it("hands an auth-free Gateway to the TUI as the exact bound route", async () => {
    const callGatewayMock = vi.fn(async (options: CallGatewayCliOptions): Promise<unknown> => {
      if (options.method === "crestodian.setup.detect") {
        return detectResult();
      }
      if (options.method === "crestodian.setup.activate") {
        return {
          ok: true,
          modelRef: "claude-cli/opus",
          latencyMs: 250,
          lines: ["Default model: claude-cli/opus"],
        };
      }
      if (options.method === "crestodian.setup.verify") {
        return { ok: true, modelRef: "claude-cli/opus", latencyMs: 100 };
      }
      if (options.method === "crestodian.chat") {
        return {
          sessionId: (options.params as { sessionId: string }).sessionId,
          reply: "Ready.",
          action: "open-agent",
        };
      }
      throw new Error(`unexpected Gateway method ${options.method}`);
    });
    const runTui = vi.fn(async () => ({ exitReason: "exit" as const }));

    await runRemoteGatewayInferenceOnboarding(makeTarget(makeLocalConfig(), {}), makeRuntime(), {
      callGateway: asGatewayCall(callGatewayMock),
      createPrompter: () => createWizardPrompter(),
      runGuidedOnboarding: exerciseGuidedAdapters(),
      runTui,
    });

    expect(runTui).toHaveBeenCalledWith({
      config: expect.objectContaining({
        gateway: expect.objectContaining({
          remote: expect.objectContaining({ url: "wss://selected.example/ws" }),
        }),
      }),
      deliver: false,
      boundGateway: {
        url: "wss://selected.example/ws",
        tlsFingerprint: "sha256:selected",
      },
    });
  });

  it.each([
    {
      label: "failed verification",
      verification: { ok: false, status: "auth", error: "credential expired" },
      error: "Gateway inference verification failed: credential expired",
    },
    {
      label: "mismatched model",
      verification: { ok: true, modelRef: "openai/other", latencyMs: 100 },
      error: "Gateway verified openai/other, not the activated claude-cli/opus",
    },
  ])("fails closed on $label before Crestodian", async ({ verification, error }) => {
    const localConfig = makeLocalConfig();
    const localConfigBefore = structuredClone(localConfig);
    const methods: string[] = [];
    const callGatewayMock = vi.fn(async (options: CallGatewayCliOptions): Promise<unknown> => {
      methods.push(options.method);
      if (options.method === "crestodian.setup.detect") {
        return detectResult();
      }
      if (options.method === "crestodian.setup.activate") {
        return {
          ok: true,
          modelRef: "claude-cli/opus",
          latencyMs: 250,
          lines: ["Default model: claude-cli/opus"],
        };
      }
      if (options.method === "crestodian.setup.verify") {
        return verification;
      }
      throw new Error(`unexpected Gateway method ${options.method}`);
    });
    const runTui = vi.fn();

    await expect(
      runRemoteGatewayInferenceOnboarding(
        makeTarget(localConfig, { token: "selected-token" }),
        makeRuntime(),
        {
          callGateway: asGatewayCall(callGatewayMock),
          createPrompter: () => createWizardPrompter(),
          runGuidedOnboarding: exerciseGuidedAdapters(),
          runTui,
        },
      ),
    ).rejects.toThrow(error);

    expect(methods).toEqual([
      "crestodian.setup.detect",
      "crestodian.setup.activate",
      "crestodian.setup.verify",
    ]);
    expect(runTui).not.toHaveBeenCalled();
    expect(localConfig).toEqual(localConfigBefore);
  });

  it("does not advance or fall back locally after an ambiguous activation request failure", async () => {
    const methods: string[] = [];
    const callGatewayMock = vi.fn(async (options: CallGatewayCliOptions): Promise<unknown> => {
      methods.push(options.method);
      if (options.method === "crestodian.setup.detect") {
        return detectResult();
      }
      if (options.method === "crestodian.setup.activate") {
        throw new Error("gateway connection closed after request");
      }
      throw new Error(`unexpected Gateway method ${options.method}`);
    });
    const runTui = vi.fn();

    await expect(
      runRemoteGatewayInferenceOnboarding(
        makeTarget(makeLocalConfig(), { token: "selected-token" }),
        makeRuntime(),
        {
          callGateway: asGatewayCall(callGatewayMock),
          createPrompter: () => createWizardPrompter(),
          runGuidedOnboarding: exerciseGuidedAdapters(),
          runTui,
        },
      ),
    ).rejects.toThrow("gateway connection closed after request");

    expect(methods).toEqual(["crestodian.setup.detect", "crestodian.setup.activate"]);
    expect(runTui).not.toHaveBeenCalled();
  });

  it("treats a cancelled remote Crestodian conversation as a pause without opening the agent", async () => {
    const methods: string[] = [];
    const callGatewayMock = vi.fn(async (options: CallGatewayCliOptions): Promise<unknown> => {
      methods.push(options.method);
      if (options.method === "crestodian.setup.detect") {
        return detectResult();
      }
      if (options.method === "crestodian.setup.activate") {
        return {
          ok: true,
          modelRef: "claude-cli/opus",
          latencyMs: 250,
          lines: ["Default model: claude-cli/opus"],
        };
      }
      if (options.method === "crestodian.setup.verify") {
        return { ok: true, modelRef: "claude-cli/opus", latencyMs: 100 };
      }
      if (options.method === "crestodian.chat") {
        return {
          sessionId: (options.params as { sessionId: string }).sessionId,
          reply: "Which channel should I configure?",
          action: "none",
        };
      }
      throw new Error(`unexpected Gateway method ${options.method}`);
    });
    const prompter = createWizardPrompter({
      text: vi.fn(async () => {
        throw new WizardCancelledError("cancelled");
      }),
    });
    const runTui = vi.fn();

    await runRemoteGatewayInferenceOnboarding(
      makeTarget(makeLocalConfig(), { token: "selected-token" }),
      makeRuntime(),
      {
        callGateway: asGatewayCall(callGatewayMock),
        createPrompter: () => prompter,
        runGuidedOnboarding: exerciseGuidedAdapters(),
        runTui,
      },
    );

    expect(methods).toEqual([
      "crestodian.setup.detect",
      "crestodian.setup.activate",
      "crestodian.setup.verify",
      "crestodian.chat",
    ]);
    expect(prompter.outro).toHaveBeenCalledWith("Crestodian setup paused.");
    expect(runTui).not.toHaveBeenCalled();
  });
});
