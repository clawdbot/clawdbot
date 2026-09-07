import { DatabaseSync } from "node:sqlite";
import { defaultLlmRuntime } from "@openclaw/ai/internal/runtime";
import { afterEach, expect, it, vi } from "vitest";
import type { AcquiredSimpleCompletionModelForAgent } from "../agents/simple-completion-runtime.js";
import { bindModelLlmRuntime } from "../llm/model-runtime-binding.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  createPluginRegistryResourceOwner,
  getPluginRegistryResourceScope,
  registerPluginRegistryResourceDisposer,
  drainPluginRegistryResourceDisposals,
} from "../plugins/registry-resources.js";
import { createDeferredCore } from "../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";

const acquire = vi.hoisted(() => vi.fn());
const complete = vi.hoisted(() => vi.fn());
vi.mock("../agents/simple-completion-runtime.js", () => ({
  acquireSimpleCompletionModelForAgent: acquire,
}));
vi.mock("../agents/simple-completion-execution.js", () => ({
  completeWithPreparedSimpleCompletionModelCore: complete,
}));
vi.mock("../agents/embedded-agent-utils.js", () => ({ extractEmbeddedAssistantText: vi.fn() }));
vi.mock("../agents/host-prepared-isolated-completion.js", () => ({
  runHostPreparedIsolatedCompletion: vi.fn(),
}));

import {
  acquireSimpleCompletionModelForAgent,
  completeWithPreparedSimpleCompletionModel,
  prepareSimpleCompletionModelForAgent,
} from "./simple-completion-runtime.js";

function createPrepared() {
  return {
    release: vi.fn(),
    model: {
      provider: "synthetic",
      id: "completion",
      name: "Completion",
      api: "openai-completions",
      baseUrl: "https://completion.example",
      input: ["text"],
      reasoning: false,
      contextWindow: 4096,
      maxTokens: 256,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    auth: { apiKey: "synthetic", mode: "api-key", source: "test" },
    selection: { provider: "synthetic", modelId: "completion", agentDir: "/tmp/synthetic-agent" },
  } satisfies AcquiredSimpleCompletionModelForAgent;
}

afterEach(async () => {
  await drainGlobalSingletonLifecycleState();
  acquire.mockReset();
  complete.mockReset();
});

it("keeps the legacy model alive until host close while acquired models release explicitly", async () => {
  const legacy = createPrepared();
  const owned = createPrepared();
  acquire.mockResolvedValueOnce(legacy).mockResolvedValueOnce(owned);
  const params = { cfg: {}, agentId: "main" };
  const result = await prepareSimpleCompletionModelForAgent(params);
  const handle = await acquireSimpleCompletionModelForAgent(params);
  expect(result).not.toHaveProperty("release");
  expect(result).toMatchObject({ model: legacy.model, auth: legacy.auth });
  if ("error" in handle) {
    throw new Error(handle.error);
  }
  handle.release();
  expect(owned.release).toHaveBeenCalledOnce();
  expect(legacy.release).not.toHaveBeenCalled();
  await drainGlobalSingletonLifecycleState("plugin-registry");
  expect(legacy.release).not.toHaveBeenCalled();
  await drainGlobalSingletonLifecycleState("restart");
  expect(legacy.release).toHaveBeenCalledOnce();
});

it("releases a late preparation instead of attaching it to a restarted SDK host", async () => {
  const prepared = createPrepared();
  const pending = createDeferredCore<typeof prepared>();
  acquire.mockReturnValueOnce(pending.promise);
  const result = prepareSimpleCompletionModelForAgent({ cfg: {}, agentId: "main" });
  const rejected = expect(result).rejects.toThrow("host is closed");
  const closing = drainGlobalSingletonLifecycleState("restart");
  pending.resolve(prepared);
  await rejected;
  await closing;
  expect(prepared.release).toHaveBeenCalledOnce();
});

it("drains bare-model completion before closing its SDK-owned SQLite registration", async () => {
  const db = new DatabaseSync(":memory:");
  const pending = createDeferredCore();
  complete.mockImplementation(async () => {
    const resources = getPluginRegistryResourceScope();
    if (!resources) {
      throw new Error("Missing completion resource owner");
    }
    const registry = createEmptyPluginRegistry();
    const claim = createPluginRegistryResourceOwner(registry, "scoped");
    registerPluginRegistryResourceDisposer(registry, "synthetic-completion", {
      id: "synthetic-completion",
      dispose: () => db.close(),
    });
    resources.adopt({ registry, release: claim.release });
    await pending.promise;
    return db.prepare("SELECT 42 AS value").get();
  });
  try {
    const prepared = createPrepared();
    const result = completeWithPreparedSimpleCompletionModel({
      model: prepared.model,
      auth: prepared.auth,
      context: { messages: [] },
    });
    const closing = drainGlobalSingletonLifecycleState("restart");
    expect(db.isOpen).toBe(true);
    pending.resolve();
    await expect(result).resolves.toEqual({ value: 42 });
    await closing;
    await drainPluginRegistryResourceDisposals();
    expect(db.isOpen).toBe(false);
  } finally {
    pending.resolve();
    if (db.isOpen) {
      db.close();
    }
  }
});

it("keeps a legacy prepared generation through completion and rejects it after host restart", async () => {
  const prepared = createPrepared();
  const model = bindModelLlmRuntime(prepared.model, defaultLlmRuntime, prepared.model);
  acquire.mockResolvedValueOnce({ ...prepared, model });
  const legacy = await prepareSimpleCompletionModelForAgent({ cfg: {}, agentId: "main" });
  if ("error" in legacy) {
    throw new Error(legacy.error);
  }
  const pending = createDeferredCore();
  complete.mockImplementation(async () => {
    await pending.promise;
    return { content: [{ type: "text", text: "done" }] };
  });
  const request = { model: legacy.model, auth: legacy.auth, context: { messages: [] } };
  const result = completeWithPreparedSimpleCompletionModel(request);
  const closing = drainGlobalSingletonLifecycleState("restart");
  const overlappingClose = drainGlobalSingletonLifecycleState("restart");
  try {
    expect(prepared.release).not.toHaveBeenCalled();
    await expect(
      prepareSimpleCompletionModelForAgent({ cfg: {}, agentId: "main" }),
    ).rejects.toThrow("host is closed");
    expect(acquire).toHaveBeenCalledOnce();
    await expect(completeWithPreparedSimpleCompletionModel(request)).rejects.toThrow(
      "host is closed",
    );
    expect(complete).toHaveBeenCalledOnce();
    pending.resolve();
    await expect(result).resolves.toMatchObject({ content: [{ text: "done" }] });
    await Promise.all([closing, overlappingClose]);
    expect(prepared.release).toHaveBeenCalledOnce();
    const next = createPrepared();
    acquire.mockResolvedValueOnce(next);
    await expect(
      prepareSimpleCompletionModelForAgent({ cfg: {}, agentId: "main" }),
    ).resolves.toMatchObject({ model: next.model });
    expect(acquire).toHaveBeenCalledTimes(2);
    await expect(completeWithPreparedSimpleCompletionModel(request)).rejects.toThrow(
      "host is closed",
    );
  } finally {
    pending.resolve();
    await Promise.allSettled([result, closing, overlappingClose]);
  }
});
