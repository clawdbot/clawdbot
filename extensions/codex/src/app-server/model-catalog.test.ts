import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexAppServerModelCatalog } from "./model-catalog.js";
import { listAllCodexAppServerModels } from "./models.js";
import { withCodexAppServerJsonClient } from "./request.js";

vi.mock("./models.js", () => ({
  listAllCodexAppServerModels: vi.fn(),
}));

const rpc = vi.hoisted(() => ({ request: vi.fn(), epoch: 0, client: {} }));
vi.mock("./request.js", () => ({
  withCodexAppServerJsonClient: vi.fn(
    (_options: unknown, run: (request: unknown, client: unknown) => unknown) =>
      run(rpc.request, rpc.client),
  ),
}));
vi.mock("./shared-client.js", () => ({
  captureSharedCodexAppServerCatalogLifetime: () => {
    const epoch = rpc.epoch;
    return () => rpc.epoch === epoch;
  },
}));
let owner: ReturnType<typeof createCodexAppServerModelCatalog>;
const loadCodexAppServerModelCatalog = (...args: Parameters<typeof owner.load>) =>
  owner.load(...args);
const read = (overrides = {}) =>
  owner.read(
    { ...catalogParams, provider: "openai", modelId: "synthetic-opaque", ...overrides },
    undefined,
  );
const listModelsMock = vi.mocked(listAllCodexAppServerModels);

const catalogParams = {
  config: {},
  agentId: "main",
  agentDir: "/tmp/main-agent",
  workspaceDir: "/tmp/workspace",
};

