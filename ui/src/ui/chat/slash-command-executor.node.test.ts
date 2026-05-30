// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  createResolvedModelPatch,
  createModelCatalog,
  DEEPSEEK_CHAT_MODEL,
  OPENAI_GPT5_MINI_MODEL,
} from "../chat-model.test-helpers.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../types.ts";
import { executeSlashCommand } from "./slash-command-executor.ts";

function row(key: string, overrides?: Partial<GatewaySessionRow>): GatewaySessionRow {
  return {
    key,
    spawnedBy: overrides?.spawnedBy,
    kind: "direct",
    updatedAt: null,
    ...overrides,
  };
}

function requireRequestCall(
  request: ReturnType<typeof vi.fn>,
  method: string,
): { method: string; payload: Record<string, unknown> } {
  const call = request.mock.calls.find(([calledMethod]) => calledMethod === method);
  if (!call) {
    throw new Error(`expected ${method} request`);
  }
  return { method: call[0] as string, payload: call[1] as Record<string, unknown> };
}

function expectNoRequestCall(request: ReturnType<typeof vi.fn>, method: string) {
  expect(request.mock.calls.some(([calledMethod]) => calledMethod === method)).toBe(false);
}

describe("executeSlashCommand directives", () => {
  it("resolves the legacy main alias for bare /model", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          defaults: { modelProvider: "openai", model: "default-model" },
          sessions: [
            row("agent:main:main", {
              model: "gpt-4.1-mini",
            }),
          ],
        };
      }
      if (method === "models.list") {
        return {
          models: [{ id: "gpt-4.1-mini" }, { id: "gpt-4.1" }],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "main",
      "model",
      "",
    );

    expect(result.content).toBe(
      "**Current model:** `gpt-4.1-mini`\n**Available:** `gpt-4.1-mini`, `gpt-4.1`",
    );
    expect(request).toHaveBeenNthCalledWith(1, "sessions.list", {});
    expect(request).toHaveBeenNthCalledWith(2, "models.list", { view: "configured" });
  });

  it("mirrors resolved provider-qualified model refs after /model changes", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.patch") {
        return createResolvedModelPatch("gpt-5-mini", "openai");
      }
      if (method === "models.list") {
        return { models: createModelCatalog(OPENAI_GPT5_MINI_MODEL) };
      }
      if (method === "models.list") {
        return { models: [{ id: "gpt-5-mini", name: "gpt-5-mini", provider: "openai" }] };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "main",
      "model",
      "gpt-5-mini",
      {
        chatModelCatalog: [{ id: "gpt-5-mini", name: "gpt-5-mini", provider: "openai" }],
      },
    );

    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "main",
      model: "gpt-5-mini",
    });
    expect(result.sessionPatch?.modelOverride).toEqual({
      kind: "qualified",
      value: "openai/gpt-5-mini",
    });
  });

  it("passes selected-agent scope for global model changes", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.patch") {
        return createResolvedModelPatch("gpt-5-mini", "openai");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "global",
      "model",
      "gpt-5-mini",
      {
        agentId: "work",
        chatModelCatalog: [{ id: "gpt-5-mini", name: "gpt-5-mini", provider: "openai" }],
      },
    );

    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "global",
      agentId: "work",
      model: "gpt-5-mini",
    });
  });

  it("passes selected-agent scope for global compaction", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.compact") {
        return { ok: true, compacted: false };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "global",
      "compact",
      "",
      { agentId: "work" },
    );

    expect(request).toHaveBeenCalledWith("sessions.compact", {
      key: "global",
      agentId: "work",
    });
  });

  it("uses the local model catalog to qualify raw /model overrides when the patch response omits provider", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.patch") {
        return {
          ok: true,
          key: "main",
          resolved: {
            model: "gpt-5-mini",
          },
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "main",
      "model",
      "gpt-5-mini",
      {
        chatModelCatalog: [{ id: "gpt-5-mini", name: "GPT-5 Mini", provider: "openai" }],
      },
    );

    expect(result.sessionPatch?.modelOverride).toEqual({
      kind: "qualified",
      value: "openai/gpt-5-mini",
    });
  });

  it("corrects stale patched providers with the catalog after /model", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.patch") {
        return createResolvedModelPatch("deepseek-chat", "zai");
      }
      if (method === "models.list") {
        return { models: createModelCatalog(DEEPSEEK_CHAT_MODEL) };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "main",
      "model",
      "deepseek-chat",
    );

    expect(result.sessionPatch?.modelOverride).toEqual({
      kind: "qualified",
      value: "deepseek/deepseek-chat",
    });
  });

  it("keeps openrouter-prefixed refs when patched model ids include slashes", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.patch") {
        return createResolvedModelPatch("google/gemma-4-26b-a4b-it", "openrouter");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "main",
      "model",
      "google/gemma-4-26b-a4b-it",
      {
        chatModelCatalog: [
          {
            id: "google/gemma-4-26b-a4b-it",
            name: "Gemma 4 26B",
            provider: "openrouter",
          },
        ],
      },
    );

    expect(result.sessionPatch?.modelOverride).toEqual({
      kind: "qualified",
      value: "openrouter/google/gemma-4-26b-a4b-it",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("falls back to the patched server provider when catalog lookup fails", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.patch") {
        return createResolvedModelPatch("gpt-5-mini", "openai");
      }
      if (method === "models.list") {
        throw new Error("models unavailable");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "main",
      "model",
      "gpt-5-mini",
    );

    expect(result.sessionPatch?.modelOverride).toEqual({
      kind: "qualified",
      value: "openai/gpt-5-mini",
    });
  });

  it("keeps provider-qualified nested ids when the patched catalog lookup fails", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.patch") {
        return createResolvedModelPatch("moonshotai/kimi-k2.5", "nvidia");
      }
      if (method === "models.list") {
        throw new Error("models unavailable");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "main",
      "model",
      "nvidia/moonshotai/kimi-k2.5",
    );

    expect(result.sessionPatch?.modelOverride).toEqual({
      kind: "qualified",
      value: "nvidia/moonshotai/kimi-k2.5",
    });
  });

  it("reuses a provided model catalog for /model updates without refetching", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.patch") {
        return createResolvedModelPatch("gpt-5-mini", "openai");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "main",
      "model",
      "gpt-5-mini",
      { modelCatalog: createModelCatalog(OPENAI_GPT5_MINI_MODEL) },
    );

    expect(result.sessionPatch?.modelOverride).toEqual({
      kind: "qualified",
      value: "openai/gpt-5-mini",
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalledWith("models.list", {});
  });
  it("resolves the legacy main alias for /usage", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          sessions: [
            row("agent:main:main", {
              model: "gpt-4.1-mini",
              inputTokens: 1200,
              outputTokens: 300,
              totalTokens: 1500,
              contextTokens: 4000,
            }),
          ],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "main",
      "usage",
      "",
    );

    expect(result.content).toBe(
      "**Session Usage**\nInput: **1.2k** tokens\nOutput: **300** tokens\nTotal: **1.5k** tokens\nContext: **38%** of 4k\nModel: `gpt-4.1-mini`",
    );
    expect(request).toHaveBeenNthCalledWith(1, "sessions.list", {});
  });

  it("keeps /usage context hidden when the context snapshot is stale", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          sessions: [
            row("agent:main:main", {
              model: "gpt-4.1-mini",
              inputTokens: 1200,
              outputTokens: 300,
              totalTokens: 1500,
              totalTokensFresh: false,
              contextTokens: 4000,
            }),
          ],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "usage",
      "",
    );

    expect(result.content).toBe(
      "**Session Usage**\nInput: **1.2k** tokens\nOutput: **300** tokens\nTotal: **~1.5k** tokens\nModel: `gpt-4.1-mini`",
    );
    expect(request).toHaveBeenNthCalledWith(1, "sessions.list", {});
  });

  it("uses the context snapshot for /usage while preserving cumulative total display", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          sessions: [
            row("agent:main:main", {
              model: "gpt-4.1-mini",
              inputTokens: 1200,
              outputTokens: 300,
              totalTokens: 1250,
              contextTokens: 4000,
            }),
          ],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "usage",
      "",
    );

    expect(result.content).toBe(
      "**Session Usage**\nInput: **1.2k** tokens\nOutput: **300** tokens\nTotal: **1.5k** tokens\nContext: **31%** of 4k\nModel: `gpt-4.1-mini`",
    );
    expect(request).toHaveBeenNthCalledWith(1, "sessions.list", {});
  });

  it("reports the current thinking level for bare /think", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          sessions: [
            row("agent:main:main", {
              modelProvider: "openai",
              model: "gpt-4.1-mini",
            }),
          ],
        };
      }
      if (method === "models.list") {
        return {
          models: [{ id: "gpt-4.1-mini", provider: "openai", reasoning: true }],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "think",
      "",
    );

    expect(result.content).toBe(
      "Current thinking level: low.\nOptions: default, off, minimal, low, medium, high.",
    );
    expect(request).toHaveBeenNthCalledWith(1, "sessions.list", {});
    expect(request).toHaveBeenNthCalledWith(2, "models.list", { view: "configured" });
  });

  it("accepts minimal and xhigh thinking levels", async () => {
    const request = vi.fn(async (method: string, payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          sessions: [
            row("agent:main:main", {
              thinkingOptions: ["off", "minimal", "low", "medium", "high", "xhigh"],
            }),
          ],
        };
      }
      if (method === "sessions.patch") {
        return { ok: true, ...((payload ?? {}) as object) };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const minimal = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "think",
      "minimal",
    );
    const xhigh = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "think",
      "xhigh",
    );

    expect(minimal.content).toBe("Thinking level set to **minimal**.");
    expect(xhigh.content).toBe("Thinking level set to **xhigh**.");
    expect(request).toHaveBeenNthCalledWith(1, "sessions.list", {});
    expect(request).toHaveBeenNthCalledWith(2, "sessions.patch", {
      key: "agent:main:main",
      thinkingLevel: "minimal",
    });
    expect(request).toHaveBeenNthCalledWith(3, "sessions.list", {});
    expect(request).toHaveBeenNthCalledWith(4, "sessions.patch", {
      key: "agent:main:main",
      thinkingLevel: "xhigh",
    });
  });

  it("clears thinking override for /think default", async () => {
    const request = vi.fn(async (method: string, payload?: unknown) => {
      if (method === "sessions.patch") {
        return { ok: true, ...((payload ?? {}) as object) };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "think",
      "default",
    );

    expect(result.content).toBe("Thinking level reset to default.");
    expect(result.action).toBe("refresh");
    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "agent:main:main",
      thinkingLevel: null,
    });
  });

  it("uses default thinking options when the active session is absent", async () => {
    const request = vi.fn(async (method: string, payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          defaults: {
            modelProvider: "openai-codex",
            model: "gpt-5.5",
            thinkingLevels: [
              { id: "off", label: "off" },
              { id: "minimal", label: "minimal" },
              { id: "low", label: "low" },
              { id: "medium", label: "medium" },
              { id: "adaptive", label: "adaptive" },
              { id: "high", label: "high" },
              { id: "xhigh", label: "xhigh" },
              { id: "max", label: "maximum" },
            ],
            thinkingOptions: [
              "off",
              "minimal",
              "low",
              "medium",
              "adaptive",
              "high",
              "xhigh",
              "maximum",
            ],
            thinkingDefault: "adaptive",
          },
          sessions: [],
        };
      }
      if (method === "models.list") {
        return {
          models: [{ id: "gpt-5.5", provider: "openai-codex", reasoning: true }],
        };
      }
      if (method === "sessions.patch") {
        return { ok: true, ...((payload ?? {}) as object) };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const status = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "think",
      "",
    );
    const setXhigh = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "think",
      "xhigh",
    );
    const setMax = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "think",
      "max",
    );
    const setMaximum = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "think",
      "maximum",
    );
    const setAdaptive = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "think",
      "auto",
    );

    expect(status.content).toBe(
      "Current thinking level: adaptive.\nOptions: default, off, minimal, low, medium, adaptive, high, xhigh, maximum.",
    );
    expect(setXhigh.content).toBe("Thinking level set to **xhigh**.");
    expect(setMax.content).toBe("Thinking level set to **max**.");
    expect(setMaximum.content).toBe("Thinking level set to **max**.");
    expect(setAdaptive.content).toBe("Thinking level set to **adaptive**.");
    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "agent:main:main",
      thinkingLevel: "xhigh",
    });
    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "agent:main:main",
      thinkingLevel: "max",
    });
    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "agent:main:main",
      thinkingLevel: "adaptive",
    });
  });

  it("prefers session model over defaults when models differ (#76482)", async () => {
    const request = vi.fn(async (method: string, payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          defaults: {
            modelProvider: "anthropic",
            model: "claude-sonnet-4-6",
            thinkingLevels: [
              { id: "off", label: "off" },
              { id: "minimal", label: "minimal" },
              { id: "low", label: "low" },
              { id: "medium", label: "medium" },
              { id: "high", label: "high" },
            ],
            thinkingOptions: ["off", "minimal", "low", "medium", "high"],
            thinkingDefault: "off",
          },
          sessions: [
            row("agent:main:main", {
              modelProvider: "deepseek",
              model: "deepseek-v4-pro",
              thinkingLevels: [
                { id: "off", label: "off" },
                { id: "minimal", label: "minimal" },
                { id: "low", label: "low" },
                { id: "medium", label: "medium" },
                { id: "high", label: "high" },
                { id: "xhigh", label: "xhigh" },
                { id: "max", label: "max" },
              ],
            }),
          ],
        };
      }
      if (method === "models.list") {
        return {
          models: [{ id: "deepseek-v4-pro", provider: "deepseek", reasoning: true }],
        };
      }
      if (method === "sessions.patch") {
        return { ok: true, ...((payload ?? {}) as object) };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const status = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "think",
      "",
    );
    const setMax = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "think",
      "max",
    );

    expect(status.content).toBe(
      "Current thinking level: off.\nOptions: default, off, minimal, low, medium, high, xhigh, max.",
    );
    expect(setMax.content).toBe("Thinking level set to **max**.");
  });

  it("does not use extended defaults for session with different model when thinkingLevels is empty (#76482)", async () => {
    // Regression: when session model differs from defaults and session has no thinkingLevels,
    // we should NOT blindly use defaults (which could have extra levels like xhigh/max
    // from a different model). The client-side fallback uses the base thinking levels.
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          defaults: {
            modelProvider: "deepseek",
            model: "deepseek-v4-pro",
            thinkingLevels: [
              { id: "off", label: "off" },
              { id: "minimal", label: "minimal" },
              { id: "low", label: "low" },
              { id: "medium", label: "medium" },
              { id: "high", label: "high" },
              { id: "xhigh", label: "xhigh" },
              { id: "max", label: "max" },
            ],
            thinkingOptions: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
            thinkingDefault: "high",
          },
          sessions: [
            row("agent:main:main", {
              modelProvider: "anthropic",
              model: "claude-sonnet-4-6",
              // thinkingLevels intentionally absent — lightweight row
            }),
          ],
        };
      }
      if (method === "models.list") {
        return {
          models: [{ id: "claude-sonnet-4-6", provider: "anthropic", reasoning: true }],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const status = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "think",
      "",
    );

    expect(status.content).toBe(
      "Current thinking level: high.\nOptions: default, off, minimal, low, medium, high.",
    );
  });

  it("reports the current verbose level for bare /verbose", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          sessions: [row("agent:main:main", { verboseLevel: "full" })],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "verbose",
      "",
    );

    expect(result.content).toBe("Current verbose level: full.\nOptions: on, full, off.");
    expect(request).toHaveBeenNthCalledWith(1, "sessions.list", {});
  });

  it("reports the current fast mode for bare /fast", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          sessions: [row("agent:main:main", { fastMode: true })],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "fast",
      "",
    );

    expect(result.content).toBe("Current fast mode: on.\nOptions: status, on, off, default.");
    expect(request).toHaveBeenNthCalledWith(1, "sessions.list", {});
  });

  it("patches fast mode for /fast on", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "fast",
      "on",
    );

    expect(result.content).toBe("Fast mode enabled.");
    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "agent:main:main",
      fastMode: true,
    });
  });

  it("clears fast mode override for /fast default", async () => {
    const request = vi.fn(async (method: string, payload?: unknown) => {
      if (method === "sessions.patch") {
        return { ok: true, ...((payload ?? {}) as object) };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "fast",
      "default",
    );

    expect(result.content).toBe("Fast mode reset to default.");
    expect(result.action).toBe("refresh");
    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "agent:main:main",
      fastMode: null,
    });
  });
});

