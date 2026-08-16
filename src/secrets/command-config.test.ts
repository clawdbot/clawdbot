/** Tests command-specific secret assignment collection from config snapshots. */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  buildTalkTestProviderConfig,
  TALK_TEST_PROVIDER_API_KEY_PATH,
  TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS,
} from "../test-utils/talk-test-provider.js";
import { analyzeCommandSecretAssignmentsFromSnapshot } from "./command-config.js";

describe("analyzeCommandSecretAssignmentsFromSnapshot", () => {
  it("returns assignments from the active runtime snapshot for configured refs", () => {
    const sourceConfig = buildTalkTestProviderConfig({
      source: "env",
      provider: "default",
      id: "TALK_API_KEY",
    });
    const resolvedConfig = buildTalkTestProviderConfig("talk-key"); // pragma: allowlist secret

    const result = analyzeCommandSecretAssignmentsFromSnapshot({
      sourceConfig,
      resolvedConfig,
      targetIds: new Set(["talk.providers.*.apiKey"]),
    });

    expect(result.assignments).toEqual([
      {
        path: TALK_TEST_PROVIDER_API_KEY_PATH,
        pathSegments: [...TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS],
        value: "talk-key",
      },
    ]);
  });

  it("reports configured refs that are unresolved in the snapshot", () => {
    const sourceConfig = buildTalkTestProviderConfig({
      source: "env",
      provider: "default",
      id: "TALK_API_KEY",
    });
    const resolvedConfig = buildTalkTestProviderConfig(undefined);

    const result = analyzeCommandSecretAssignmentsFromSnapshot({
      sourceConfig,
      resolvedConfig,
      targetIds: new Set(["talk.providers.*.apiKey"]),
    });

    expect(result.unresolved).toEqual([
      {
        path: TALK_TEST_PROVIDER_API_KEY_PATH,
        pathSegments: [...TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS],
      },
    ]);
  });

  it("skips unresolved refs that are marked inactive by runtime warnings", () => {
    const sourceConfig = {
      memory: {
        search: {
          remote: {
            apiKey: { source: "env", provider: "default", id: "DEFAULT_MEMORY_KEY" },
          },
        },
      },

      agents: {
        defaults: {},
      },
    } as unknown as OpenClawConfig;
    const resolvedConfig = {
      memory: {
        search: {
          remote: {
            apiKey: { source: "env", provider: "default", id: "DEFAULT_MEMORY_KEY" },
          },
        },
      },

      agents: {
        defaults: {},
      },
    } as unknown as OpenClawConfig;

    const result = analyzeCommandSecretAssignmentsFromSnapshot({
      sourceConfig,
      resolvedConfig,
      targetIds: new Set(["memory.search.remote.apiKey"]),
      inactiveRefPaths: new Set(["memory.search.remote.apiKey"]),
    });

    expect(result.assignments).toStrictEqual([]);
    expect(result.diagnostics).toEqual([
      "memory.search.remote.apiKey: secret ref is configured on an inactive surface; skipping command-time assignment.",
    ]);
  });
});
