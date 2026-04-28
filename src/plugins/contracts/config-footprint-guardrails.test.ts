import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "../../config/bundled-channel-config-metadata.generated.js";
import { GENERATED_BASE_CONFIG_SCHEMA } from "../../config/schema.base.generated.js";

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_ROOT = resolve(SRC_ROOT, "..");

function readSource(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), "utf8");
}

function collectSchemaPaths(schema: unknown, prefix = ""): string[] {
  if (!schema || typeof schema !== "object") {
    return [];
  }

  const out: string[] = [];
  const candidate = schema as {
    properties?: Record<string, unknown>;
    additionalProperties?: unknown;
    items?: unknown;
  };

  if (candidate.properties && typeof candidate.properties === "object") {
    for (const [key, value] of Object.entries(candidate.properties)) {
      const path = prefix ? `${prefix}.${key}` : key;
      out.push(path);
      out.push(...collectSchemaPaths(value, path));
    }
  }

  if (
    candidate.additionalProperties &&
    typeof candidate.additionalProperties === "object" &&
    !Array.isArray(candidate.additionalProperties)
  ) {
    const path = prefix ? `${prefix}.*` : "*";
    out.push(...collectSchemaPaths(candidate.additionalProperties, path));
  }

  if (candidate.items && typeof candidate.items === "object" && !Array.isArray(candidate.items)) {
    const path = prefix ? `${prefix}[]` : "[]";
    out.push(...collectSchemaPaths(candidate.items, path));
  }

  return out;
}

function asRecord(value: unknown): Record<string, unknown> {
  expect(value && typeof value === "object" && !Array.isArray(value)).toBe(true);
  return value as Record<string, unknown>;
}

