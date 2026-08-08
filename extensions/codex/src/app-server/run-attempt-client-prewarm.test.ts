import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  debug: vi.fn(),
  getLeasedSharedCodexAppServerClient: vi.fn(),
  getSharedCodexAppServerClient: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>()),
  embeddedAgentLog: { debug: mocks.debug },
}));

vi.mock("./shared-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared-client.js")>()),
  getLeasedSharedCodexAppServerClient: mocks.getLeasedSharedCodexAppServerClient,
  getSharedCodexAppServerClient: mocks.getSharedCodexAppServerClient,
}));

const { prewarmCodexAttemptClient } = await import("./run-attempt-client-prewarm.js");

function createInput(params?: {
  attemptClientFactory?: () => Promise<never>;
  clientFactory?: () => Promise<never>;
  runtimeArtifactRequest?: { expected?: { id: string; fingerprint: string } };
}) {
  return {
    authProfileStore: { kind: "test-store" },
    authBindingFingerprint: "auth-fingerprint",
    connection: {
      agentDir: "/tmp/openclaw-agent",
      appServer: {
        requestTimeoutMs: 12_345,
        start: { command: "codex", args: ["app-server"] },
      },
      attemptClientFactory:
        params?.attemptClientFactory ?? mocks.getLeasedSharedCodexAppServerClient,
      options: params?.clientFactory ? { clientFactory: params.clientFactory } : {},
      params: { config: { agents: { defaults: { workspace: "/tmp/workspace" } } } },
      pluginConfig: { appServer: { enabled: true } },
      runAbortController: new AbortController(),
      runtimeArtifactRequest: params?.runtimeArtifactRequest,
      startupAuthRequirement: "subscription",
      startupClientAuthProfileId: "profile-1",
      startupPreparedAuth: undefined,
    },
  } as unknown as Parameters<typeof prewarmCodexAttemptClient>[0];
}

describe("Codex attempt client prewarm", () => {
  beforeEach(() => {
    mocks.debug.mockReset();
    mocks.getSharedCodexAppServerClient.mockReset();
    mocks.getSharedCodexAppServerClient.mockResolvedValue({});
  });

  it("starts the shared client before the attempt needs its lease", () => {
    const input = createInput();

    prewarmCodexAttemptClient(input);

    expect(mocks.getSharedCodexAppServerClient).toHaveBeenCalledWith({
      startOptions: { command: "codex", args: ["app-server"] },
      pluginConfig: { appServer: { enabled: true } },
      authProfileId: "profile-1",
      authRequirement: "subscription",
      authProfileStore: { kind: "test-store" },
      authBindingFingerprint: "auth-fingerprint",
      agentDir: "/tmp/openclaw-agent",
      config: { agents: { defaults: { workspace: "/tmp/workspace" } } },
      timeoutMs: 12_345,
      abandonSignal: input.connection.runAbortController.signal,
    });
  });

  it.each([
    ["a custom client factory", { clientFactory: async () => await new Promise<never>(() => {}) }],
    [
      "an alternate attempt client factory",
      { attemptClientFactory: async () => await new Promise<never>(() => {}) },
    ],
    ["runtime artifact capture", { runtimeArtifactRequest: {} }],
  ])("skips %s", (_label, options) => {
    prewarmCodexAttemptClient(createInput(options));

    expect(mocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("leaves failures for the canonical startup path", async () => {
    const error = new Error("cold start failed");
    mocks.getSharedCodexAppServerClient.mockRejectedValue(error);

    prewarmCodexAttemptClient(createInput());
    await vi.waitFor(() => {
      expect(mocks.debug).toHaveBeenCalledWith("codex app-server client prewarm failed", { error });
    });
  });
});
