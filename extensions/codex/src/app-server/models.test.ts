// Codex tests cover models plugin behavior.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "./client.js";
import { createClientHarness } from "./test-support.js";

const mocks = vi.hoisted(() => {
  const authBridge = {
    applyAuthProfile: vi.fn(async () => undefined),
    authProfileId: vi.fn((params?: { authProfileId?: string }) => params?.authProfileId),
    fallbackApiKeyCacheKey: vi.fn(() => undefined),
    startOptions: vi.fn(async ({ startOptions }) => startOptions),
  };
  const managedBinary = {
    nativeCommand: vi.fn(() => undefined),
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
  resolveCodexAppServerFallbackApiKeyCacheKey: mocks.authBridge.fallbackApiKeyCacheKey,
  resolveCodexAppServerAuthProfileIdForAgent: mocks.authBridge.authProfileId,
  resolveCodexAppServerHomeDir: (agentDir: string) => `${agentDir}/codex-home`,
}));

vi.mock("./managed-binary.js", () => ({
  resolveManagedCodexAppServerStartOptions: mocks.managedBinary.startOptions,
  resolveManagedCodexNativeCommand: mocks.managedBinary.nativeCommand,
}));

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  resolveDefaultAgentDir: mocks.providerAuth.agentDir,
}));

let listCodexAppServerModels: typeof import("./models.js").listCodexAppServerModels;
let listAllCodexAppServerModels: typeof import("./models.js").listAllCodexAppServerModels;
let readModelListResult: typeof import("./models.js").readModelListResult;
let resetSharedCodexAppServerClientForTests: typeof import("./shared-client.js").resetSharedCodexAppServerClientForTests;

const validModelListEntry = {
  id: "gpt-test",
  model: "gpt-test",
  displayName: "GPT Test",
  description: "test model",
  hidden: false,
  isDefault: false,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [],
};

describe("listCodexAppServerModels", () => {
  beforeAll(async () => {
    ({ listCodexAppServerModels, listAllCodexAppServerModels, readModelListResult } =
      await import("./models.js"));
    ({ resetSharedCodexAppServerClientForTests } = await import("./shared-client.js"));
  });

  afterEach(() => {
    resetSharedCodexAppServerClientForTests();
    vi.restoreAllMocks();
    mocks.authBridge.applyAuthProfile.mockClear();
    mocks.authBridge.authProfileId.mockClear();
    mocks.authBridge.authProfileId.mockImplementation(
      (params?: { authProfileId?: string }) => params?.authProfileId,
    );
    mocks.authBridge.fallbackApiKeyCacheKey.mockClear();
    mocks.authBridge.fallbackApiKeyCacheKey.mockReturnValue(undefined);
    mocks.authBridge.startOptions.mockClear();
    mocks.managedBinary.startOptions.mockClear();
    mocks.managedBinary.startOptions.mockImplementation(async (startOptions) => startOptions);
    mocks.managedBinary.nativeCommand.mockClear();
    mocks.managedBinary.nativeCommand.mockReturnValue(undefined);
    mocks.providerAuth.agentDir.mockClear();
  });

  it.each([
    { label: "missing response", value: undefined },
    { label: "null response", value: null },
    { label: "missing model data", value: {} },
    { label: "non-array model data", value: { data: {} } },
    { label: "null model row", value: { data: [null] } },
    { label: "invalid pagination cursor", value: { data: [], nextCursor: 42 } },
    {
      label: "whitespace model identifier",
      value: { data: [{ ...validModelListEntry, id: "   " }] },
    },
    {
      label: "whitespace model name",
      value: { data: [{ ...validModelListEntry, model: "\t " }] },
    },
    {
      label: "malformed row after a valid model",
      value: { data: [validModelListEntry, { ...validModelListEntry, id: "   " }] },
    },
  ])("rejects $label without returning an incomplete model catalog", ({ value }) => {
    expect(() => readModelListResult(value)).toThrow(
      /Invalid Codex app-server model\/list response/,
    );
  });

  it.each([{ data: [] }, { data: [], nextCursor: null }])(
    "preserves a genuinely empty model catalog",
    (value) => {
      expect(readModelListResult(value)).toEqual({ models: [] });
    },
  );

  it("preserves generated model defaults and a valid pagination cursor", () => {
    expect(readModelListResult({ data: [validModelListEntry], nextCursor: "page-2" })).toEqual({
      models: [
        {
          id: "gpt-test",
          model: "gpt-test",
          displayName: "GPT Test",
          description: "test model",
          hidden: false,
          isDefault: false,
          inputModalities: ["text", "image"],
          supportedReasoningEfforts: [],
          defaultReasoningEffort: "medium",
        },
      ],
      nextCursor: "page-2",
    });
  });

  it.each([
    { label: "missing model data", response: {} },
    { label: "non-array model data", response: { data: {} } },
    {
      label: "whitespace model identifier",
      response: { data: [{ ...validModelListEntry, id: "   " }] },
    },
    {
      label: "malformed row after a valid model",
      response: { data: [validModelListEntry, { ...validModelListEntry, id: "   " }] },
    },
  ])("rejects $label through the app-server JSON-RPC boundary", async ({ response }) => {
    const harness = createClientHarness();
    const startSpy = vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

    const listPromise = listCodexAppServerModels({ timeoutMs: 1000 });
    await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThanOrEqual(1));
    const initialize = JSON.parse(harness.writes[0] ?? "{}") as { id?: number };
    harness.send({
      id: initialize.id,
      result: { userAgent: "openclaw/0.148.0 (macOS; test)" },
    });
    await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThanOrEqual(3));
    const list = JSON.parse(harness.writes[2] ?? "{}") as { id?: number; method?: string };
    expect(list.method).toBe("model/list");
    harness.send({ id: list.id, result: response });

    await expect(listPromise).rejects.toThrow(/Invalid Codex app-server model\/list response/);
    harness.client.close();
    startSpy.mockRestore();
  });

  it("lists app-server models through the typed helper", async () => {
    const harness = createClientHarness();
    const startSpy = vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

    const listPromise = listCodexAppServerModels({ limit: 12, timeoutMs: 1000 });
    await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThanOrEqual(1));
    const initialize = JSON.parse(harness.writes[0] ?? "{}") as { id?: number };
    harness.send({
      id: initialize.id,
      result: { userAgent: "openclaw/0.148.0 (macOS; test)" },
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
            upgradeInfo: {
              model: "gpt-5.6",
              upgradeCopy: "Try GPT-5.6",
              modelLink: null,
              migrationMarkdown: null,
              retirementAt: 1_800_000_000,
            },
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
            multiAgentVersion: "v2",
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
      result: { userAgent: "openclaw/0.148.0 (macOS; test)" },
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
            id: "gpt-5.5",
            model: "gpt-5.5",
            upgrade: null,
            upgradeInfo: null,
            availabilityNux: null,
            displayName: "gpt-5.5",
            description: "GPT-5.5",
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

    const list = await listPromise;
    expect(list.models.map((model) => model.id)).toEqual(["gpt-5.4", "gpt-5.5"]);
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
      result: { userAgent: "openclaw/0.148.0 (macOS; test)" },
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

    const list = await listPromise;
    expect(list.models.map((model) => model.id)).toEqual(["gpt-5.4"]);
    expect(list.nextCursor).toBe("page-2");
    expect(list.truncated).toBe(true);
    harness.client.close();
    startSpy.mockRestore();
  });
});
