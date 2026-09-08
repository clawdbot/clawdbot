import { describe, expect, test, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createChatMetadataHarness,
  createChatMetadataOwner,
} from "./chat-metadata-runtime.test-support.js";

describe("gateway chat metadata auth deadlines", () => {
  test.each([
    { at: 19_999, available: true },
    { at: 20_000, available: false },
  ])("reads a cached static token at $at without publication", async ({ at, available }) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const config: OpenClawConfig = {
      auth: { order: { acme: ["acme:primary"] } },
      agents: {
        defaults: { model: { primary: "acme/model" }, models: { "acme/model": {} } },
        list: [{ id: "main", default: true }],
      },
    };
    const owner = createChatMetadataOwner(
      config,
      "model",
      { acme: { type: "api_key", key: "synthetic-token" } },
      "acme",
    );
    const authStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "acme:primary": {
          type: "token",
          provider: "acme",
          token: "synthetic-token",
          expires: 20_000,
        },
      },
    };
    const cached = createChatMetadataHarness(config, { useDefaultProjection: true });
    const fresh = createChatMetadataHarness(config, { useDefaultProjection: true });
    for (const harness of [cached, fresh]) {
      harness.setOwner(owner);
      harness.setAuthStore(authStore);
    }
    try {
      await cached.runtime.refresh();
      await expect(cached.runtime.read({ agentId: "main" })).resolves.toMatchObject({
        models: [{ id: "model", provider: "acme", available: true }],
      });
      clock.mockReturnValue(at);
      await fresh.runtime.refresh();
      const expected = await fresh.runtime.read({ agentId: "main" });
      expect(expected).toMatchObject({
        models: [{ id: "model", provider: "acme", available }],
      });
      expect(await cached.runtime.read({ agentId: "main" })).toEqual(expected);
    } finally {
      await Promise.all([cached.runtime.stop(), fresh.runtime.stop()]);
      clock.mockRestore();
    }
  });

  test.each([
    { name: "cooldown end", cooldownUntil: 20_000, at: 20_000, before: false, after: true },
    { name: "before cooldown end", cooldownUntil: 20_000, at: 19_999, before: false, after: false },
    { name: "nonexpiring key", cooldownUntil: undefined, at: 20_000, before: true, after: true },
  ])(
    "keeps cached metadata current at $name without publication",
    async ({ cooldownUntil, at, before, after }) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
      const config: OpenClawConfig = {
        auth: { order: { acme: ["acme:primary"] } },
        agents: {
          defaults: { model: { primary: "acme/model" }, models: { "acme/model": {} } },
          list: [{ id: "main", default: true }],
        },
      };
      const owner = createChatMetadataOwner(
        config,
        "model",
        { acme: { type: "api_key", key: "synthetic-key" } },
        "acme",
      );
      const authStore: AuthProfileStore = {
        version: 1,
        profiles: { "acme:primary": { type: "api_key", provider: "acme", key: "synthetic-key" } },
        usageStats: { "acme:primary": { cooldownUntil } },
      };
      const cached = createChatMetadataHarness(config, { useDefaultProjection: true });
      const fresh = createChatMetadataHarness(config, { useDefaultProjection: true });
      for (const harness of [cached, fresh]) {
        harness.setOwner(owner);
        harness.setAuthStore(authStore);
      }
      try {
        await cached.runtime.refresh();
        await expect(cached.runtime.read({ agentId: "main" })).resolves.toMatchObject({
          models: [{ id: "model", provider: "acme", available: before }],
        });
        cached.getPreparedAuthStore.mockClear();
        clock.mockReturnValue(at);
        await fresh.runtime.refresh();
        const expected = await fresh.runtime.read({ agentId: "main" });
        expect(expected).toMatchObject({
          models: [{ id: "model", provider: "acme", available: after }],
        });
        expect(await cached.runtime.read({ agentId: "main" })).toEqual(expected);
        expect(cached.getPreparedAuthStore).not.toHaveBeenCalled();
        expect(cached.buildCommands).toHaveBeenCalledOnce();
      } finally {
        await Promise.all([cached.runtime.stop(), fresh.runtime.stop()]);
        clock.mockRestore();
      }
    },
  );
});