describe("Codex app-server model catalog", () => {
  beforeEach(() => {
    listModelsMock.mockReset();
    vi.mocked(withCodexAppServerJsonClient).mockClear();
    rpc.epoch += 1;
    rpc.request
      .mockReset()
      .mockResolvedValue({ account: { type: "apiKey" }, requiresOpenaiAuth: true });
    owner = createCodexAppServerModelCatalog("codex");
  });

  it("keeps native picker models independent of a host transport", async () => {
    listModelsMock.mockResolvedValue({
      models: [
        {
          id: "gpt-5.6-sol",
          model: "codex-execution-model",
          displayName: "GPT-5.6 Sol",
          inputModalities: ["text", "image", "unknown"],
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        },
        {
          id: "gpt-5.6-luna",
          model: "gpt-5.6-luna",
          displayName: "GPT-5.6 Luna",
          inputModalities: ["text"],
          supportedReasoningEfforts: [],
        },
      ],
    });
    const catalog = await loadCodexAppServerModelCatalog(catalogParams, undefined);
    expect(catalog).toEqual([
      {
        provider: "openai",
        nativeRuntime: "codex",
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        providerOrder: 0,
        reasoning: true,
        input: ["text", "image"],
        params: { codexAppServerRuntimeModel: "codex-execution-model" },
        compat: {
          supportsReasoningEffort: true,
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        },
      },
      {
        provider: "openai",
        nativeRuntime: "codex",
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        providerOrder: 1,
        reasoning: false,
        input: ["text"],
        compat: {
          supportsReasoningEffort: false,
          supportedReasoningEfforts: [],
        },
      },
    ]);
    expect(listModelsMock).toHaveBeenCalledExactlyOnceWith({
      request: rpc.request,
      limit: 100,
      includeHidden: true,
    });
  });

  it("returns no rows without a live call when discovery is disabled", async () => {
    expect(
      await loadCodexAppServerModelCatalog(catalogParams, { discovery: { enabled: false } }),
    ).toEqual([]);
    expect(listModelsMock).not.toHaveBeenCalled();
  });

  it("discovers configured hidden models without exposing other hidden models or readiness", async () => {
    const models = ["visible", "configured", "other-agent", "unconfigured", "other-provider"].map(
      (name) => ({
        id: `synthetic-${name}`,
        model: `synthetic-${name}`,
        hidden: name !== "visible",
        inputModalities: ["text"],
        supportedReasoningEfforts: ["high", "ultra"],
      }),
    );
    listModelsMock.mockImplementation(async (options) => ({
      models: models.filter((model) => options?.includeHidden || !model.hidden),
    }));
    const params = {
      ...catalogParams,
      configuredModelRefs: [
        { provider: "openai", model: "synthetic-configured" },
        { provider: "another", model: "synthetic-other-provider" },
      ],
    };
    const catalog = await owner.load(params, undefined);
    expect(catalog.map((model) => model.id)).toEqual(["synthetic-visible", "synthetic-configured"]);
    expect(catalog[1]).toMatchObject({
      nativeRuntime: "codex",
      reasoning: true,
      compat: { supportedReasoningEfforts: ["high", "ultra"] },
    });
    expect(catalog[1]?.api).toBeUndefined();
    for (const model of models) {
      expect(read({ modelId: model.id })).toEqual(
        model.id === "synthetic-visible" || model.id === "synthetic-configured"
          ? { accountType: "apiKey" }
          : undefined,
      );
    }
    await owner.load({ ...params, configuredModelRefs: [] }, undefined);
    expect(read({ modelId: "synthetic-configured" })).toBeUndefined();
  });

  it("bounds the live call with the configured discovery timeout", async () => {
    listModelsMock.mockResolvedValue({ models: [] });
    await loadCodexAppServerModelCatalog(catalogParams, { discovery: { timeoutMs: 750 } });
    expect(withCodexAppServerJsonClient).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ timeoutMs: 750 }),
      expect.any(Function),
    );
  });
  it.each([
    { account: { type: "apiKey" }, mode: "apiKey" },
    {
      account: { type: "chatgpt", email: "synthetic@example.test", planType: "plus" },
      mode: "chatgpt",
    },
    { account: null, mode: undefined },
  ])("preserves account mode $mode without importing credentials", async ({ account, mode }) => {
    listModelsMock.mockResolvedValue({
      models: [
        {
          id: "synthetic-opaque",
          model: "synthetic-opaque",
          inputModalities: ["text"],
          supportedReasoningEfforts: [],
        },
      ],
    });
    rpc.request.mockResolvedValue({ account, requiresOpenaiAuth: true });
    await owner.load(catalogParams, undefined);
    expect(read()).toEqual(mode ? { accountType: mode } : undefined);
    expect(read({ agentId: "another" })).toBeUndefined();
    expect(read({ agentDir: "/tmp/another-agent" })).toBeUndefined();
    expect(read({ workspaceDir: "/tmp/another-workspace" })).toBeUndefined();
    expect(read({ config: { ...catalogParams.config } })).toBeUndefined();
    expect(read({ modelId: "unlisted" })).toBeUndefined();
    expect(read({ provider: "another" })).toBeUndefined();
    expect(
      owner.read({ ...catalogParams, provider: "openai", modelId: "synthetic-opaque" }, {}),
    ).toBeUndefined();
    rpc.epoch += 1;
    expect(read()).toBeUndefined();
  });

  it("revokes prior readiness on failed or disabled refresh", async () => {
    listModelsMock.mockResolvedValue({
      models: [
        {
          id: "synthetic-opaque",
          model: "synthetic-opaque",
          inputModalities: ["text"],
          supportedReasoningEfforts: [],
        },
      ],
    });
    await owner.load(catalogParams, undefined);
    expect(read()).toEqual({ accountType: "apiKey" });
    rpc.request.mockRejectedValueOnce(new Error("synthetic account failure"));
    await expect(owner.load(catalogParams, undefined)).rejects.toThrow("synthetic account failure");
    expect(read()).toBeUndefined();
    await owner.load(catalogParams, undefined);
    await owner.load(catalogParams, { discovery: { enabled: false } });
    expect(read()).toBeUndefined();
  });

  it("cannot publish superseded or disposed asynchronous observations", async () => {
    listModelsMock.mockResolvedValue({
      models: [
        {
          id: "synthetic-opaque",
          model: "synthetic-opaque",
          inputModalities: ["text"],
          supportedReasoningEfforts: [],
        },
      ],
    });
    const pending = createDeferred<unknown>();
    rpc.request.mockReturnValueOnce(pending.promise);
    const older = owner.load(catalogParams, undefined);
    await vi.waitFor(() => expect(rpc.request).toHaveBeenCalledOnce());
    expect(read()).toBeUndefined();
    await owner.load(catalogParams, undefined);
    pending.resolve({ account: { type: "chatgpt" }, requiresOpenaiAuth: true });
    expect(await older).toEqual([]);
    expect(read()).toEqual({ accountType: "apiKey" });
    const disposed = createDeferred<unknown>();
    rpc.request.mockReturnValueOnce(disposed.promise);
    const late = owner.load(catalogParams, undefined);
    await vi.waitFor(() => expect(rpc.request).toHaveBeenCalledTimes(3));
    owner.dispose();
    disposed.resolve({ account: { type: "apiKey" }, requiresOpenaiAuth: true });
    expect(await late).toEqual([]);
    expect(read()).toBeUndefined();
  });
});
