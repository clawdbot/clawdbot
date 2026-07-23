// Config footprint guardrail tests cover forbidden direct plugin config access patterns.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "../../config/bundled-channel-config-metadata.generated.js";
import { computeBaseConfigSchemaResponse } from "../../config/schema-base.js";
import { listGitTrackedFiles } from "../../test-utils/repo-files.js";

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_ROOT = resolve(SRC_ROOT, "..");
const BASE_CONFIG_SCHEMA = computeBaseConfigSchemaResponse({
  generatedAt: "2026-05-05T00:00:00.000Z",
});

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
  if (!value || typeof value !== "object") {
    throw new Error("expected record");
  }
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}

describe("config footprint guardrails", () => {
  it("keeps plugin entry config generic in the generated base schema", () => {
    const root = asRecord(BASE_CONFIG_SCHEMA.schema);
    const plugins = asRecord(asRecord(root.properties).plugins);
    const entries = asRecord(asRecord(plugins.properties).entries);
    const entry = asRecord(entries.additionalProperties);
    const pluginConfig = asRecord(asRecord(entry.properties).config);

    expect(pluginConfig.type).toBe("object");
    expect(pluginConfig.additionalProperties).toStrictEqual({});
    expect(pluginConfig.properties).toBeUndefined();
  });

  it("keeps retired legacy paths out of the generated base config schema", () => {
    const basePaths = new Set(collectSchemaPaths(BASE_CONFIG_SCHEMA.schema));

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
    ).toStrictEqual([]);
  });

  it("keeps bundled channel private-network config canonical in generated metadata", () => {
    const pluginIds = ["matrix", "nextcloud-talk", "tlon"];

    for (const pluginId of pluginIds) {
      const metadata = GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.find(
        (entry) => entry.pluginId === pluginId,
      );
      if (metadata === undefined) {
        throw new Error(`${pluginId} metadata missing`);
      }
      const paths = new Set(collectSchemaPaths(metadata.schema));
      expect(paths.has("allowPrivateNetwork"), `${pluginId} leaked flat allowPrivateNetwork`).toBe(
        false,
      );
      expect(
        paths.has("network.dangerouslyAllowPrivateNetwork"),
        `${pluginId} missing canonical network.dangerouslyAllowPrivateNetwork`,
      ).toBe(true);
    }
  });

  it("keeps canonical nested streaming paths in channel-owned schemas", () => {
    const telegramSource = readSource("extensions/telegram/src/config-schema.ts");
    const discordSource = readSource("extensions/discord/src/config-schema.ts");
    const msTeamsSource = readSource("extensions/msteams/src/config-schema.ts");
    const slackSource = readSource("extensions/slack/src/config-schema.ts");

    expect(telegramSource).toContain("streaming: TelegramPreviewStreamingConfigSchema.optional(),");
    expect(discordSource).toContain("streaming: DiscordPreviewStreamingConfigSchema.optional(),");
    expect(msTeamsSource).toContain("streaming: ChannelPreviewStreamingConfigSchema.optional(),");
    expect(slackSource).toContain("streaming: SlackStreamingConfigSchema.optional(),");
    for (const schemaSource of [telegramSource, discordSource, msTeamsSource, slackSource]) {
      expect(schemaSource).not.toContain(
        'streamMode: z.enum(["replace", "status_final", "append"])',
      );
      expect(schemaSource).not.toContain("draftChunk:");
      expect(schemaSource).not.toContain("nativeStreaming:");
    }
  });

  it("keeps Matrix setup input canonical-first after plugin ownership", () => {
    const source = readSource("extensions/matrix/src/setup-config.ts");
    const canonicalIndex = source.indexOf("dangerouslyAllowPrivateNetwork?: boolean;");
    const aliasIndex = source.indexOf("allowPrivateNetwork?: boolean;");

    expect(canonicalIndex).toBeGreaterThanOrEqual(0);
    expect(aliasIndex).toBeGreaterThan(canonicalIndex);
  });

  it("keeps retired config aliases out of the shared setup input", () => {
    const source = readSource("src/channels/plugins/types.core.ts");

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

  it("keeps current channel schemas plugin-owned with a narrow shipped compatibility tier", () => {
    const source = readSource("src/plugin-sdk/channel-config-schema.ts");
    const bundledSource = readSource("src/plugin-sdk/bundled-channel-config-schema.ts");
    const bundledSection = bundledSource.slice(
      bundledSource.indexOf("Bundled-channel config schemas"),
    );
    const bundledSchemaExportBlocks = Array.from(
      bundledSection.matchAll(
        /export \{(?<exports>[^}]*)\} from "\.\.\/config\/zod-schema\.providers-(?:googlechat|whatsapp)\.js";/g,
      ),
    )
      .map((match) => match.groups?.exports)
      .filter((block): block is string => Boolean(block));
    expect(bundledSchemaExportBlocks).toHaveLength(2);
    const lazySchemaNames = Array.from(
      bundledSection.matchAll(/\bexport const ([A-Z][A-Za-z0-9]+ConfigSchema)\b/g),
      (match) => match[1],
    ).filter((name): name is string => Boolean(name));
    const exportedSchemaNames = [
      ...Array.from(
        bundledSchemaExportBlocks.join("\n").matchAll(/\b([A-Z][A-Za-z0-9]+ConfigSchema)\b/g),
        (match) => match[1],
      ).filter((name): name is string => Boolean(name)),
      ...lazySchemaNames,
    ].toSorted((left, right) => left.localeCompare(right));

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
    expect(bundledSource).toMatch(
      /loadBundledConfigSchema<[^;]+?>\(\s*"imessage",\s*"IMessageConfigSchema",?\s*\)/u,
    );
    expect(bundledSource).toMatch(
      /loadBundledConfigSchema<[^;]+?>\(\s*"telegram",\s*"TelegramConfigSchema",?\s*\)/u,
    );
    expect(bundledSource).toMatch(
      /loadBundledConfigSchema<[^;]+?>\(\s*"discord",\s*"DiscordConfigSchema",?\s*\)/u,
    );
    expect(bundledSource).toMatch(
      /loadBundledConfigSchema<[^;]+?>\(\s*"msteams",\s*"MSTeamsConfigSchema",?\s*\)/u,
    );
    // The primitives facade re-exports the canonical channel-config-schema
    // module; only bundled provider schemas bypass it.
    const primitivesSource = readSource("src/plugin-sdk/channel-config-primitives.ts");
    expect(primitivesSource).toContain('from "./channel-config-schema.js";');
    expect(primitivesSource).not.toContain("../channels/");
    expect(primitivesSource).not.toContain("../config/");
    expect(bundledSource).toContain('from "./channel-config-schema.js";');
    expect(bundledSource).not.toContain("../channels/");
  });

  it("keeps internal src imports off the non-canonical channel config schema facades", () => {
    // channel-config-schema is the canonical internal module; the primitives
    // and bundled shells stay export-compatible for plugins only.
    const allowedShellImporters = new Set([
      // The facade's focused regression tests are its only internal consumers.
      "src/plugin-sdk/bundled-channel-config-schema.test.ts",
      "src/plugin-sdk/shipped-channel-compat.test.ts",
      // This guardrail file embeds facade specifiers in shell-shape assertions.
      "src/plugins/contracts/config-footprint-guardrails.test.ts",
    ]);
    const facadeImportPattern =
      /\bfrom\s*["'][^"']*(?:channel-config-primitives|bundled-channel-config-schema)(?:\.js)?["']/u;
    const files = listGitTrackedFiles({ repoRoot: REPO_ROOT, pathspecs: "src" }) ?? [];

    const offenders = files.filter((file) => {
      if (!(file.endsWith(".ts") || file.endsWith(".tsx")) || allowedShellImporters.has(file)) {
        return false;
      }
      return facadeImportPattern.test(readFileSync(resolve(REPO_ROOT, file), "utf8"));
    });

    expect(offenders).toStrictEqual([]);
  });
});
