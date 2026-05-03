import { describe, expect, it, vi } from "vitest";
import { overlayRuntimeExternalOAuthProfiles } from "./oauth-shared.js";
import type { AuthProfileStore } from "./types.js";

describe("overlayRuntimeExternalOAuthProfiles", () => {
  it("isolates runtime OAuth overlays without structuredClone", () => {
    const structuredCloneSpy = vi.spyOn(globalThis, "structuredClone");
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "sk-test",
        },
      },
      order: {
        openai: ["openai:default"],
      },
    };

    try {
      const overlaid = overlayRuntimeExternalOAuthProfiles(store, [
        {
          profileId: "openai-codex:default",
          credential: {
            type: "oauth",
            provider: "openai-codex",
            access: "access-1",
            refresh: "refresh-1",
            expires: Date.now() + 60_000,
          },
        },
      ]);

      expect(overlaid.profiles["openai-codex:default"]).toMatchObject({
        access: "access-1",
      });
      expect(store.profiles["openai-codex:default"]).toBeUndefined();

      overlaid.profiles["openai:default"].provider = "mutated";
      overlaid.order!.openai.push("mutated");

      expect(store.profiles["openai:default"]).toMatchObject({
        provider: "openai",
      });
      expect(store.order?.openai).toEqual(["openai:default"]);
      expect(structuredCloneSpy).not.toHaveBeenCalled();
    } finally {
      structuredCloneSpy.mockRestore();
    }
  });
});
