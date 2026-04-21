import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "./client.js";
import { createClientHarness } from "./test-support.js";

const mocks = vi.hoisted(() => {
  const authBridge = {
    startOptions: vi.fn(async ({ startOptions }) => startOptions),
  };
  const providerAuth = {
    agentDir: vi.fn(() => "/tmp/openclaw-agent"),
  };
  return { authBridge, providerAuth };
});

vi.mock("./auth-bridge.js", () => ({
  bridgeCodexAppServerStartOptions: mocks.authBridge.startOptions,
}));

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  resolveOpenClawAgentDir: mocks.providerAuth.agentDir,
}));

let listCodexAppServerModels: typeof import("./models.js").listCodexAppServerModels;
let resetSharedCodexAppServerClientForTests: typeof import("./shared-client.js").resetSharedCodexAppServerClientForTests;

describe("listCodexAppServerModels", () => {
  beforeAll(async () => {
    ({ listCodexAppServerModels } = await import("./models.js"));
    ({ resetSharedCodexAppServerClientForTests } = await import("./shared-client.js"));
  });

  afterEach(() => {
    resetSharedCodexAppServerClientForTests();
    vi.restoreAllMocks();
    mocks.authBridge.startOptions.mockClear();
    mocks.providerAuth.agentDir.mockClear();
  });

  it("lists app-server models through the typed helper", async () => {
    const harness = createClientHarness();
    const startSpy = vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

    const listPromise = listCodexAppServerModels({ limit: 12, timeoutMs: 1000 });
    await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThanOrEqual(1));
    const initialize = JSON.parse(harness.writes[0] ?? "{}") as { id?: number };
    harness.send({
      id: initialize.id,
      result: { userAgent: "openclaw/0.118.0 (macOS; test)" },
    });
    await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThanOrEqual(3));
    const list = JSON.parse(harness.writes[2] ?? "{}") as { id?: number; method?: string };
    expect(list.method).toBe("model/list");

    harness.send({
      id: list.id,
      result: {
        data: [
          {
            id: "gpt-5.4",
            model: "gpt-5.4",
            displayName: "gpt-5.4",
            inputModalities: ["text", "image"],
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "fast" },
              { reasoningEffort: "xhigh", description: "deep" },
            ],
            defaultReasoningEffort: "medium",
            isDefault: true,
          },
        ],
        nextCursor: null,
      },
    });

    await expect(listPromise).resolves.toEqual({
      models: [
        {
          id: "gpt-5.4",
          model: "gpt-5.4",
          displayName: "gpt-5.4",
          inputModalities: ["text", "image"],
          supportedReasoningEfforts: ["low", "xhigh"],
          defaultReasoningEffort: "medium",
          isDefault: true,
        },
      ],
    });
    harness.client.close();
    startSpy.mockRestore();
  });
});
