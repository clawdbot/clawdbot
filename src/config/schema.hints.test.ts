import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildSecretInputSchema } from "../plugin-sdk/secret-input-schema.js";
import { isSensitiveUrlConfigPath } from "../shared/net/redact-sensitive-url.js";
import { FIELD_HELP } from "./schema.help.js";
import { __test__, isPluginOwnedChannelHintPath, isSensitiveConfigPath } from "./schema.hints.js";
import { FIELD_LABELS } from "./schema.labels.js";
import { OpenClawSchema } from "./zod-schema.js";
import { sensitive } from "./zod-schema.sensitive.js";

const { collectMatchingSchemaPaths, mapSensitivePaths } = __test__;
const BUNDLED_CHANNEL_HINT_PREFIXES = [
  "channels.bluebubbles",
  "channels.discord",
  "channels.imessage",
  "channels.irc",
  "channels.msteams",
  "channels.signal",
  "channels.slack",
  "channels.telegram",
  "channels.whatsapp",
] as const;

describe("isSensitiveConfigPath", () => {
  it("matches whitelist suffixes case-insensitively", () => {
    const whitelistedPaths = [
      "maxTokens",
      "maxOutputTokens",
      "maxInputTokens",
      "maxCompletionTokens",
      "contextTokens",
      "totalTokens",
      "tokenCount",
      "tokenLimit",
      "tokenBudget",
      "channels.irc.nickserv.passwordFile",
    ];
    for (const path of whitelistedPaths) {
      expect(isSensitiveConfigPath(path)).toBe(false);
      expect(isSensitiveConfigPath(path.toUpperCase())).toBe(false);
    }
  });

  it("keeps true sensitive keys redacted", () => {
    expect(isSensitiveConfigPath("channels.slack.token")).toBe(true);
    expect(isSensitiveConfigPath("models.providers.openai.apiKey")).toBe(true);
    expect(isSensitiveConfigPath("channels.irc.nickserv.password")).toBe(true);
    expect(isSensitiveConfigPath("channels.feishu.encryptKey")).toBe(true);
    expect(isSensitiveConfigPath("channels.feishu.accounts.default.encryptKey")).toBe(true);
    expect(isSensitiveConfigPath("channels.nostr.privateKey")).toBe(true);
    expect(isSensitiveConfigPath("channels.nostr.accounts.default.privateKey")).toBe(true);
  });
});

describe("plugin-owned channel hint paths", () => {
  it("keeps bundled channel help and labels out of core tables", () => {
    for (const key of [...Object.keys(FIELD_HELP), ...Object.keys(FIELD_LABELS)]) {
      if (
        !BUNDLED_CHANNEL_HINT_PREFIXES.some(
          (prefix) => key === prefix || key.startsWith(`${prefix}.`),
        )
      ) {
        continue;
      }
      expect(isPluginOwnedChannelHintPath(key), `core still owns ${key}`).toBe(false);
    }
  });
});

