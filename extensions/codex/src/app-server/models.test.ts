import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "./client.js";
import { createClientHarness } from "./test-support.js";

const mocks = vi.hoisted(() => {
  const authBridge = {
    applyAuthProfile: vi.fn(async () => undefined),
    startOptions: vi.fn(async ({ startOptions }) => startOptions),
  };
  const managedBinary = {
    startOptions: vi.fn(async (startOptions) => startOptions),
  };
  const providerAuth = {
    agentDir: vi.fn(() => "/tmp/openclaw-agent"),
  };
  return { authBridge, managedBinary, providerAuth };
});

vi.mock("./auth-bridge.js", () => ({
  applyCodexAppServerAuthProfile: mocks.authBridge.applyAuthProfile,
  bridgeCodexAppServerStartOptions: mocks.authBridge.startOptions,
}));

vi.mock("./managed-binary.js", () => ({
  resolveManagedCodexAppServerStartOptions: mocks.managedBinary.startOptions,
}));

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  resolveOpenClawAgentDir: mocks.providerAuth.agentDir,
}));

let listCodexAppServerModels: typeof import("./models.js").listCodexAppServerModels;
let listAllCodexAppServerModels: typeof import("./models.js").listAllCodexAppServerModels;
let resetSharedCodexAppServerClientForTests: typeof import("./shared-client.js").resetSharedCodexAppServerClientForTests;

describe("listCodexAppServerModels", () => {
  beforeAll(async () => {
    ({ listCodexAppServerModels } = await import("./models.js"));
    ({ listAllCodexAppServerModels } = await import("./models.js"));
    ({ resetSharedCodexAppServerClientForTests } = await import("./shared-client.js"));
  });

  afterEach(() => {
    resetSharedCodexAppServerClientForTests();
    vi.restoreAllMocks();
    mocks.authBridge.applyAuthProfile.mockClear();
    mocks.authBridge.startOptions.mockClear();
    mocks.managedBinary.startOptions.mockClear();
    mocks.managedBinary.startOptions.mockImplementation(async (startOptions) => startOptions);
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
      result: { userAgent: "openclaw/0.125.0 (macOS; test)" },
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
            upgrade: null,
            upgradeInfo: null,
            availabilityNux: null,
            displayName: "gpt-5.4",
            description: "GPT-5.4",
            hidden: false,
            inputModalities: ["text", "image"],
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "fast" },
              { reasoningEffort: "xhigh", description: "deep" },
            ],
            defaultReasoningEffort: "medium",
            supportsPersonality: false,
            additionalSpeedTiers: [],
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
          description: "GPT-5.4",
          hidden: false,
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

  it("lists all app-server model pages through one client", async () => {
    const harness = createClientHarness();
    const startSpy = vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

    const listPromise = listAllCodexAppServerModels({ limit: 1, timeoutMs: 1000 });
    await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThanOrEqual(1));
    const initialize = JSON.parse(harness.writes[0] ?? "{}") as { id?: number };
    harness.send({
      id: initialize.id,
      result: { userAgent: "openclaw/0.125.0 (macOS; test)" },
    });
    await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThanOrEqual(3));
    const firstList = JSON.parse(harness.writes[2] ?? "{}") as {
      id?: number;
      params?: { cursor?: string | null };
    };
    expect(firstList.params?.cursor).toBeNull();

    harness.send({
      id: firstList.id,
      result: {
        data: [
          {
            id: "gpt-5.4",
            model: "gpt-5.4",
            upgrade: null,
            upgradeInfo: null,
            availabilityNux: null,
            displayName: "gpt-5.4",
            description: "GPT-5.4",
            hidden: false,
            inputModalities: ["text"],
            supportedReasoningEfforts: [],
            defaultReasoningEffort: "medium",
            supportsPersonality: false,
            additionalSpeedTiers: [],
            isDefault: false,
          },
        ],
        nextCursor: "page-2",
      },
    });
    await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThanOrEqual(4));
    const secondList = JSON.parse(harness.writes[3] ?? "{}") as {
      id?: number;
      params?: { cursor?: string | null };
    };
    expect(secondList.params?.cursor).toBe("page-2");

    harness.send({
      id: secondList.id,
      result: {
        data: [
          {
            id: "gpt-5.2",
            model: "gpt-5.2",
            upgrade: null,
            upgradeInfo: null,
            availabilityNux: null,
            displayName: "gpt-5.2",
            description: "GPT-5.2",
            hidden: false,
            inputModalities: ["text", "image"],
            supportedReasoningEfforts: [],
            defaultReasoningEffort: "medium",
            supportsPersonality: false,
            additionalSpeedTiers: [],
            isDefault: false,
          },
        ],
        nextCursor: null,
      },
    });

    await expect(listPromise).resolves.toMatchObject({
      models: [{ id: "gpt-5.4" }, { id: "gpt-5.2" }],
    });
    harness.client.close();
    startSpy.mockRestore();
  });

  it("marks all-model listing truncated after the page cap", async () => {
    const harness = createClientHarness();
    const startSpy = vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

    const listPromise = listAllCodexAppServerModels({ limit: 1, timeoutMs: 1000, maxPages: 1 });
    await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThanOrEqual(1));
    const initialize = JSON.parse(harness.writes[0] ?? "{}") as { id?: number };
    harness.send({
      id: initialize.id,
      result: { userAgent: "openclaw/0.125.0 (macOS; test)" },
    });
    await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThanOrEqual(3));
    const firstList = JSON.parse(harness.writes[2] ?? "{}") as { id?: number };
    harness.send({
      id: firstList.id,
      result: {
        data: [
          {
            id: "gpt-5.4",
            model: "gpt-5.4",
            upgrade: null,
            upgradeInfo: null,
            availabilityNux: null,
            displayName: "gpt-5.4",
            description: "GPT-5.4",
            hidden: false,
            inputModalities: ["text"],
            supportedReasoningEfforts: [],
            defaultReasoningEffort: "medium",
            supportsPersonality: false,
            additionalSpeedTiers: [],
            isDefault: false,
          },
        ],
        nextCursor: "page-2",
      },
    });

    await expect(listPromise).resolves.toMatchObject({
      models: [{ id: "gpt-5.4" }],
      nextCursor: "page-2",
      truncated: true,
    });
    harness.client.close();
    startSpy.mockRestore();
  });
});
