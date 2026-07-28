import { describe, expect, it, vi } from "vitest";
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
      expect(request).toHaveBeenCalledWith("chat.metadata", {
        agentId: "main",
      }),
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
});