describe("mapSensitivePaths", () => {
  it("should detect sensitive fields nested inside all structural Zod types", () => {
    const GrandSchema = z.object({
      simple: z.string().register(sensitive).optional(),
      simpleReversed: z.string().optional().register(sensitive),
      nested: z.object({
        nested: z.string().register(sensitive),
      }),
      list: z.array(z.string().register(sensitive)),
      listOfObjects: z.array(z.object({ nested: z.string().register(sensitive) })),
      headers: z.record(z.string(), z.string().register(sensitive)),
      headersNested: z.record(z.string(), z.object({ nested: z.string().register(sensitive) })),
      auth: z.union([
        z.object({ type: z.literal("none") }),
        z.object({ type: z.literal("token"), value: z.string().register(sensitive) }),
      ]),
      merged: z
        .object({ id: z.string() })
        .and(z.object({ nested: z.string().register(sensitive) })),
    });

    const result = mapSensitivePaths(GrandSchema, "", {});

    expect(result["simple"]?.sensitive).toBe(true);
    expect(result["simpleReversed"]?.sensitive).toBe(true);
    expect(result["nested.nested"]?.sensitive).toBe(true);
    expect(result["list[]"]?.sensitive).toBe(true);
    expect(result["listOfObjects[].nested"]?.sensitive).toBe(true);
    expect(result["headers.*"]?.sensitive).toBe(true);
    expect(result["headersNested.*.nested"]?.sensitive).toBe(true);
    expect(result["auth.value"]?.sensitive).toBe(true);
    expect(result["merged.nested"]?.sensitive).toBe(true);
  });

  it("should not detect non-sensitive fields nested inside all structural Zod types", () => {
    const GrandSchema = z.object({
      simple: z.string().optional(),
      simpleReversed: z.string().optional(),
      nested: z.object({
        nested: z.string(),
      }),
      list: z.array(z.string()),
      listOfObjects: z.array(z.object({ nested: z.string() })),
      headers: z.record(z.string(), z.string()),
      headersNested: z.record(z.string(), z.object({ nested: z.string() })),
      auth: z.union([
        z.object({ type: z.literal("none") }),
        z.object({ type: z.literal("token"), value: z.string() }),
      ]),
      merged: z.object({ id: z.string() }).and(z.object({ nested: z.string() })),
    });

    const result = mapSensitivePaths(GrandSchema, "", {});

    expect(result["simple"]?.sensitive).toBe(undefined);
    expect(result["simpleReversed"]?.sensitive).toBe(undefined);
    expect(result["nested.nested"]?.sensitive).toBe(undefined);
    expect(result["list[]"]?.sensitive).toBe(undefined);
    expect(result["listOfObjects[].nested"]?.sensitive).toBe(undefined);
    expect(result["headers.*"]?.sensitive).toBe(undefined);
    expect(result["headersNested.*.nested"]?.sensitive).toBe(undefined);
    expect(result["auth.value"]?.sensitive).toBe(undefined);
    expect(result["merged.nested"]?.sensitive).toBe(undefined);
  });

  it("maps sensitive fields nested under object catchall schemas", () => {
    const schema = z.object({
      custom: z.object({}).catchall(
        z.object({
          apiKey: z.string().register(sensitive),
          label: z.string(),
        }),
      ),
    });

    const result = mapSensitivePaths(schema, "", {});
    expect(result["custom.*.apiKey"]?.sensitive).toBe(true);
    expect(result["custom.*.label"]?.sensitive).toBe(undefined);
  });

  it("does not mark plain catchall values sensitive by default", () => {
    const schema = z.object({
      env: z.object({}).catchall(z.string()),
    });

    const result = mapSensitivePaths(schema, "", {});
    expect(result["env.*"]?.sensitive).toBe(undefined);
  });

  it("main schema yields correct hints (samples)", () => {
    const schema = OpenClawSchema.toJSONSchema({
      target: "draft-07",
      unrepresentable: "any",
    });
    schema.title = "OpenClawConfig";
    const hints = mapSensitivePaths(OpenClawSchema, "", {});

    expect(hints["agents.defaults.memorySearch.remote.apiKey"]?.sensitive).toBe(true);
    expect(hints["agents.list[].memorySearch.remote.apiKey"]?.sensitive).toBe(true);
    expect(hints["gateway.auth.token"]?.sensitive).toBe(true);
    expect(hints["models.providers.*.headers.*"]?.sensitive).toBe(true);
    expect(hints["models.providers.*.request.headers.*"]?.sensitive).toBe(true);
    expect(hints["models.providers.*.request.proxy.tls.cert"]?.sensitive).toBe(true);
    expect(hints["proxy.proxyUrl"]?.sensitive).toBe(true);
    expect(hints["skills.entries.*.apiKey"]?.sensitive).toBe(true);
  });

  it("marks buildSecretInputSchema fields as sensitive via registry", () => {
    const schema = z.object({
      encryptKey: buildSecretInputSchema().optional(),
      appSecret: buildSecretInputSchema().optional(),
      nested: z.object({
        verificationToken: buildSecretInputSchema().optional(),
      }),
    });
    const hints = mapSensitivePaths(schema, "", {});

    expect(hints["encryptKey"]?.sensitive).toBe(true);
    expect(hints["appSecret"]?.sensitive).toBe(true);
    expect(hints["nested.verificationToken"]?.sensitive).toBe(true);
  });
});

describe("collectMatchingSchemaPaths", () => {
  it("finds base-config URL fields that may embed secrets", () => {
    const paths = collectMatchingSchemaPaths(OpenClawSchema, "", isSensitiveUrlConfigPath);

    expect(paths.has("mcp.servers.*.url")).toBe(true);
    expect(paths.has("models.providers.*.baseUrl")).toBe(true);
    expect(paths.has("models.providers.*.request.proxy.url")).toBe(true);
    expect(paths.has("tools.media.audio.request.proxy.url")).toBe(true);
  });
});
