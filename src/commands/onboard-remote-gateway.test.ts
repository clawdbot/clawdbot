import { describe, expect, it, vi } from "vitest";
import type { HelloOk } from "../../packages/gateway-protocol/src/schema/frames.js";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CallGatewayCliOptions } from "../gateway/call.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import type { RuntimeEnv } from "../runtime.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import type { GuidedOnboardingDeps } from "./onboard-guided.js";
import { runRemoteGatewayInferenceOnboarding } from "./onboard-remote-gateway.js";

vi.mock("../infra/device-identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/device-identity.js")>()),
  loadOrCreateDeviceIdentity: vi.fn(() => ({
    deviceId: "remote-onboarding-device",
    publicKeyPem: "test-public-key",
    privateKeyPem: "test-private-key",
  })),
}));

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
        brandId: "claude",
        label: "Claude Code",
        detail: "logged in",
        modelRef: "claude-cli/opus",
        recommended: true,
        credentials: true,
      },
      {
        kind: "codex-cli",
        brandId: "openai",
        label: "Codex",
        detail: "logged in",
        modelRef: "openai/gpt-5.5",
        recommended: false,
        credentials: true,
      },
    ],
    unavailableCandidates: [
      {
        id: "antigravity-cli",
        label: "Antigravity CLI",
        detail: "installed",
        reason: "tool-free probe unavailable",
      },
    ],
    manualProviders: [],
    authOptions: [],
    prepareOptions: [],
    recommendedInstalls: [],
    workspace: "/gateway/workspace",
    setupComplete: false,
  } as const;
}

function exerciseGuidedAdapters(): RunGuidedOnboarding {
  const run: RunGuidedOnboarding = async (_opts, runtime, deps) => {
    const guidedDeps: GuidedOnboardingDeps = deps ?? {};
    if (!guidedDeps.detect || !guidedDeps.activate || !guidedDeps.runSystemAgentChat) {
      throw new Error("remote guided adapters missing");
    }
    const detection = await guidedDeps.detect();
    if (detection.unavailableCandidates[0]?.id !== "antigravity-cli") {
      throw new Error("remote detection dropped unavailable integration metadata");
    }
    if (detection.prepareOptions.length !== 0) {
      throw new Error("remote detection invented prepare options");
    }
    const selected = detection.candidates[0];
    if (!selected) {
      throw new Error("remote detection returned no candidate");
    }
    if (selected.brandId !== "claude") {
      throw new Error("remote detection dropped bundled brand identity");
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
      await guidedDeps.runSystemAgentChat("/client/workspace", runtime, true);
    }
  };
  return vi.fn(run);
}

