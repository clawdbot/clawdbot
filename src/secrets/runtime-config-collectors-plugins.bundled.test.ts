import { describe, expect, it } from "vitest";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { findBundledPluginMetadataById } from "../plugins/bundled-plugin-metadata.js";
import { resolvePluginConfigContractsById } from "../plugins/config-contracts.js";
import { collectPluginConfigAssignments } from "./runtime-config-collectors-plugins.js";
import { createResolverContext } from "./runtime-shared.js";

function envRef(id: string) {
  return { source: "env" as const, provider: "default", id };
}

describe("collectPluginConfigAssignments bundled plugin manifests", () => {
  it("collects voice-call SecretRef assignments from bundled manifest contracts", () => {
    expect(
      findBundledPluginMetadataById("voice-call")?.manifest.configContracts?.secretInputs?.paths,
    ).toEqual([
      { path: "twilio.authToken", expected: "string" },
      { path: "tts.providers.*.apiKey", expected: "string" },
    ]);
    const config = {
      plugins: {
        entries: {
          "voice-call": {
            enabled: true,
            config: {
              twilio: {
                authToken: envRef("TWILIO_AUTH_TOKEN"),
              },
              tts: {
                providers: {
                  openai: {
                    apiKey: envRef("OPENAI_API_KEY"),
                  },
                  elevenlabs: {
                    apiKey: envRef("ELEVENLABS_API_KEY"),
                  },
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    expect(
      resolvePluginConfigContractsById({
        config,
        workspaceDir: resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config)),
        env: {},
        fallbackToBundledMetadata: true,
        fallbackToBundledMetadataForResolvedBundled: true,
        pluginIds: ["voice-call"],
        fallbackBundledPluginIds: ["voice-call"],
      }).get("voice-call")?.configContracts.secretInputs?.paths,
    ).toEqual([
      { path: "twilio.authToken", expected: "string" },
      { path: "tts.providers.*.apiKey", expected: "string" },
    ]);
    const context = createResolverContext({
      sourceConfig: config,
      env: {},
    });

    collectPluginConfigAssignments({
      config,
      defaults: undefined,
      context,
      loadablePluginOrigins: new Map([["voice-call", "bundled"]]),
    });

    expect({
      assignments: context.assignments.map((assignment) => assignment.path).toSorted(),
      warnings: context.warnings,
    }).toEqual({
      assignments: [
        "plugins.entries.voice-call.config.tts.providers.elevenlabs.apiKey",
        "plugins.entries.voice-call.config.tts.providers.openai.apiKey",
        "plugins.entries.voice-call.config.twilio.authToken",
      ],
      warnings: [],
    });
  });
});
