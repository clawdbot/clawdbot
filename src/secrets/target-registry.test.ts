import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  buildTalkTestProviderConfig,
  TALK_TEST_PROVIDER_API_KEY_PATH,
  TALK_TEST_PROVIDER_ID,
} from "../test-utils/talk-test-provider.js";
import {
  discoverConfigSecretTargetsByIds,
  resolveConfigSecretTargetByPath,
} from "./target-registry.js";

describe("secret target registry", () => {
  it("supports filtered discovery by target ids", () => {
    const config = {
      ...buildTalkTestProviderConfig({ source: "env", provider: "default", id: "TALK_API_KEY" }),
      gateway: {
        remote: {
          token: { source: "env" as const, provider: "default", id: "REMOTE_TOKEN" },
        },
      },
    } satisfies OpenClawConfig;

    const targets = discoverConfigSecretTargetsByIds(config, new Set(["talk.providers.*.apiKey"]));

    expect(targets).toHaveLength(1);
    expect(targets[0]?.entry?.id).toBe("talk.providers.*.apiKey");
    expect(targets[0]?.providerId).toBe(TALK_TEST_PROVIDER_ID);
    expect(targets[0]?.path).toBe(TALK_TEST_PROVIDER_API_KEY_PATH);
  });

  it("resolves config targets by exact path including sibling ref metadata", () => {
    const target = resolveConfigSecretTargetByPath(["channels", "googlechat", "serviceAccount"]);

    expect(target).not.toBeNull();
    expect(target?.entry?.id).toBe("channels.googlechat.serviceAccount");
    expect(target?.refPathSegments).toEqual(["channels", "googlechat", "serviceAccountRef"]);
  });

  it("returns null when no config target path matches", () => {
    const target = resolveConfigSecretTargetByPath(["gateway", "auth", "mode"]);

    expect(target).toBeNull();
  });

  it("includes exa webSearch api key target path", () => {
    const target = resolveConfigSecretTargetByPath([
      "plugins",
      "entries",
      "exa",
      "config",
      "webSearch",
      "apiKey",
    ]);

    expect(target).not.toBeNull();
    expect(target?.entry?.id).toBe("plugins.entries.exa.config.webSearch.apiKey");
  });
});
