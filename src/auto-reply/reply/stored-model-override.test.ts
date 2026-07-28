import { describe, expect, it, vi } from "vitest";
import { resolveStoredModelOverride } from "./stored-model-override.js";

describe("resolveStoredModelOverride", () => {
  it("recovers resolved provenance for legacy auto-fallback overrides", () => {
    expect(
      resolveStoredModelOverride({
        defaultProvider: "openai",
        sessionEntry: {
          sessionId: "legacy-fallback",
          updatedAt: 1,
          providerOverride: "cloudflare-ai-gateway",
          modelOverride: "gemini-2.5-flash-lite",
          modelOverrideSource: "auto",
          modelOverrideFallbackOriginProvider: "anthropic",
          modelOverrideFallbackOriginModel: "claude-sonnet-4-6",
        },
      }),
    ).toMatchObject({ routeResolution: "resolved" });
  });

  it("loads parent overrides without requiring a whole session store", () => {
    const loadSessionEntry = vi.fn((sessionKey: string) =>
      sessionKey === "agent:main:telegram:dm:parent"
        ? {
            sessionId: "parent-session",
            updatedAt: 1782259200000,
            providerOverride: "anthropic",
            modelOverride: "claude-sonnet-4-7",
          }
        : undefined,
    );

    expect(
      resolveStoredModelOverride({
        defaultProvider: "openai",
        loadSessionEntry,
        sessionKey: "agent:main:telegram:dm:parent:thread:child",
      }),
    ).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-7",
      source: "parent",
      routeResolution: "raw",
    });
    expect(loadSessionEntry).toHaveBeenCalledWith("agent:main:telegram:dm:parent");
  });

  it.each([
    { sessionEntry: { spawnDepth: 1 }, label: "spawn depth" },
    { sessionEntry: { subagentRole: "orchestrator" }, label: "subagent role" },
  ] as const)(
    "does not inherit parent overrides for subagents identified by $label",
    ({ sessionEntry }) => {
      const loadSessionEntry = vi.fn(() => ({
        sessionId: "parent-session",
        updatedAt: 1782259200000,
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-7",
      }));

      expect(
        resolveStoredModelOverride({
          defaultProvider: "openai",
          loadSessionEntry,
          parentSessionKey: "agent:main:telegram:dm:parent",
          sessionEntry: {
            sessionId: "child-session",
            updatedAt: 1782259200000,
            ...sessionEntry,
          },
        }),
      ).toBeNull();
      expect(loadSessionEntry).not.toHaveBeenCalled();
    },
  );

  it("keeps a direct child override ahead of the subagent inheritance guard", () => {
    expect(
      resolveStoredModelOverride({
        defaultProvider: "openai",
        sessionEntry: {
          sessionId: "child-session",
          updatedAt: 1782259200000,
          spawnDepth: 1,
          providerOverride: "openai",
          modelOverride: "gpt-5.6-luna",
        },
      }),
    ).toEqual({
      provider: "openai",
      model: "gpt-5.6-luna",
      source: "session",
    });
  });
});
