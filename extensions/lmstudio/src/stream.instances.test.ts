import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { afterEach, expect, it, vi } from "vitest";
import { wrapLmstudioInferencePreload } from "./stream.js";

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: async ({ url, init }: { url: string; init?: RequestInit }) => ({
    response: await fetch(url, init),
    release: async () => undefined,
  }),
}));

vi.mock("./runtime.js", () => ({
  buildLmstudioAuthHeaders: () => ({ "Content-Type": "application/json" }),
  resolveLmstudioRuntimeApiKey: async () => undefined,
  resolveLmstudioProviderHeaders: async () => undefined,
}));

afterEach(() => vi.unstubAllGlobals());

it.each([
  { needsLoad: false, replacePayload: false },
  { needsLoad: true, replacePayload: false },
  { needsLoad: false, replacePayload: true },
])(
  "routes inference to the matching instance with stable identity (load=$needsLoad, replace=$replacePayload)",
  async ({ needsLoad, replacePayload }) => {
    const key = "qwen3.5-0.8b";
    const instanceId = "openclaw-long-context";
    const calls: Array<{ path: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({
          path: new URL(url).pathname,
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        });
        if (url.endsWith("/api/v1/models/load")) {
          return Response.json({ status: "loaded", instance_id: instanceId });
        }
        return Response.json({
          models: [
            {
              type: "llm",
              key,
              max_context_length: 262144,
              loaded_instances: [
                { id: key, config: { context_length: 4096 } },
                ...(!needsLoad ? [{ id: instanceId, config: { context_length: 16384 } }] : []),
              ],
            },
          ],
        });
      }),
    );
    const payload: Record<string, unknown> = { model: key };
    const observed = vi.fn();
    let dispatched: unknown;
    const streamFn: StreamFn = async (model, _context, options) => {
      observed(model);
      dispatched = (await options?.onPayload?.(payload, model)) ?? payload;
      const stream = createAssistantMessageEventStream();
      stream.end();
      return stream;
    };
    const baseUrl = `http://instance-${needsLoad}-${replacePayload}.localhost:1234/v1`;
    const wrapped = wrapLmstudioInferencePreload({
      provider: "lmstudio",
      modelId: key,
      config: { models: { providers: { lmstudio: { baseUrl, models: [] } } } },
      streamFn,
    });
    const model: Parameters<StreamFn>[0] = {
      id: key,
      name: "Qwen3.5 0.8B",
      provider: "lmstudio",
      api: "openai-completions",
      baseUrl,
      contextWindow: 262144,
      contextTokens: 16384,
      maxTokens: 8192,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const onPayload = vi.fn(async () =>
      replacePayload ? { model: key, temperature: 0.25 } : undefined,
    );
    await wrapped(model, { messages: [] }, { onPayload });
    expect(dispatched).toEqual({
      model: instanceId,
      ...(replacePayload ? { temperature: 0.25 } : {}),
    });
    expect(model.id).toBe(key);
    expect(observed.mock.calls[0]?.[0].id).toBe(key);
    expect(onPayload).toHaveBeenCalledWith(payload, expect.objectContaining({ id: key }));
    expect(calls.filter((call) => call.path.endsWith("/load"))).toEqual(
      needsLoad
        ? [{ path: "/api/v1/models/load", body: { model: key, context_length: 16384 } }]
        : [],
    );
  },
);
