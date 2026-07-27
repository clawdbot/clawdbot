/**
 * Tests live helper utilities for gateway CLI backend probes.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";

vi.mock("./client-start-readiness.js", () => ({
  startGatewayClientWhenEventLoopReady: async (client: { start: () => void }) => {
    client.start();
    return { ready: true, aborted: false, elapsedMs: 0, maxDriftMs: 0, checks: 0 };
  },
}));

describe("gateway cli backend live helpers", () => {
  let liveHelpers: typeof import("./gateway-cli-backend.live-helpers.js");

  beforeAll(async () => {
    liveHelpers = await import("./gateway-cli-backend.live-helpers.js");
  });

  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    cliBackendsTesting.resetDepsForTest();
    delete process.env.OPENCLAW_SKIP_CHANNELS;
    delete process.env.OPENCLAW_SKIP_PROVIDERS;
    delete process.env.OPENCLAW_SKIP_GMAIL_WATCHER;
    delete process.env.OPENCLAW_SKIP_CRON;
    delete process.env.OPENCLAW_SKIP_CANVAS_HOST;
    delete process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER;
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    delete process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
    delete process.env.OPENCLAW_LIVE_CLI_BACKEND_ALLOW_PROVIDER_SKIP;
    delete process.env.OPENCLAW_LIVE_CLI_BACKEND_ADVISORY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY_OLD;
  });

  it("applies and restores live env including minimal gateway mode", async () => {
    const { applyCliBackendLiveEnv, restoreCliBackendLiveEnv, snapshotCliBackendLiveEnv } =
      liveHelpers;

    process.env.OPENCLAW_SKIP_CHANNELS = "old-channels";
    process.env.OPENCLAW_SKIP_PROVIDERS = "old-providers";
    process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "old-gmail";
    process.env.OPENCLAW_SKIP_CRON = "old-cron";
    process.env.OPENCLAW_SKIP_CANVAS_HOST = "old-canvas";
    process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER = "old-browser";
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "old-bundled";
    process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "old-minimal";
    process.env.ANTHROPIC_API_KEY = "old-anthropic";
    process.env.ANTHROPIC_API_KEY_OLD = "old-anthropic-old";

    const snapshot = snapshotCliBackendLiveEnv();
    applyCliBackendLiveEnv(new Set<string>());

    expect(process.env.OPENCLAW_SKIP_CHANNELS).toBe("1");
    expect(process.env.OPENCLAW_SKIP_PROVIDERS).toBe("1");
    expect(process.env.OPENCLAW_SKIP_GMAIL_WATCHER).toBe("1");
    expect(process.env.OPENCLAW_SKIP_CRON).toBe("1");
    expect(process.env.OPENCLAW_SKIP_CANVAS_HOST).toBe("1");
    expect(process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER).toBe("1");
    expect(process.env.OPENCLAW_BUNDLED_PLUGINS_DIR).toBe("old-bundled");
    expect(process.env.OPENCLAW_TEST_MINIMAL_GATEWAY).toBe("1");
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY_OLD).toBeUndefined();

    restoreCliBackendLiveEnv(snapshot);

    expect(process.env.OPENCLAW_SKIP_CHANNELS).toBe("old-channels");
    expect(process.env.OPENCLAW_SKIP_PROVIDERS).toBe("old-providers");
    expect(process.env.OPENCLAW_SKIP_GMAIL_WATCHER).toBe("old-gmail");
    expect(process.env.OPENCLAW_SKIP_CRON).toBe("old-cron");
    expect(process.env.OPENCLAW_SKIP_CANVAS_HOST).toBe("old-canvas");
    expect(process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER).toBe("old-browser");
    expect(process.env.OPENCLAW_BUNDLED_PLUGINS_DIR).toBe("old-bundled");
    expect(process.env.OPENCLAW_TEST_MINIMAL_GATEWAY).toBe("old-minimal");
    expect(process.env.ANTHROPIC_API_KEY).toBe("old-anthropic");
    expect(process.env.ANTHROPIC_API_KEY_OLD).toBe("old-anthropic-old");
  });

  it("defaults the model switch probe to Claude Sonnet -> Opus", async () => {
    const { resolveCliModelSwitchProbeTarget, shouldRunCliModelSwitchProbe } =
      await import("./gateway-cli-backend.live-helpers.js");

    delete process.env.OPENCLAW_LIVE_CLI_BACKEND_MODEL_SWITCH_PROBE;

    expect(resolveCliModelSwitchProbeTarget("claude-cli", "claude-cli/claude-sonnet-4-6")).toBe(
      "claude-cli/claude-opus-4-6",
    );
    expect(shouldRunCliModelSwitchProbe("claude-cli", "claude-cli/claude-sonnet-4-6")).toBe(true);
    expect(shouldRunCliModelSwitchProbe("claude-cli", "claude-cli/claude-opus-4-6")).toBe(false);
    expect(shouldRunCliModelSwitchProbe("codex-cli", "codex-cli/gpt-5.5")).toBe(false);
  });

  it("rejects removed Codex CLI refs for live CLI backend selection", async () => {
    const { resolveCliBackendLiveModelSelection } =
      await import("./gateway-cli-backend.live-helpers.js");

    expect(() =>
      resolveCliBackendLiveModelSelection({
        rawModel: "codex-cli/gpt-5.4",
        defaultProvider: "claude-cli",
      }),
    ).toThrow(/codex-cli\/\.\.\. is no longer supported/u);
  });

  it("configures legacy CLI model refs as canonical provider models plus CLI runtime", async () => {
    const { resolveCliBackendLiveModelSelection } =
      await import("./gateway-cli-backend.live-helpers.js");
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [],
      resolvePluginSetupRegistry: () => ({
        providers: [],
        cliBackends: [
          {
            pluginId: "claude",
            backend: {
              id: "claude-cli",
              modelProvider: "anthropic",
              config: { command: "claude", args: [] },
            },
          },
        ],
        configMigrations: [],
        autoEnableProbes: [],
        diagnostics: [],
      }),
    });

    expect(
      resolveCliBackendLiveModelSelection({
        rawModel: "claude-cli/claude-sonnet-4-6",
        defaultProvider: "claude-cli",
        modelSwitchTarget: "claude-cli/claude-opus-4-6",
      }),
    ).toEqual({
      providerId: "claude-cli",
      cliModelKey: "claude-cli/claude-sonnet-4-6",
      configModelKey: "anthropic/claude-sonnet-4-6",
      configModelSwitchTarget: "anthropic/claude-opus-4-6",
      agentRuntime: { id: "claude-cli" },
    });
  });

  it("lets env disable the model switch probe", async () => {
    const { shouldRunCliModelSwitchProbe } = await import("./gateway-cli-backend.live-helpers.js");

    process.env.OPENCLAW_LIVE_CLI_BACKEND_MODEL_SWITCH_PROBE = "0";

    expect(shouldRunCliModelSwitchProbe("claude-cli", "claude-cli/claude-sonnet-4-6")).toBe(false);
  });

  it("requires provider results by default for explicit CLI backend live probes", async () => {
    const {
      CLI_BACKEND_LIVE_ADVISORY_ENV,
      CLI_BACKEND_LIVE_PROVIDER_SKIP_ENV,
      resolveCliBackendLiveProviderSkipDecision,
      shouldAllowCliBackendLiveProviderSkip,
    } = await import("./gateway-cli-backend.live-helpers.js");

    expect(shouldAllowCliBackendLiveProviderSkip({})).toBe(false);
    expect(
      resolveCliBackendLiveProviderSkipDecision({
        allowProviderSkip: false,
        label: "agent request",
        providerId: "claude-cli",
        reasonLabel: "auth drift",
      }),
    ).toEqual({
      action: "fail",
      message:
        'agent request for provider "claude-cli" was blocked by auth drift. Set OPENCLAW_LIVE_CLI_BACKEND_ADVISORY=1 and OPENCLAW_LIVE_CLI_BACKEND_ALLOW_PROVIDER_SKIP=1 only for advisory live probes.',
    });

    expect(
      shouldAllowCliBackendLiveProviderSkip({ [CLI_BACKEND_LIVE_PROVIDER_SKIP_ENV]: "1" }),
    ).toBe(false);
    expect(
      shouldAllowCliBackendLiveProviderSkip({
        [CLI_BACKEND_LIVE_ADVISORY_ENV]: "1",
        [CLI_BACKEND_LIVE_PROVIDER_SKIP_ENV]: "1",
      }),
    ).toBe(true);
    expect(
      resolveCliBackendLiveProviderSkipDecision({
        allowProviderSkip: true,
        label: "agent request",
        providerId: "claude-cli",
        reasonLabel: "Claude API capacity",
      }),
    ).toEqual({
      action: "skip",
      message: 'agent request for provider "claude-cli" was blocked by Claude API capacity.',
    });
  });

  it("builds Claude continuity prompts without revealing the hidden token", () => {
    const { buildClaudeCliResumeContinuityProbe } = liveHelpers;
    const memoryToken = "test-memory-token";

    const probe = buildClaudeCliResumeContinuityProbe({
      firstTurnNonce: "112233",
      resumeNonce: "445566",
      memoryToken,
    });

    expect(probe.firstTurnPrompt).toBe(
      "Do not inspect files or run tools. Reply with exactly: CLI-BACKEND-112233.",
    );
    expect(probe.resumePrompt).toBe(
      "Do not inspect files or run tools. " +
        "Return exactly two whitespace-separated tokens: CLI-RESUME-445566 followed by " +
        "the exact opaque session token from the earlier turn. Do not add prose.",
    );
    expect(probe.firstTurnPrompt).not.toContain(memoryToken);
    expect(probe.resumePrompt).not.toContain(memoryToken);
    expect(probe.injectedContext).toContain(memoryToken);
    expect(probe.expectedResumeMarker).toBe("CLI-RESUME-445566");
  });

  it("finds only Claude-imported native session ids", () => {
    const { resolveImportedClaudeCliSessionId } = liveHelpers;

    expect(
      resolveImportedClaudeCliSessionId([
        null,
        { __openclaw: "invalid" },
        { __openclaw: { importedFrom: "codex-cli", cliSessionId: "wrong-provider" } },
        { __openclaw: { importedFrom: "claude-cli", cliSessionId: 42 } },
        { __openclaw: { importedFrom: "claude-cli", cliSessionId: "claude-session" } },
      ]),
    ).toBe("claude-session");
    expect(resolveImportedClaudeCliSessionId([])).toBeUndefined();
  });

  it("retries Codex CLI timeout payloads only before the final attempt", async () => {
    const { isCliBackendLiveTimeoutPayload, shouldRetryCliBackendLiveTimeout } =
      await import("./gateway-cli-backend.live-helpers.js");
    const timeoutPayload = { status: "timeout" };

    expect(isCliBackendLiveTimeoutPayload(timeoutPayload)).toBe(true);
    expect(
      shouldRetryCliBackendLiveTimeout({
        attempt: 1,
        maxAttempts: 2,
        payload: timeoutPayload,
        providerId: "codex-cli",
      }),
    ).toBe(true);
    expect(
      shouldRetryCliBackendLiveTimeout({
        attempt: 2,
        maxAttempts: 2,
        payload: timeoutPayload,
        providerId: "codex-cli",
      }),
    ).toBe(false);
    expect(
      shouldRetryCliBackendLiveTimeout({
        attempt: 1,
        maxAttempts: 2,
        payload: timeoutPayload,
        providerId: "claude-cli",
      }),
    ).toBe(false);
  });

  it("allows live env overrides for fresh and resume CLI args", async () => {
    const { resolveCliBackendLiveArgs } = await import("./gateway-cli-backend.live-helpers.js");

    process.env.OPENCLAW_LIVE_CLI_BACKEND_ARGS = JSON.stringify([
      "exec",
      "--sandbox",
      "danger-full-access",
    ]);
    process.env.OPENCLAW_LIVE_CLI_BACKEND_RESUME_ARGS = JSON.stringify([
      "exec",
      "resume",
      "{sessionId}",
      "-c",
      'sandbox_mode="danger-full-access"',
    ]);

    expect(
      resolveCliBackendLiveArgs({
        providerId: "codex-cli",
        defaultArgs: ["exec", "--sandbox", "workspace-write"],
        defaultResumeArgs: [
          "exec",
          "resume",
          "{sessionId}",
          "-c",
          'sandbox_mode="workspace-write"',
        ],
      }),
    ).toEqual({
      args: ["exec", "--sandbox", "danger-full-access"],
      resumeArgs: ["exec", "resume", "{sessionId}", "-c", 'sandbox_mode="danger-full-access"'],
    });
  });

  it("retries cancelled cron MCP replies", async () => {
    const { shouldRetryCliCronMcpProbeReply } =
      await import("./gateway-cli-backend.live-helpers.js");

    expect(
      shouldRetryCliCronMcpProbeReply(
        "The `cron` MCP tool call was cancelled again, so the job was not created.",
      ),
    ).toBe(true);
    expect(
      shouldRetryCliCronMcpProbeReply(
        "The cron tool call was cancelled again, so the job still was not created.",
      ),
    ).toBe(true);
    expect(
      shouldRetryCliCronMcpProbeReply(
        "The `cron` MCP call was cancelled again, so the job was not created.",
      ),
    ).toBe(true);
    expect(
      shouldRetryCliCronMcpProbeReply(
        "The cron tool call was cancelled again, so nothing was created.",
      ),
    ).toBe(true);
    expect(
      shouldRetryCliCronMcpProbeReply(
        "The `cron` MCP tool call was cancelled (`user cancelled MCP tool call`).",
      ),
    ).toBe(true);
    expect(
      shouldRetryCliCronMcpProbeReply(
        "The tool call was cancelled before completion, so I can’t verify the cron job was created.",
      ),
    ).toBe(true);
    expect(
      shouldRetryCliCronMcpProbeReply(
        "The cron tool call was cancelled twice, so I could not create the job.",
      ),
    ).toBe(true);
    expect(
      shouldRetryCliCronMcpProbeReply(
        "The cron tool call was cancelled twice, so I couldn’t create `live-mcp-67f4e9`. Please retry and I’ll do it again.",
      ),
    ).toBe(true);
    expect(
      shouldRetryCliCronMcpProbeReply(
        "The cron tool call was canceled twice on the host side, so I couldn’t create `live-mcp-2d1afb`. If you want, send the same request again and I’ll retry.",
      ),
    ).toBe(true);
    expect(
      shouldRetryCliCronMcpProbeReply(
        "I tried the `cron` tool call twice, but both attempts were canceled by the environment (`user cancelled MCP tool call`), so I can’t honestly reply with the success token.",
      ),
    ).toBe(true);
    expect(shouldRetryCliCronMcpProbeReply("   ")).toBe(true);
    expect(
      shouldRetryCliCronMcpProbeReply(
        "The cron tool call was cancelled twice, so I couldn’t create `live-mcp-932c6b`. If you want, I can try again.",
      ),
    ).toBe(true);
    expect(
      shouldRetryCliCronMcpProbeReply(
        "The cron job was not created because the schedule payload was invalid.",
      ),
    ).toBe(false);
    expect(shouldRetryCliCronMcpProbeReply("live-mcp-abc123")).toBe(false);
  });
});