describe("executeSlashCommand /steer (soft inject)", () => {
  it("injects into the current session via chat.send with deliver: false", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return { sessions: [row("agent:main:main", { status: "running" })] };
      }
      if (method === "chat.send") {
        return { status: "started", runId: "run-1", messageSeq: 2 };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "steer",
      "try a different approach",
    );

    expect(result.content).toBe("Steered.");
    const chatSend = requireRequestCall(request, "chat.send");
    expect(chatSend.payload.sessionKey).toBe("agent:main:main");
    expect(chatSend.payload.message).toBe("try a different approach");
    expect(chatSend.payload.deliver).toBe(false);
  });

  it("passes selected-agent scope when steering the selected global session", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return { sessions: [row("global", { status: "running" })] };
      }
      if (method === "chat.send") {
        return { status: "started", runId: "run-global", messageSeq: 2 };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "global",
      "steer",
      "try a different approach",
      { agentId: "work" },
    );

    expect(result.content).toBe("Steered.");
    expect(request).toHaveBeenCalledWith("sessions.list", { agentId: "work" });
    const chatSend = requireRequestCall(request, "chat.send");
    expect(chatSend.payload).toMatchObject({
      sessionKey: "global",
      agentId: "work",
      message: "try a different approach",
      deliver: false,
    });
  });

  it("passes selected-agent scope when steering a selected-global alias", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return { sessions: [row("global", { status: "running" })] };
      }
      if (method === "chat.send") {
        return { status: "started", runId: "run-global", messageSeq: 2 };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:work:main",
      "steer",
      "try the alias",
    );

    expect(result.content).toBe("Steered.");
    expect(request).toHaveBeenCalledWith("sessions.list", { agentId: "work" });
    const chatSend = requireRequestCall(request, "chat.send");
    expect(chatSend.payload).toMatchObject({
      sessionKey: "agent:work:main",
      agentId: "work",
      message: "try the alias",
      deliver: false,
    });
  });

  it("uses cached sessions to avoid an extra sessions.list round trip", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "chat.send") {
        return { status: "started", runId: "run-2", messageSeq: 1 };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "steer",
      "researcher try a different approach",
      {
        sessionsResult: {
          sessions: [
            row("agent:main:main", { status: "running" }),
            row("agent:main:subagent:researcher", {
              spawnedBy: "agent:main:main",
              status: "running",
            }),
          ],
        } as SessionsListResult,
      },
    );

    expect(result.content).toBe("Steered.");
    expect(request).toHaveBeenCalledTimes(1);
    const chatSend = requireRequestCall(request, "chat.send");
    expect(chatSend.payload.sessionKey).toBe("agent:main:main");
    expect(chatSend.payload.message).toBe("researcher try a different approach");
    expect(chatSend.payload.deliver).toBe(false);
  });

  it("does not treat 'all' as a subagent wildcard", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return { sessions: [row("agent:main:main", { status: "running" })] };
      }
      if (method === "chat.send") {
        return { status: "started", runId: "run-3", messageSeq: 1 };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "steer",
      "all good now",
    );

    expect(result.content).toBe("Steered.");
    const chatSend = requireRequestCall(request, "chat.send");
    expect(chatSend.payload.sessionKey).toBe("agent:main:main");
    expect(chatSend.payload.message).toBe("all good now");
    expect(chatSend.payload.deliver).toBe(false);
  });

  it("does not match agent id as target — treats 'main' as message text", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          sessions: [
            row("agent:main:main", { status: "running" }),
            row("agent:main:subagent:researcher", { spawnedBy: "agent:main:main" }),
          ],
        };
      }
      if (method === "chat.send") {
        return { status: "started", runId: "run-4", messageSeq: 1 };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "steer",
      "main refine the plan",
    );

    expect(result.content).toBe("Steered.");
    const chatSend = requireRequestCall(request, "chat.send");
    expect(chatSend.payload.sessionKey).toBe("agent:main:main");
    expect(chatSend.payload.message).toBe("main refine the plan");
    expect(chatSend.payload.deliver).toBe(false);
  });

  it("treats subagent-looking prefixes as current-session message text", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          sessions: [
            row("agent:main:main", { status: "running" }),
            row("agent:main:subagent:researcher", {
              spawnedBy: "agent:main:main",
              endedAt: Date.now() - 60_000,
            }),
          ],
        };
      }
      if (method === "chat.send") {
        return { status: "started", runId: "run-5", messageSeq: 1 };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "steer",
      "researcher try again",
    );

    expect(result.content).toBe("Steered.");
    const chatSend = requireRequestCall(request, "chat.send");
    expect(chatSend.payload.sessionKey).toBe("agent:main:main");
    expect(chatSend.payload.message).toBe("researcher try again");
    expect(chatSend.payload.deliver).toBe(false);
  });

  it("returns a no-op summary when the current session has no active run", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return { sessions: [row("agent:main:main", { status: "done", endedAt: Date.now() })] };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "steer",
      "try again",
    );

    expect(result.content).toBe("No active run. Use the chat input or `/redirect` instead.");
    expect(request).toHaveBeenCalledWith("sessions.list", {});
    expectNoRequestCall(request, "chat.send");
  });

  it("returns steer usage when no message is provided", async () => {
    const request = vi.fn();

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "steer",
      "",
    );

    expect(result.content).toBe("Usage: `/steer <message>`");
    expect(request).not.toHaveBeenCalled();
  });

  it("returns steer error message on RPC failure", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return { sessions: [row("agent:main:main", { status: "running" })] };
      }
      throw new Error("connection lost");
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "steer",
      "try again",
    );

    expect(result.content).toBe("Failed to steer: Error: connection lost");
  });
});

