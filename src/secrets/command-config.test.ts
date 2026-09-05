/** Tests command-specific secret assignment collection from config snapshots. */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveConfigForRead } from "../config/io.read-helpers.js";
import {
  cloneConfigWithResolutionFacts,
  copyConfigResolutionFactsExcept,
  setConfigResolutionFacts,
} from "../config/resolution-facts.js";
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

  it.each([
    { name: "unresolved bare shorthand", authored: "$MISSING", env: {}, expected: null },
    { name: "unresolved braced shorthand", authored: "${MISSING}", env: {}, expected: null },
    {
      name: "substituted braced-looking literal",
      authored: "${SOURCE}",
      env: { SOURCE: "${OTHER}" },
      expected: "${OTHER}",
    },
    { name: "escaped template literal", authored: "$${OTHER}", env: {}, expected: "${OTHER}" },
  ])("keeps command assignments source-authoritative: $name", ({ authored, env, expected }) => {
    const read = resolveConfigForRead(buildTalkTestProviderConfig(authored), env);
    const sourceConfig = read.resolvedConfigRaw as OpenClawConfig;
    setConfigResolutionFacts(sourceConfig, read.resolutionFacts);
    const resolvedConfig = cloneConfigWithResolutionFacts(sourceConfig);

    const result = analyzeCommandSecretAssignmentsFromSnapshot({
      sourceConfig,
      resolvedConfig,
      targetIds: new Set(["talk.providers.*.apiKey"]),
    });

    expect(result.assignments).toEqual([]);
    expect(result.unresolved).toEqual(
      expected === null
        ? [
            {
              path: TALK_TEST_PROVIDER_API_KEY_PATH,
              pathSegments: [...TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS],
            },
          ]
        : [],
    );
  });

  it("accepts a materialized shorthand whose literal still resembles a reference", () => {
    const read = resolveConfigForRead(buildTalkTestProviderConfig("$SOURCE"), {});
    const sourceConfig = read.resolvedConfigRaw as OpenClawConfig;
    setConfigResolutionFacts(sourceConfig, read.resolutionFacts);
    const resolvedConfig = buildTalkTestProviderConfig("${OTHER}");
    copyConfigResolutionFactsExcept(sourceConfig, resolvedConfig, [
      TALK_TEST_PROVIDER_API_KEY_PATH,
    ]);

    const result = analyzeCommandSecretAssignmentsFromSnapshot({
      sourceConfig,
      resolvedConfig,
      targetIds: new Set(["talk.providers.*.apiKey"]),
    });

    expect(result.unresolved).toEqual([]);
    expect(result.assignments).toEqual([
      expect.objectContaining({ path: TALK_TEST_PROVIDER_API_KEY_PATH, value: "${OTHER}" }),
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
