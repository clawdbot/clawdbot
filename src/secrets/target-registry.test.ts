/** Tests core secret target registry queries without plugin discovery. */
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  buildTalkTestProviderConfig,
  TALK_TEST_PROVIDER_API_KEY_PATH,
  TALK_TEST_PROVIDER_ID,
} from "../test-utils/talk-test-provider.js";
import {
  discoverConfigSecretTargetsByIds,
  resolveConfigSecretTargetByPath,
  resolveSecretPlanTargetByPathCore,
} from "./target-registry.js";

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  resolvePluginMetadataSnapshot: () => ({ plugins: [] }),
}));

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

  it("resolves talk realtime provider api key targets", () => {
    const target = resolveConfigSecretTargetByPath([
      "talk",
      "realtime",
      "providers",
      "openai",
      "apiKey",
    ]);

    expect(target?.entry?.id).toBe("talk.realtime.providers.*.apiKey");
    expect(target?.providerId).toBe("openai");
  });

  it("returns null when no config target path matches", () => {
    const target = resolveConfigSecretTargetByPath(["gateway", "auth", "mode"]);

    expect(target).toBeNull();
  });

  it("resolves plan targets by owning config document", () => {
    const configTarget = resolveSecretPlanTargetByPathCore({
      configFile: "openclaw.json",
      pathSegments: ["models", "providers", "openai", "apiKey"],
    });
    const authProfileTarget = resolveSecretPlanTargetByPathCore({
      configFile: "auth-profiles.json",
      pathSegments: ["profiles", "openai:default", "key"],
    });

    expect(configTarget?.entry.targetType).toBe("models.providers.apiKey");
    expect(configTarget?.providerId).toBe("openai");
    expect(authProfileTarget?.entry.targetType).toBe("auth-profiles.api_key.key");
  });
});
