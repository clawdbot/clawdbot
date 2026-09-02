// ClickClack tests cover post-write connection verification and gateway guidance.
import { createNonExitingRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callGatewayFromCli: vi.fn(),
  createClient: vi.fn(),
  me: vi.fn(),
  resolveWorkspaceId: vi.fn(),
  workspaces: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({
  callGatewayFromCli: mocks.callGatewayFromCli,
}));

vi.mock("./http-client.js", () => ({
  createClickClackClient: (options: unknown) => {
    mocks.createClient(options);
    return {
      me: mocks.me,
      workspaces: mocks.workspaces,
    };
  },
}));

vi.mock("./resolve.js", () => ({
  resolveWorkspaceId: mocks.resolveWorkspaceId,
}));

import { verifyClickClackAccountAfterSetup } from "./setup-verify.js";
import type { CoreConfig } from "./types.js";

const configuredAccount = {
  channels: {
    clickclack: {
      baseUrl: "https://clickclack.example",
      apiBaseUrl: "http://127.0.0.1:8484",
      token: "ccb_test",
      workspace: "default",
    },
  },
} satisfies CoreConfig;

function createRuntime() {
  return createNonExitingRuntimeEnv();
}

async function verify(
  cfg: CoreConfig = configuredAccount,
  runtime = createRuntime(),
): Promise<ReturnType<typeof createRuntime>> {
  await verifyClickClackAccountAfterSetup({
    cfg,
    accountId: "default",
    runtime,
  });
  return runtime;
}

describe("ClickClack post-write setup verification", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    mocks.callGatewayFromCli.mockReset().mockResolvedValue({ ok: true });
    mocks.createClient.mockReset();
    mocks.me.mockReset().mockResolvedValue({ id: "usr_bot", handle: "openclaw" });
    mocks.resolveWorkspaceId.mockReset().mockResolvedValue("wsp_default");
    mocks.workspaces
      .mockReset()
      .mockResolvedValue([
        { id: "wsp_default", name: "clickclack", slug: "default", created_at: "2026-01-01" },
      ]);
  });

  it("prints the resolved bot and workspace without blocking setup", async () => {
    const runtime = await verify();

    expect(mocks.createClient).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "http://127.0.0.1:8484",
      }),
    );

    expect(runtime.log).toHaveBeenNthCalledWith(
      1,
      "Connected as @openclaw — workspace clickclack resolved.",
    );
    expect(runtime.log).toHaveBeenNthCalledWith(
      2,
      "OpenClaw is running — ClickClack will connect automatically.",
    );
  });

  it.each([
    {
      name: "an invalid token",
      arrange: () => mocks.me.mockRejectedValue({ status: 401 }),
      expected: "ClickClack rejected the bot token (401). Copy a current token and rerun setup.",
    },
    {
      name: "a missing workspace",
      arrange: () => {
        mocks.resolveWorkspaceId.mockResolvedValue("wsp_missing");
        mocks.workspaces.mockResolvedValue([]);
      },
      expected:
        'Workspace "default" was not found. Check the id, slug, or name, list available workspaces, and rerun setup.',
    },
    {
      name: "a network failure",
      arrange: () => mocks.me.mockRejectedValue(new Error("network unavailable")),
      expected:
        "Connection check failed: network unavailable. Setup was saved; fix the connection and rerun setup.",
    },
  ])("logs a warning for $name and continues", async ({ arrange, expected }) => {
    arrange();
    const runtime = createRuntime();

    await expect(verify(configuredAccount, runtime)).resolves.toBe(runtime);
    expect(runtime.log).toHaveBeenNthCalledWith(1, expected);
    expect(runtime.log).toHaveBeenNthCalledWith(
      2,
      "OpenClaw is running — ClickClack will connect automatically.",
    );
  });

  it("skips client verification when the implicit env token is unavailable", async () => {
    vi.stubEnv("CLICKCLACK_BOT_TOKEN", "");
    const runtime = await verify({
      channels: {
        clickclack: {
          baseUrl: "https://clickclack.example",
          workspace: "default",
        },
      },
    } as CoreConfig);

    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenNthCalledWith(
      1,
      "Token comes from CLICKCLACK_BOT_TOKEN; verification skipped.",
    );
  });

  it.each([
    {
      name: "running",
      arrange: () => mocks.callGatewayFromCli.mockResolvedValue({ ok: true }),
      expected: "OpenClaw is running — ClickClack will connect automatically.",
    },
    {
      name: "not running",
      arrange: () =>
        mocks.callGatewayFromCli.mockRejectedValue(
          Object.assign(new Error("gateway closed (1006): no listener"), {
            name: "GatewayTransportError",
            kind: "closed",
            code: 1006,
          }),
        ),
      expected: "Start OpenClaw to connect: openclaw gateway",
    },
    {
      name: "unavailable",
      arrange: () => mocks.callGatewayFromCli.mockRejectedValue(new Error("probe failed")),
      expected:
        "If OpenClaw is running it connects automatically; otherwise start it with: openclaw gateway",
    },
  ])("prints the gateway next step when status is $name", async ({ arrange, expected }) => {
    arrange();
    const runtime = await verify();

    expect(runtime.log).toHaveBeenNthCalledWith(2, expected);
    expect(mocks.callGatewayFromCli).toHaveBeenCalledWith(
      "health",
      { timeout: "1000", json: true },
      undefined,
      { expectFinal: false, progress: false },
    );
  });
});
