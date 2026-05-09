import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  buildTalkTestProviderConfig,
  TALK_TEST_PROVIDER_API_KEY_PATH,
  TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS,
} from "../test-utils/talk-test-provider.js";
import { collectCommandSecretAssignmentsFromSnapshot } from "./command-config.js";

describe("collectCommandSecretAssignmentsFromSnapshot", () => {
  it("returns assignments from the active runtime snapshot for configured refs", () => {
    const sourceConfig = buildTalkTestProviderConfig({
      source: "env",
      provider: "default",
      id: "TALK_API_KEY",
    });
    const resolvedConfig = buildTalkTestProviderConfig("talk-key"); // pragma: allowlist secret

    const result = collectCommandSecretAssignmentsFromSnapshot({
      sourceConfig,
      resolvedConfig,
      commandName: "memory status",
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

  it("throws when configured refs are unresolved in the snapshot", () => {
    const sourceConfig = buildTalkTestProviderConfig({
      source: "env",
      provider: "default",
      id: "TALK_API_KEY",
    });
    const resolvedConfig = buildTalkTestProviderConfig(undefined);

    expect(() =>
      collectCommandSecretAssignmentsFromSnapshot({
        sourceConfig,
        resolvedConfig,
        commandName: "memory search",
        targetIds: new Set(["talk.providers.*.apiKey"]),
      }),
    ).toThrow(new RegExp(`memory search: ${TALK_TEST_PROVIDER_API_KEY_PATH} is unresolved`));
  });

  it("skips unresolved refs that are marked inactive by runtime warnings", () => {
    const sourceConfig = {
      agents: {
        defaults: {
          memorySearch: {
            remote: {
              apiKey: { source: "env", provider: "default", id: "DEFAULT_MEMORY_KEY" },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    const resolvedConfig = {
      agents: {
        defaults: {
          memorySearch: {
            remote: {
              apiKey: { source: "env", provider: "default", id: "DEFAULT_MEMORY_KEY" },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = collectCommandSecretAssignmentsFromSnapshot({
      sourceConfig,
      resolvedConfig,
      commandName: "memory search",
      targetIds: new Set(["agents.defaults.memorySearch.remote.apiKey"]),
      inactiveRefPaths: new Set(["agents.defaults.memorySearch.remote.apiKey"]),
    });

    expect(result.assignments).toStrictEqual([]);
    expect(result.diagnostics).toEqual([
      "agents.defaults.memorySearch.remote.apiKey: secret ref is configured on an inactive surface; skipping command-time assignment.",
    ]);
  });
});
