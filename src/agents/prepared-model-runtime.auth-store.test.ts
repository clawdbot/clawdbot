import { describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { loadPreparedModelRuntimeAuthStore } from "./prepared-model-runtime.auth-store.js";

const input = {
  config: {},
  agentDir: "/tmp/main-agent",
  inheritedAuthDir: "/tmp/main-agent",
};

describe("prepared model runtime auth store", () => {
  it("retains durable OAuth when an external refresh publishes an empty overlay", () => {
    const durable: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:default": {
          type: "oauth",
          provider: "openai",
          access: "durable-access-not-real",
          refresh: "durable-refresh-not-real",
          expires: Date.now() + 60_000,
        },
      },
    };
    const published: AuthProfileStore = {
      version: 1,
      profiles: {},
      runtimeExternalProfileIds: [],
      runtimeExternalProfileIdsAuthoritative: true,
    };
    const loadDurable = vi.fn(() => durable);

    const result = loadPreparedModelRuntimeAuthStore(input, {
      loadDurable,
      loadPublished: () => published,
    });

    expect(result?.profiles["openai:default"]).toEqual(durable.profiles["openai:default"]);
    expect(loadDurable).toHaveBeenCalledOnce();
  });

  it("avoids durable reads when no external runtime overlay exists", () => {
    const loadDurable = vi.fn(() => ({ version: 1, profiles: {} }));

    expect(
      loadPreparedModelRuntimeAuthStore(input, {
        loadDurable,
        loadPublished: () => ({ version: 1, profiles: {} }),
      }),
    ).toBeUndefined();
    expect(loadDurable).not.toHaveBeenCalled();
  });
});
