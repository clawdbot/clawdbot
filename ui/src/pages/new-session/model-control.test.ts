import { describe, expect, it, vi } from "vitest";
import type { GatewayAgentRow, ModelCatalogEntry } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { NewSessionModelControl } from "./model-control.ts";

function contextWith(models: ModelCatalogEntry[], runtime = "openclaw") {
  const request = vi.fn().mockResolvedValue({ models });
  const context = {
    gateway: {
      snapshot: {
        connected: true,
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