function gatewayHello(bootId?: string): HelloOk {
  return {
    type: "hello-ok",
    protocol: 1,
    server: { version: "test", connId: "test-connection", ...(bootId ? { bootId } : {}) },
    features: { methods: [], events: [] },
    snapshot: { presence: [], health: {}, stateVersion: { presence: 0, health: 0 }, uptimeMs: 0 },
    auth: { role: "operator", scopes: [] },
    policy: { maxPayload: 1, maxBufferedBytes: 1, tickIntervalMs: 1 },
  };
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
    "pins $label across detect, activate, verify, OpenClaw, and in-process TUI",
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

        if (options.method === "openclaw.setup.detect") {
          expect(options.timeoutMs).toBe(40_000);
          return detectResult();
        }
        if (options.method === "openclaw.setup.activate") {
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
        if (options.method === "openclaw.setup.verify") {
          expect(options.timeoutMs).toBe(30_000);
          expect(remoteConfig.modelRef).toBe("claude-cli/opus");
          return { ok: true, modelRef: remoteConfig.modelRef, latencyMs: 100 };
        }
        if (options.method === "openclaw.chat") {
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
            agentDraft: "hatch",
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
          message: "Wake up, my friend!",
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
        "openclaw.setup.detect",
        "openclaw.setup.activate",
        "openclaw.setup.verify",
        "openclaw.chat",
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

  it.each([
    {
      label: "request rejection",
      firstVerification: () =>
        Promise.reject(
          Object.assign(new Error("gateway restarting"), {
            name: "GatewayClientRequestError",
            gatewayCode: "UNAVAILABLE",
            retryable: true,
            retryAfterMs: 0,
          }),
        ),
    },
    {
      label: "typed unavailable result",
      firstVerification: () =>
        Promise.resolve({ ok: false, status: "unavailable", error: "gateway restarting" }),
    },
  ])("waits for a declared Gateway restart after $label", async ({ firstVerification }) => {
    const methods: string[] = [];
    let verifyAttempts = 0;
    const callGatewayMock = vi.fn(async (options: CallGatewayCliOptions): Promise<unknown> => {
      options.onHelloOk?.(
        gatewayHello(options.method === "openclaw.setup.verify" ? "new-boot" : "old-boot"),
      );
      options.signal?.throwIfAborted();
      methods.push(options.method);
      if (options.method === "openclaw.setup.detect") {
        return detectResult();
      }
      if (options.method === "openclaw.setup.activate") {
        return {
          ok: true,
          modelRef: "openai/gpt-5.5",
          latencyMs: 250,
          lines: ["Default model: openai/gpt-5.5"],
          gatewayRestartRequired: true,
        };
      }
      if (options.method === "openclaw.setup.verify" && verifyAttempts++ === 0) {
        return await firstVerification();
      }
      if (options.method === "openclaw.setup.verify") {
        return { ok: true, modelRef: "openai/gpt-5.5", latencyMs: 100 };
      }
      throw new Error(`unexpected Gateway method ${options.method}`);
    });
    const runGuidedOnboarding: RunGuidedOnboarding = async (_opts, runtime, deps) => {
      const detection = await deps?.detect?.();
      const candidate = detection?.candidates.find((entry) => entry.kind === "codex-cli");
      if (!candidate) {
        throw new Error("Codex candidate missing");
      }
      const activation = await deps?.activate?.({
        kind: "codex-cli",
        modelRef: candidate.modelRef,
        surface: "cli",
        runtime,
      });
      expect(activation).toMatchObject({ ok: true, gatewayRestartRequired: true });
    };

    await runRemoteGatewayInferenceOnboarding(
      makeTarget(makeLocalConfig(), { token: "selected-token" }),
      makeRuntime(),
      {
        callGateway: asGatewayCall(callGatewayMock),
        runGuidedOnboarding,
      },
    );

    expect(methods).toEqual([
      "openclaw.setup.detect",
      "openclaw.setup.activate",
      "openclaw.setup.verify",
      "openclaw.setup.verify",
    ]);
  });

  it.for([
    "replacement",
    "missing activation identity",
    "missing verification identity",
    "restart timeout",
  ])("gates inference and chat on replacement boot: %s", async (mode, ctx) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    ctx.onTestFinished(() => now.mockRestore());
    const sent: string[] = [];
    const verifiedBoots: string[] = [];
    let verificationConnections = 0;
    let bootId: string | undefined = "old-boot";
    const callGatewayMock = vi.fn(async (options: CallGatewayCliOptions): Promise<unknown> => {
      if (options.method === "openclaw.setup.activate" && mode === "missing activation identity") {
        bootId = undefined;
      }
      if (options.method === "openclaw.setup.verify") {
        if (mode === "restart timeout") {
          now.mockReturnValue(45_000);
        } else if (verificationConnections++ > 0) {
          bootId = mode === "missing verification identity" ? undefined : "new-boot";
        }
      }
      options.onHelloOk?.(gatewayHello(bootId));
      options.signal?.throwIfAborted();
      sent.push(options.method);
      if (options.method === "openclaw.setup.detect") {
        return detectResult();
      }
      if (options.method === "openclaw.setup.activate") {
        return {
          ok: true,
          modelRef: "claude-cli/opus",
          latencyMs: 250,
          lines: ["Saved inference settings"],
          gatewayRestartRequired: true,
        };
      }
      if (options.method === "openclaw.setup.verify") {
        verifiedBoots.push(bootId ?? "unidentified");
        return { ok: true, modelRef: "claude-cli/opus", latencyMs: 100 };
      }
      if (options.method === "openclaw.chat") {
        expect(bootId).toBe("new-boot");
        return { sessionId: "test-session", reply: "Ready.", action: "exit" };
      }
      throw new Error(`unexpected Gateway method ${options.method}`);
    });

    const onboarding = runRemoteGatewayInferenceOnboarding(
      makeTarget(makeLocalConfig(), { token: "selected-token" }),
      makeRuntime(),
      {
        callGateway: asGatewayCall(callGatewayMock),
        createPrompter: () => createWizardPrompter(),
        runGuidedOnboarding: exerciseGuidedAdapters(),
      },
    );
    if (mode !== "replacement") {
      await expect(onboarding).rejects.toThrow(
        mode === "restart timeout"
          ? "Inference settings were saved, but the Gateway did not finish restarting"
          : "Inference settings were saved, but the Gateway did not provide a boot identity",
      );
      expect(verifiedBoots).toEqual([]);
      expect(sent).toEqual(["openclaw.setup.detect", "openclaw.setup.activate"]);
      return;
    }
    await onboarding;
    expect(verifiedBoots).toEqual(["new-boot"]);
    expect(sent).toEqual([
      "openclaw.setup.detect",
      "openclaw.setup.activate",
      "openclaw.setup.verify",
      "openclaw.chat",
    ]);
  });

  it("bounds a late restart verification call by the remaining deadline", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(45_500).mockReturnValueOnce(1_000);
    const callGatewayMock = vi.fn(async (options: CallGatewayCliOptions): Promise<unknown> => {
      options.onHelloOk?.(
        gatewayHello(options.method === "openclaw.setup.verify" ? "new-boot" : "old-boot"),
      );
      options.signal?.throwIfAborted();
      if (options.method === "openclaw.setup.detect") {
        return detectResult();
      }
      if (options.method === "openclaw.setup.activate") {
        return {
          ok: true,
          modelRef: "openai/gpt-5.5",
          latencyMs: 250,
          lines: ["Default model: openai/gpt-5.5"],
          gatewayRestartRequired: true,
        };
      }
      if (options.method === "openclaw.setup.verify") {
        return { ok: true, modelRef: "openai/gpt-5.5", latencyMs: 100 };
      }
      throw new Error(`unexpected Gateway method ${options.method}`);
    });
    const runGuidedOnboarding: RunGuidedOnboarding = async (_opts, runtime, deps) => {
      await deps?.detect?.();
      await deps?.activate?.({
        kind: "codex-cli",
        modelRef: "openai/gpt-5.5",
        surface: "cli",
        runtime,
      });
    };

    try {
      await runRemoteGatewayInferenceOnboarding(
        makeTarget(makeLocalConfig(), { token: "selected-token" }),
        makeRuntime(),
        {
          callGateway: asGatewayCall(callGatewayMock),
          runGuidedOnboarding,
        },
      );
    } finally {
      now.mockRestore();
    }

    expect(
      callGatewayMock.mock.calls.find(
        ([options]) => options.method === "openclaw.setup.verify",
      )?.[0].timeoutMs,
    ).toBe(500);
  });

  it("hands an auth-free Gateway to the TUI as the exact bound route", async () => {
    const callGatewayMock = vi.fn(async (options: CallGatewayCliOptions): Promise<unknown> => {
      if (options.method === "openclaw.setup.detect") {
        return detectResult();
      }
      if (options.method === "openclaw.setup.activate") {
        return {
          ok: true,
          modelRef: "claude-cli/opus",
          latencyMs: 250,
          lines: ["Default model: claude-cli/opus"],
        };
      }
      if (options.method === "openclaw.setup.verify") {
        return { ok: true, modelRef: "claude-cli/opus", latencyMs: 100 };
      }
      if (options.method === "openclaw.chat") {
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
  ])("fails closed on $label before OpenClaw", async ({ verification, error }) => {
    const localConfig = makeLocalConfig();
    const localConfigBefore = structuredClone(localConfig);
    const methods: string[] = [];
    const callGatewayMock = vi.fn(async (options: CallGatewayCliOptions): Promise<unknown> => {
      methods.push(options.method);
      if (options.method === "openclaw.setup.detect") {
        return detectResult();
      }
      if (options.method === "openclaw.setup.activate") {
        return {
          ok: true,
          modelRef: "claude-cli/opus",
          latencyMs: 250,
          lines: ["Default model: claude-cli/opus"],
        };
      }
      if (options.method === "openclaw.setup.verify") {
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
      "openclaw.setup.detect",
      "openclaw.setup.activate",
      "openclaw.setup.verify",
    ]);
    expect(runTui).not.toHaveBeenCalled();
    expect(localConfig).toEqual(localConfigBefore);
  });

  it("does not advance or fall back locally after an ambiguous activation request failure", async () => {
    const methods: string[] = [];
    const callGatewayMock = vi.fn(async (options: CallGatewayCliOptions): Promise<unknown> => {
      methods.push(options.method);
      if (options.method === "openclaw.setup.detect") {
        return detectResult();
      }
      if (options.method === "openclaw.setup.activate") {
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

    expect(methods).toEqual(["openclaw.setup.detect", "openclaw.setup.activate"]);
    expect(runTui).not.toHaveBeenCalled();
  });

  it.each(["device", "profile"])(
    "keeps remote chat ownership across replies and cancellation: %s",
    async (identity) => {
      if (identity === "profile") {
        vi.mocked(loadOrCreateDeviceIdentity).mockImplementationOnce(() => {
          throw new Error("read-only client state");
        });
      }
      const methods: string[] = [];
      let chatOwner: string | undefined;
      let connections = 0;
      const callGatewayMock = vi.fn(async (options: CallGatewayCliOptions): Promise<unknown> => {
        methods.push(options.method);
        if (options.method === "openclaw.setup.detect") {
          return detectResult();
        }
        if (options.method === "openclaw.setup.activate") {
          return {
            ok: true,
            modelRef: "claude-cli/opus",
            latencyMs: 250,
            lines: ["Default model: claude-cli/opus"],
          };
        }
        if (options.method === "openclaw.setup.verify") {
          return { ok: true, modelRef: "claude-cli/opus", latencyMs: 100 };
        }
        if (options.method === "openclaw.chat") {
          // The Gateway falls back to connection ownership when there is no
          // authenticated profile or device; one-shot calls use new connections.
          const owner =
            identity === "profile"
              ? "authenticated-profile"
              : (options.deviceIdentity?.deviceId ?? `connection:${++connections}`);
          if (chatOwner && chatOwner !== owner) {
            throw new Error("OpenClaw session belongs to another caller.");
          }
          chatOwner = owner;
          return {
            sessionId: (options.params as { sessionId: string }).sessionId,
            reply: "Which channel should I configure?",
            action: "none",
          };
        }
        throw new Error(`unexpected Gateway method ${options.method}`);
      });
      const prompter = createWizardPrompter({
        text: vi
          .fn(async (): Promise<string> => {
            throw new WizardCancelledError("cancelled");
          })
          .mockResolvedValueOnce("Keep the existing configuration."),
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
        "openclaw.setup.detect",
        "openclaw.setup.activate",
        "openclaw.setup.verify",
        "openclaw.chat",
        "openclaw.chat",
      ]);
      expect(prompter.outro).toHaveBeenCalledWith("OpenClaw setup paused.");
      expect(runTui).not.toHaveBeenCalled();
    },
  );
});