describe("config footprint guardrails", () => {
  it("keeps plugin entry config generic in the generated base schema", () => {
    const root = asRecord(GENERATED_BASE_CONFIG_SCHEMA.schema);
    const plugins = asRecord(asRecord(root.properties).plugins);
    const entries = asRecord(asRecord(plugins.properties).entries);
    const entry = asRecord(entries.additionalProperties);
    const pluginConfig = asRecord(asRecord(entry.properties).config);

    expect(pluginConfig.type).toBe("object");
    expect(pluginConfig.additionalProperties).toEqual({});
    expect(pluginConfig.properties).toBeUndefined();
  });

  it("keeps retired legacy paths out of the generated base config schema", () => {
    const basePaths = new Set(collectSchemaPaths(GENERATED_BASE_CONFIG_SCHEMA.schema));

    expect(
      [
        "talk.voiceId",
        "talk.voiceAliases",
        "talk.modelId",
        "talk.outputFormat",
        "talk.apiKey",
        "talk.providers.*.voiceId",
        "talk.providers.*.voiceAliases",
        "talk.providers.*.modelId",
        "talk.providers.*.outputFormat",
        "agents.defaults.sandbox.perSession",
        "hooks.internal.handlers",
        "channels.telegram.groupMentionsOnly",
        "channels.telegram.streamMode",
        "channels.telegram.chunkMode",
        "channels.telegram.blockStreaming",
        "channels.telegram.draftChunk",
        "channels.telegram.blockStreamingCoalesce",
        "channels.slack.streamMode",
        "channels.slack.chunkMode",
        "channels.slack.blockStreaming",
        "channels.slack.blockStreamingCoalesce",
        "channels.slack.nativeStreaming",
        "channels.discord.streamMode",
        "channels.discord.chunkMode",
        "channels.discord.blockStreaming",
        "channels.discord.draftChunk",
        "channels.discord.blockStreamingCoalesce",
        "channels.googlechat.streamMode",
        "channels.slack.channels.*.allow",
        "channels.slack.accounts.*.channels.*.allow",
        "channels.googlechat.groups.*.allow",
        "channels.googlechat.accounts.*.groups.*.allow",
        "channels.discord.channels.*.allow",
        "channels.discord.accounts.*.channels.*.allow",
      ].filter((path) => basePaths.has(path)),
    ).toEqual([]);
  });

  it("keeps bundled channel private-network config canonical in generated metadata", () => {
    const pluginIds = ["bluebubbles", "matrix", "mattermost", "nextcloud-talk", "tlon"];

    for (const pluginId of pluginIds) {
      const metadata = GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.find(
        (entry) => entry.pluginId === pluginId,
      );
      expect(metadata, `${pluginId} metadata missing`).toBeDefined();
      const paths = new Set(collectSchemaPaths(metadata?.schema));
      expect(paths.has("allowPrivateNetwork"), `${pluginId} leaked flat allowPrivateNetwork`).toBe(
        false,
      );
      expect(
        paths.has("network.dangerouslyAllowPrivateNetwork"),
        `${pluginId} missing canonical network.dangerouslyAllowPrivateNetwork`,
      ).toBe(true);
    }
  });

  it("keeps canonical nested streaming paths in the public core channel schema", () => {
    const source = readSource("src/config/zod-schema.providers-core.ts");

    expect(source).toContain("streaming: ChannelPreviewStreamingConfigSchema.optional(),");
    expect(source).toContain("streaming: SlackStreamingConfigSchema.optional(),");
    expect(source).not.toContain('streamMode: z.enum(["replace", "status_final", "append"])');
    expect(source).not.toContain("draftChunk:");
    expect(source).not.toContain("nativeStreaming:");
  });

  it("keeps shared setup input canonical-first", () => {
    const source = readSource("src/channels/plugins/types.core.ts");

    expect(source).toContain("dangerouslyAllowPrivateNetwork?: boolean;");
    expect(source).toContain("allowPrivateNetwork?: boolean;");
    expect(source).not.toContain("streamMode?:");
    expect(source).not.toContain("groupMentionsOnly?:");
    expect(source).not.toContain("perSession?:");
    expect(source).not.toContain("voiceId?:");
    expect(source).not.toContain("apiKey?:");
    expect(source).not.toContain("allow?: boolean;");
  });

  it("keeps plugin-sdk private-network helpers canonical-first with a narrow compat alias", () => {
    const source = readSource("src/plugin-sdk/ssrf-policy.ts");

    expect(source).toContain("export function ssrfPolicyFromDangerouslyAllowPrivateNetwork(");
    expect(source).toContain("export function ssrfPolicyFromAllowPrivateNetwork(");
    expect(source).toContain(
      "return ssrfPolicyFromDangerouslyAllowPrivateNetwork(allowPrivateNetwork);",
    );
  });

  it("keeps bundled channel schemas out of the generic channel config SDK surface", () => {
    const source = readSource("src/plugin-sdk/channel-config-schema.ts");
    const bundledSource = readSource("src/plugin-sdk/bundled-channel-config-schema.ts");
    const legacySource = readSource("src/plugin-sdk/channel-config-schema-legacy.ts");
    const bundledSection = bundledSource.slice(
      bundledSource.indexOf("Bundled-channel config schemas"),
    );
    const bundledSchemaExportBlocks = Array.from(
      bundledSection.matchAll(
        /export \{(?<exports>[^}]*)\} from "\.\.\/config\/zod-schema\.providers-(?:core|whatsapp)\.js";/g,
      ),
    )
      .map((match) => match.groups?.exports)
      .filter((block): block is string => Boolean(block));
    expect(bundledSchemaExportBlocks).toHaveLength(2);
    const exportedSchemaNames = Array.from(
      bundledSchemaExportBlocks.join("\n").matchAll(/\b([A-Z][A-Za-z0-9]+ConfigSchema)\b/g),
    )
      .map((match) => match[1])
      .filter((name): name is string => Boolean(name))
      .toSorted((left, right) => left.localeCompare(right));

    expect(exportedSchemaNames).toEqual([
      "DiscordConfigSchema",
      "GoogleChatConfigSchema",
      "IMessageConfigSchema",
      "MSTeamsConfigSchema",
      "SignalConfigSchema",
      "SlackConfigSchema",
      "TelegramConfigSchema",
      "WhatsAppConfigSchema",
    ]);
    for (const schemaName of exportedSchemaNames) {
      expect(source).not.toContain(schemaName);
    }
    expect(bundledSource).toContain("Bundled-channel config schemas");
    expect(bundledSource).toContain("openclaw/plugin-sdk/channel-config-schema");
    expect(legacySource).toContain("Deprecated bundled-channel compatibility surface");
    expect(legacySource).toContain("openclaw/plugin-sdk/bundled-channel-config-schema");
    expect(legacySource).toContain('export * from "./bundled-channel-config-schema.js";');
  });
});
