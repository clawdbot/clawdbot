import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";

const gatewayClientState = vi.hoisted(() => ({
  lastOptions: undefined as Record<string, unknown> | undefined,
}));

vi.mock("./client.js", () => ({
  GatewayClient: class MockGatewayClient {
    constructor(options: Record<string, unknown>) {
      gatewayClientState.lastOptions = options;
    }

    start() {
      const options = gatewayClientState.lastOptions as
        | { onHelloOk?: (hello: { type: "hello-ok" }) => void }
        | undefined;
      queueMicrotask(() => options?.onHelloOk?.({ type: "hello-ok" }));
    }

    async stopAndWait() {}
  },
}));

describe("gateway cli backend live helpers", () => {
  afterEach(() => {
    gatewayClientState.lastOptions = undefined;
    delete process.env.OPENCLAW_SKIP_CHANNELS;
    delete process.env.OPENCLAW_SKIP_PROVIDERS;
    delete process.env.OPENCLAW_SKIP_GMAIL_WATCHER;
    delete process.env.OPENCLAW_SKIP_CRON;
    delete process.env.OPENCLAW_SKIP_CANVAS_HOST;
    delete process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER;
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    delete process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY_OLD;
  });

  it("applies and restores live env including minimal gateway mode", async () => {
    const { applyCliBackendLiveEnv, restoreCliBackendLiveEnv, snapshotCliBackendLiveEnv } =
      await import("./gateway-cli-backend.live-helpers.js");

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

  it("builds the live gateway client with test identity defaults", async () => {
    const { connectTestGatewayClient } = await import("./gateway-cli-backend.live-helpers.js");

    const client = await connectTestGatewayClient({
      url: "ws://127.0.0.1:18789",
      token: "gateway-token",
    });

    expect(client).toBeTruthy();
    expect(gatewayClientState.lastOptions).toMatchObject({
      url: "ws://127.0.0.1:18789",
      token: "gateway-token",
      clientName: GATEWAY_CLIENT_NAMES.TEST,
      clientDisplayName: "vitest-live",
      clientVersion: "dev",
      mode: GATEWAY_CLIENT_MODES.TEST,
      connectChallengeTimeoutMs: 45_000,
    });
    expect(gatewayClientState.lastOptions).not.toHaveProperty("requestTimeoutMs");
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
    expect(shouldRunCliModelSwitchProbe("codex-cli", "codex-cli/gpt-5.4")).toBe(false);
  });

  it("lets env disable the model switch probe", async () => {
    const { shouldRunCliModelSwitchProbe } = await import("./gateway-cli-backend.live-helpers.js");

    process.env.OPENCLAW_LIVE_CLI_BACKEND_MODEL_SWITCH_PROBE = "0";

    expect(shouldRunCliModelSwitchProbe("claude-cli", "claude-cli/claude-sonnet-4-6")).toBe(false);
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
