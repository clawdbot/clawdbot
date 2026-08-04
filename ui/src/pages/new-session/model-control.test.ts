import {
  DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
  gatewayStartupUnavailableDetails,
} from "@openclaw/gateway-client/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { GatewayAgentRow, ModelCatalogEntry } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { NewSessionModelControl } from "./model-control.ts";

function contextWith(models: ModelCatalogEntry[], runtime = "openclaw") {
  const request = vi.fn().mockResolvedValue({ models });
  const context = {
    gateway: {
      snapshot: {
        phase: "connected",
        client: { request },
      },
    },
    sessions: {
      state: {
        result: {
          defaults: {
            model: "openai/gpt-5.6-luna",
            modelProvider: "openai",
            agentRuntime: { id: runtime, source: "defaults" },
          },
        },
      },
    },
  } as unknown as ApplicationContext;
  return { context, request };
}

function startupUnavailableError(retryAfterMs = 250): GatewayRequestError {
  return new GatewayRequestError({
    code: "UNAVAILABLE",
    message: "gateway startup sidecars are still initializing",
    details: gatewayStartupUnavailableDetails(),
    retryable: true,
    retryAfterMs,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("new-session model runtime", () => {
  it("restores a browser preference only after the model and thinking level validate", async () => {
    const { context } = contextWith([
      {
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        provider: "openai",
        reasoning: true,
      },
    ]);
    const control = new NewSessionModelControl(() => undefined);

    control.load(context, "main", true, {
      preference: { model: "openai/gpt-5.6-sol", thinkingLevel: "high" },
    });

    expect(control.isRestoringPreference()).toBe(true);
    await vi.waitFor(() => expect(control.selected).toBe("openai/gpt-5.6-sol"));
    expect(control.isRestoringPreference()).toBe(false);
    expect(control.thinkingLevel).toBe("high");
  });

  it("does not mark ordinary catalog loading as preference restoration", async () => {
    const { context, request } = contextWith([
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai", reasoning: true },
    ]);
    const control = new NewSessionModelControl(() => undefined);

    control.load(context, "main", true);

    expect(control.isRestoringPreference()).toBe(false);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  });

  it("preserves the remembered pair when metadata validation fails", async () => {
    const { context, request } = contextWith([]);
    request.mockRejectedValueOnce(new Error("metadata unavailable"));
    const control = new NewSessionModelControl(() => undefined);

    control.load(context, "main", true, {
      preference: { model: "anthropic/claude-sonnet-4-6", thinkingLevel: "high" },
    });

    expect(control.isRestoringPreference()).toBe(true);
    await vi.waitFor(() => expect(control.isRestoringPreference()).toBe(false));
    expect(control.selected).toBe("anthropic/claude-sonnet-4-6");
    expect(control.thinkingLevel).toBe("high");
  });

  it("preserves a live selection when an ordinary metadata refresh fails", async () => {
    const { context, request } = contextWith([]);
    const notify = vi.fn();
    const control = new NewSessionModelControl(notify);
    control.load(context, "main", true);
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledOnce();
      expect(notify).toHaveBeenCalledTimes(2);
    });
    control.selected = "anthropic/claude-sonnet-4-6";
    control.thinkingLevel = "high";
    request.mockRejectedValueOnce(new Error("metadata unavailable"));

    control.load(context, "main", true);

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledTimes(2);
      expect(notify).toHaveBeenCalledTimes(4);
    });
    expect(control.selected).toBe("anthropic/claude-sonnet-4-6");
    expect(control.thinkingLevel).toBe("high");
  });

  it("drops a stored model and its reasoning override when the model is unavailable", async () => {
    const { context, request } = contextWith([
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai", reasoning: true },
    ]);
    const notify = vi.fn();
    const onSelectionChange = vi.fn();
    const control = new NewSessionModelControl(notify, onSelectionChange);

    control.load(context, "main", true, {
      preference: { model: "openai/gpt-5.6-sol", thinkingLevel: "high" },
    });
    await vi.waitFor(() => expect(control.selected).toBe("openai/gpt-5.6-sol"));
    expect(control.thinkingLevel).toBe("high");

    control.load(context, "main", true, {
      preference: { model: "anthropic/retired-model", thinkingLevel: "high" },
    });

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(control.selected).toBe(""));
    expect(control.thinkingLevel).toBe("");
    expect(onSelectionChange).toHaveBeenLastCalledWith({ model: "", thinkingLevel: "" });
  });

  it("drops a stored reasoning override when its option is no longer available", async () => {
    const { context, request } = contextWith([
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai", reasoning: true },
    ]);
    const onSelectionChange = vi.fn();
    const control = new NewSessionModelControl(() => undefined, onSelectionChange);

    control.load(context, "main", true, {
      preference: { model: "openai/gpt-5.6-sol", thinkingLevel: "high" },
    });
    await vi.waitFor(() => expect(control.thinkingLevel).toBe("high"));

    control.load(context, "main", true, {
      preference: { model: "openai/gpt-5.6-sol", thinkingLevel: "retired" },
    });

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(control.thinkingLevel).toBe(""));
    expect(control.selected).toBe("openai/gpt-5.6-sol");
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      model: "openai/gpt-5.6-sol",
      thinkingLevel: "",
    });
  });

  it("uses model catalog runtime metadata for an explicit cloud target", async () => {
    const { context, request } = contextWith([
      {
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        provider: "openai",
        agentRuntime: { id: "codex", source: "model" },
      },
    ]);
    const control = new NewSessionModelControl(() => undefined);
    control.load(context, "main", true);
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "chat.metadata",
        { agentId: "main" },
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      ),
    );
    await vi.waitFor(() => {
      control.selected = "openai/gpt-5.6-luna";
      expect(control.resolveAgentRuntimeId({ context })).toBe("codex");
    });
  });

  it("falls back to the selected agent runtime for its default model", () => {
    const { context } = contextWith([]);
    const agent = {
      id: "main",
      agentRuntime: { id: "claude-cli", source: "agent" },
    } satisfies GatewayAgentRow;
    const control = new NewSessionModelControl(() => undefined);

    expect(control.resolveAgentRuntimeId({ agent, context })).toBe("claude-cli");
  });

  it.each(["auto", "default"])(
    "leaves the %s runtime selector unresolved for server-side policy",
    (runtime) => {
      const { context } = contextWith([], runtime);
      const control = new NewSessionModelControl(() => undefined);

      expect(control.resolveAgentRuntimeId({ context })).toBeUndefined();
    },
  );

  it("does not apply default runtime metadata to an explicit model", async () => {
    const { context } = contextWith(
      [{ id: "sonnet-4.6", name: "Sonnet 4.6", provider: "anthropic" }],
      "codex",
    );
    const control = new NewSessionModelControl(() => undefined);
    control.load(context, "main", true);
    control.selected = "anthropic/sonnet-4.6";

    await vi.waitFor(() => expect(control.resolveAgentRuntimeId({ context })).toBeUndefined());
  });

  it("retries canonical startup-sidecars unavailability and restores the catalog", async () => {
    vi.useFakeTimers();
    const models: ModelCatalogEntry[] = [
      {
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        provider: "openai",
        reasoning: true,
      },
      {
        id: "gpt-5.6-terra",
        name: "GPT-5.6 Terra",
        provider: "openai",
        reasoning: true,
      },
    ];
    const { context, request } = contextWith(models);
    request.mockReset();
    request.mockRejectedValueOnce(startupUnavailableError(250)).mockResolvedValueOnce({ models });
    const control = new NewSessionModelControl(() => undefined);

    control.load(context, "main", true, {
      preference: { model: "openai/gpt-5.6-terra", thinkingLevel: "high" },
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(249);
    expect(request).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(control.selected).toBe("openai/gpt-5.6-terra");
    expect(control.thinkingLevel).toBe("high");
    expect(control.isRestoringPreference()).toBe(false);
  });

  it("does not retry other retryable UNAVAILABLE errors", async () => {
    vi.useFakeTimers();
    const { context, request } = contextWith([]);
    request.mockReset();
    request.mockRejectedValue(
      new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "database temporarily unavailable",
        details: { reason: "database-busy" },
        retryable: true,
        retryAfterMs: 250,
      }),
    );
    const control = new NewSessionModelControl(() => undefined);

    control.load(context, "main", true);

    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(request).toHaveBeenCalledOnce();
  });

  it("aborts a pending startup retry when the catalog task is invalidated", async () => {
    vi.useFakeTimers();
    const { context, request } = contextWith([]);
    request.mockReset();
    request.mockRejectedValue(startupUnavailableError(2_000));
    const control = new NewSessionModelControl(() => undefined);

    control.load(context, "main", true);

    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);

    control.invalidate();
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(request).toHaveBeenCalledOnce();
  });

  it("stops startup-sidecars retries at the 60 second deadline", async () => {
    vi.useFakeTimers();
    const startedAt = Date.UTC(2026, 7, 2);
    vi.setSystemTime(startedAt);
    const { context, request } = contextWith([]);
    const attemptTimes: number[] = [];
    request.mockReset();
    request.mockImplementation(() => {
      attemptTimes.push(Date.now());
      return Promise.reject(startupUnavailableError(2_000));
    });
    const control = new NewSessionModelControl(() => undefined);

    control.load(context, "main", true);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(attemptTimes).toHaveLength(30);
    expect(attemptTimes[0]).toBe(startedAt);
    expect(attemptTimes.at(-1)).toBe(startedAt + 58_000);
    expect(request).toHaveBeenNthCalledWith(
      1,
      "chat.metadata",
      { agentId: "main" },
      {
        signal: expect.any(AbortSignal),
        timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
      },
    );
    expect(request).toHaveBeenLastCalledWith(
      "chat.metadata",
      { agentId: "main" },
      {
        signal: expect.any(AbortSignal),
        timeoutMs: 2_000,
      },
    );
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(request).toHaveBeenCalledTimes(30);
  });
});