describe("executeSlashCommand /redirect (hard kill-and-restart)", () => {
  it("calls sessions.steer to abort and restart the current session", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return { sessions: [row("agent:main:main")] };
      }
      if (method === "sessions.steer") {
        return { status: "started", runId: "run-1", messageSeq: 2, interruptedActiveRun: true };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "redirect",
      "start over with a new plan",
    );

    expect(result.content).toBe("Redirected.");
    expect(result.trackRunId).toBe("run-1");
    expect(request).toHaveBeenCalledWith("sessions.steer", {
      key: "agent:main:main",
      message: "start over with a new plan",
    });
  });

  it("passes selected-agent scope when redirecting the selected global session", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.steer") {
        return { status: "started", runId: "run-global", messageSeq: 2 };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "global",
      "redirect",
      "start over",
      { agentId: "work" },
    );

    expect(result.content).toBe("Redirected.");
    expect(result.trackRunId).toBe("run-global");
    expect(request).toHaveBeenCalledWith("sessions.steer", {
      key: "global",
      agentId: "work",
      message: "start over",
    });
  });

  it("treats subagent-looking redirect prefixes as current-session message text", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.steer") {
        return { status: "started", runId: "run-3", messageSeq: 1 };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "redirect",
      "researcher start over completely",
    );

    expect(result.content).toBe("Redirected.");
    expect(result.trackRunId).toBe("run-3");
    expect(request).toHaveBeenCalledWith("sessions.steer", {
      key: "agent:main:main",
      message: "researcher start over completely",
    });
  });

  it("returns redirect usage when no message is provided", async () => {
    const request = vi.fn();

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "redirect",
      "",
    );

    expect(result.content).toBe("Usage: `/redirect <message>`");
    expect(request).not.toHaveBeenCalled();
  });

  it("returns redirect error message on RPC failure", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return { sessions: [row("agent:main:main")] };
      }
      throw new Error("connection lost");
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "redirect",
      "try again",
    );

    expect(result.content).toBe("Failed to redirect: Error: connection lost");
  });
});
