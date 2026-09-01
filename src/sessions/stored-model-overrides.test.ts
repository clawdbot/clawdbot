import { describe, expect, it, vi } from "vitest";
import { resolveStoredModelOverride } from "./stored-model-overrides.js";

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

  it("does not inherit active automatic fallback overrides from parent sessions", () => {
    expect(
      resolveStoredModelOverride({
        defaultProvider: "openai",
        sessionKey: "agent:main:discord:channel:root:thread:child",
        sessionStore: {
          "agent:main:discord:channel:root": {
            sessionId: "parent-session",
            updatedAt: 1,
            providerOverride: "google-vertex",
            modelOverride: "gemini-fallback",
            modelOverrideSource: "auto",
            modelOverrideFallbackOriginProvider: "openai",
            modelOverrideFallbackOriginModel: "gpt-primary",
          },
        },
      }),
    ).toBeNull();
  });

  it("inherits configured automatic selections without fallback provenance", () => {
    expect(
      resolveStoredModelOverride({
        defaultProvider: "openai",
        sessionKey: "agent:main:discord:channel:root:thread:child",
        sessionStore: {
          "agent:main:discord:channel:root": {
            sessionId: "legacy-parent-session",
            updatedAt: 1,
            providerOverride: "google-vertex",
            modelOverride: "gemini-fallback",
            modelOverrideSource: "auto",
          },
        },
      }),
    ).toEqual({
      provider: "google-vertex",
      model: "gemini-fallback",
      source: "parent",
      routeResolution: "raw",
    });
  });

  it("continues to inherit deliberate parent model pins", () => {
    expect(
      resolveStoredModelOverride({
        defaultProvider: "openai",
        sessionKey: "agent:main:discord:channel:root:thread:child",
        sessionStore: {
          "agent:main:discord:channel:root": {
            sessionId: "parent-session",
            updatedAt: 1,
            providerOverride: "anthropic",
            modelOverride: "claude-sonnet-4-6",
            modelOverrideSource: "user",
          },
        },
      }),
    ).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      source: "parent",
      routeResolution: "raw",
    });
  });
});
