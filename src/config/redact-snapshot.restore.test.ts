// Covers restoring redacted config snapshots into writable config values.

import { describe, expect, it } from "vitest";
import { redactSnapshotTestHints as mainSchemaHints } from "../../test/helpers/config/redact-snapshot-test-hints.js";
import { createWarnLogCapture } from "../logging/test-helpers/warn-log-capture.js";
import type { ConfigUiHints } from "../shared/config-ui-hints-types.js";
import {
  REDACTED_SENTINEL,
  redactConfigSnapshot,
  restoreRedactedValues as restoreRedactedValues_orig,
} from "./redact-snapshot.js";
import { makeSnapshot, restoreRedactedValues } from "./redact-snapshot.test-helpers.js";

describe("restoreRedactedValues", () => {
  it("restores redacted URL endpoint fields on round-trip", () => {
    const incoming = {
      models: {
        providers: {
          openai: { baseUrl: REDACTED_SENTINEL },
        },
      },
    };
    const original = {
      models: {
        providers: {
          openai: { baseUrl: "https://alice:secret@example.test/v1" },
        },
      },
    };
    const result = restoreRedactedValues(incoming, original, mainSchemaHints);
    expect(result.models.providers.openai.baseUrl).toBe("https://alice:secret@example.test/v1");
  });

  it("restores sentinel values from original config", () => {
    const incoming = {
      gateway: { auth: { token: REDACTED_SENTINEL } },
    };
    const original = {
      gateway: { auth: { token: "real-secret-token-value" } },
    };
    const result = restoreRedactedValues(incoming, original) as typeof incoming;
    expect(result.gateway.auth.token).toBe("real-secret-token-value");
  });

  it("preserves non-sensitive fields unchanged", () => {
    const incoming = {
      ui: { seamColor: "#ff0000" },
      gateway: { port: 9999, auth: { token: REDACTED_SENTINEL } },
    };
    const original = {
      ui: { seamColor: "#0088cc" },
      gateway: { port: 18789, auth: { token: "real-secret" } },
    };
    const result = restoreRedactedValues(incoming, original);
    expect(result.ui.seamColor).toBe("#ff0000");
    expect(result.gateway.port).toBe(9999);
    expect(result.gateway.auth.token).toBe("real-secret");
  });

  it("handles deeply nested sentinel restoration", () => {
    const incoming = {
      channels: {
        slack: {
          accounts: {
            ws1: { botToken: REDACTED_SENTINEL },
            ws2: { botToken: "user-typed-new-token-value" },
          },
        },
      },
    };
    const original = {
      channels: {
        slack: {
          accounts: {
            ws1: { botToken: "original-ws1-token-value" },
            ws2: { botToken: "original-ws2-token-value" },
          },
        },
      },
    };
    const result = restoreRedactedValues(incoming, original);
    expect(result.channels.slack.accounts.ws1.botToken).toBe("original-ws1-token-value");
    expect(result.channels.slack.accounts.ws2.botToken).toBe("user-typed-new-token-value");
  });

  it.each<{ name: string; hints: ConfigUiHints; warningPath: string }>([
    {
      name: "schema hints",
      hints: { "channels.*.token": { sensitive: true } },
      warningPath: "channels.*.token",
    },
    {
      name: "heuristic fallback",
      hints: { "gateway.auth.token": { sensitive: true } },
      warningPath: "channels.newChannel.token",
    },
  ])("warns on missing originals only during writes with $name", async ({ hints, warningPath }) => {
    const original = { channels: { existing: { token: "existing" } } };
    const incoming = { channels: { newChannel: { token: REDACTED_SENTINEL } } };
    const warnLogs = createWarnLogCapture("openclaw-config-redaction-test");
    try {
      // Raw replacement also changes the channel key, so its sentinel has no matching original.
      expect(redactConfigSnapshot(makeSnapshot(original), hints).raw).toBeNull();
      expect(await warnLogs.findText("Cannot un-redact config key")).toBeUndefined();

      expect(restoreRedactedValues_orig(incoming, original, hints).ok).toBe(false);
      expect(await warnLogs.findText("Cannot un-redact config key")).toContain(warningPath);
    } finally {
      warnLogs.cleanup();
    }
  });

  it("keeps array truncation warnings during raw validation", async () => {
    const snapshot = makeSnapshot({ plugins: { allow: ["source"] } });
    const runtimeConfig = { plugins: { allow: ["source", "runtime-default"] } };
    const warnLogs = createWarnLogCapture("openclaw-config-redaction-array-test");
    try {
      const result = redactConfigSnapshot({ ...snapshot, config: runtimeConfig, runtimeConfig });
      expect(result.raw).toBe(snapshot.raw);
      expect(await warnLogs.findText("Redacted config array key plugins.allow[]")).toContain(
        "has been truncated",
      );
    } finally {
      warnLogs.cleanup();
    }
  });

  it.each(["toString", "constructor", "valueOf", "hasOwnProperty"])(
    "rejects inherited %s values when the original key is missing",
    (key) => {
      const hints = { [key]: { sensitive: true } };
      const result = restoreRedactedValues_orig({ [key]: REDACTED_SENTINEL }, {}, hints);

      expect(result.ok).toBe(false);
    },
  );

  it("rejects invalid restore inputs", () => {
    const invalidInputs = [null, undefined, "token-value"] as const;
    for (const input of invalidInputs) {
      const result = restoreRedactedValues_orig(input, { token: "x" });
      expect(result.ok).toBe(false);
    }
    expect(restoreRedactedValues_orig("token-value", { token: "x" })).toEqual({
      ok: false,
      error: "input not an object",
    });
  });

  it("returns a human-readable error when sentinel cannot be restored", () => {
    const incoming = {
      channels: { newChannel: { token: REDACTED_SENTINEL } },
    };
    const result = restoreRedactedValues_orig(incoming, {});
    expect(result.ok).toBe(false);
    expect(result.humanReadableMessage).toContain(REDACTED_SENTINEL);
    expect(result.humanReadableMessage).toContain("channels.newChannel.token");
  });

  it("rejects sentinel literals that survive restore", () => {
    const hints: ConfigUiHints = {
      "custom.*": { sensitive: true },
    };
    const incoming = {
      custom: { items: [REDACTED_SENTINEL] },
    };
    const original = {
      custom: { items: ["original-secret-value"] },
    };
    const result = restoreRedactedValues_orig(incoming, original, hints);
    expect(result.ok).toBe(false);
    expect(result.humanReadableMessage).toContain("Reserved redaction sentinel");
  });

  it("round-trips config through redact → restore", () => {
    const originalConfig = {
      gateway: { auth: { token: "gateway-auth-secret-token-value" }, port: 18789 },
      channels: {
        slack: { botToken: "fake-slack-token-placeholder-value" },
        telegram: {
          botToken: "fake-telegram-token-placeholder-value",
          webhookSecret: "fake-tg-secret-placeholder-value",
        },
      },
      models: {
        providers: {
          openai: {
            apiKey: "sk-proj-fake-openai-api-key-value",
            baseUrl: "https://api.openai.com",
          },
        },
      },
      ui: { seamColor: "#0088cc" },
    };
    const snapshot = makeSnapshot(originalConfig);
    const redacted = redactConfigSnapshot(snapshot);
    const restored = restoreRedactedValues(redacted.config, snapshot.config);
    expect(restored).toEqual(originalConfig);
  });

  it("round-trips with uiHints for custom sensitive fields", () => {
    const hints: ConfigUiHints = {
      "custom.myApiKey": { sensitive: true },
      "custom.displayName": { sensitive: false },
    };
    const originalConfig = {
      custom: { myApiKey: "secret-custom-api-key-value", displayName: "My Bot" },
    };
    const snapshot = makeSnapshot(originalConfig);
    const redacted = redactConfigSnapshot(snapshot, hints);
    expect(redacted.config).toEqual({
      custom: { myApiKey: REDACTED_SENTINEL, displayName: "My Bot" },
    });
    expect(restoreRedactedValues(redacted.config, snapshot.config, hints)).toEqual(originalConfig);
  });

  it("rejects sentinel literals even when uiHints mark the path non-sensitive", () => {
    const hints: ConfigUiHints = {
      "gateway.auth.token": { sensitive: false },
    };
    const incoming = {
      gateway: { auth: { token: REDACTED_SENTINEL } },
    };
    const original = {
      gateway: { auth: { token: "real-secret" } },
    };
    const result = restoreRedactedValues_orig(incoming, original, hints);
    expect(result.ok).toBe(false);
    expect(result.humanReadableMessage).toContain("Reserved redaction sentinel");
  });

  it.each<{ name: string; field: string; hints: ConfigUiHints }>([
    {
      name: "known URL path marked non-sensitive",
      field: "baseUrl",
      hints: { "channels.proofchat.baseUrl": { sensitive: false } },
    },
    {
      name: "URL hint marked non-sensitive",
      field: "endpoint",
      hints: { "channels.proofchat.endpoint": { sensitive: false, tags: ["url-secret"] } },
    },
    {
      name: "wildcard URL hint marked non-sensitive",
      field: "endpoint",
      hints: { "channels.proofchat.*": { sensitive: false, tags: ["url-secret"] } },
    },
  ])("round-trips redacted URLs with $name", ({ field, hints }) => {
    const original = {
      channels: { proofchat: { [field]: "https://example.test/v1?token=synthetic-query" } },
    };
    const redacted = redactConfigSnapshot(makeSnapshot(original), hints);
    expect(redacted.config).toEqual({ channels: { proofchat: { [field]: REDACTED_SENTINEL } } });
    expect(restoreRedactedValues_orig(redacted.config, original, hints)).toEqual({
      ok: true,
      result: original,
    });
    const safe = { channels: { proofchat: { [field]: "https://example.test/v1" } } };
    expect(redactConfigSnapshot(makeSnapshot(safe), hints).config).toEqual(safe);
    expect(
      restoreRedactedValues_orig(redacted.config, { channels: { proofchat: {} } }, hints).ok,
    ).toBe(false);
  });

  it("restores array items using wildcard uiHints", () => {
    const hints: ConfigUiHints = {
      "channels.slack.accounts[].botToken": { sensitive: true },
    };
    const incoming = {
      channels: {
        slack: {
          accounts: [
            { botToken: REDACTED_SENTINEL },
            { botToken: "user-provided-new-token-value" },
          ],
        },
      },
    };
    const original = {
      channels: {
        slack: {
          accounts: [
            { botToken: "original-token-first-account" },
            { botToken: "original-token-second-account" },
          ],
        },
      },
    };
    const result = restoreRedactedValues(incoming, original, hints);
    expect(result.channels.slack.accounts).toEqual([
      { botToken: "original-token-first-account" },
      { botToken: "user-provided-new-token-value" },
    ]);
  });

  describe.each([
    { name: "schema hints", hints: { "accounts[].token": { sensitive: true } } },
    { name: "sensitive-path guessing", hints: undefined },
  ])("stable array identities with $name", ({ hints }) => {
    const original = {
      accounts: [
        { id: "alpha", token: "synthetic-alpha-token" },
        { id: "bravo", token: "synthetic-bravo-token" },
        { id: "charlie", token: "synthetic-charlie-token" },
      ],
    };

    it.each([
      { change: "deleting an earlier entry", ids: ["bravo", "charlie"] },
      { change: "reordering the entries", ids: ["charlie", "alpha", "bravo"] },
    ])("restores each owner's secret after $change", ({ ids }) => {
      const incoming = {
        accounts: ids.map((id) => ({ id, token: REDACTED_SENTINEL })),
      };

      const restored = restoreRedactedValues(incoming, original, hints);

      expect(restored.accounts).toEqual(ids.map((id) => ({ id, token: `synthetic-${id}-token` })));
    });

    it.each([
      { kind: "unidentified", siblings: [{ token: "synthetic-unidentified-token" }] },
      {
        kind: "ambiguous",
        siblings: [
          { id: "duplicate", token: "synthetic-first-duplicate-token" },
          { id: "duplicate", token: "synthetic-second-duplicate-token" },
        ],
      },
    ])("keeps a unique owner's secret when $kind siblings are deleted", ({ siblings }) => {
      const previous = {
        accounts: [...siblings, { id: "bravo", token: "synthetic-bravo-token" }],
      };
      const incoming = { accounts: [{ id: "bravo", token: REDACTED_SENTINEL }] };

      expect(restoreRedactedValues(incoming, previous, hints).accounts).toEqual([
        { id: "bravo", token: "synthetic-bravo-token" },
      ]);
    });

    it("rejects a redacted secret for a new identity instead of borrowing its position", () => {
      const result = restoreRedactedValues_orig(
        { accounts: [{ id: "new-owner", token: REDACTED_SENTINEL }] },
        original,
        hints,
      );

      expect(result.ok).toBe(false);
      expect(result.humanReadableMessage).not.toContain("synthetic-alpha-token");
    });

    it("accepts a new identity when its secret was explicitly supplied", () => {
      const restored = restoreRedactedValues(
        { accounts: [{ id: "new-owner", token: "synthetic-new-token" }] },
        original,
        hints,
      );

      expect(restored.accounts).toEqual([{ id: "new-owner", token: "synthetic-new-token" }]);
    });

    it("matches prototype-shaped identities without inherited-key collisions", () => {
      const previous = {
        accounts: [
          { id: "__proto__", token: "synthetic-prototype-token" },
          { id: "constructor", token: "synthetic-constructor-token" },
        ],
      };
      const incoming = {
        accounts: [
          { id: "constructor", token: REDACTED_SENTINEL },
          { id: "__proto__", token: REDACTED_SENTINEL },
        ],
      };

      expect(restoreRedactedValues(incoming, previous, hints).accounts).toEqual([
        { id: "constructor", token: "synthetic-constructor-token" },
        { id: "__proto__", token: "synthetic-prototype-token" },
      ]);
    });

    it("keeps escaped environment identities positional after runtime substitution", () => {
      const previous = {
        accounts: [
          { id: "${ACCOUNT_ID}", token: "synthetic-literal-token" },
          { id: "bravo", token: "synthetic-bravo-token" },
        ],
      };
      const incoming = {
        accounts: [
          { id: "$${ACCOUNT_ID}", token: REDACTED_SENTINEL },
          { id: "bravo", token: REDACTED_SENTINEL },
        ],
      };

      expect(restoreRedactedValues(incoming, previous, hints).accounts).toEqual([
        { id: "$${ACCOUNT_ID}", token: "synthetic-literal-token" },
        { id: "bravo", token: "synthetic-bravo-token" },
      ]);
    });

    it("rejects moving an unidentified redacted entry onto an identified owner's position", () => {
      const previous = {
        accounts: [
          { token: "synthetic-unidentified-token" },
          { id: "bravo", token: "synthetic-bravo-token" },
        ],
      };
      const incoming = {
        accounts: [{ id: "bravo", token: REDACTED_SENTINEL }, { token: REDACTED_SENTINEL }],
      };

      const result = restoreRedactedValues_orig(incoming, previous, hints);

      expect(result.ok).toBe(false);
      expect(result.humanReadableMessage).not.toContain("synthetic-bravo-token");
    });

    it.each([
      {
        reason: "original identities are duplicated",
        previous: [{ id: "duplicate" }, { id: "duplicate" }],
        incoming: [{ id: "duplicate" }, { id: "duplicate" }],
      },
      {
        reason: "incoming identities are duplicated",
        previous: [{ id: "alpha" }, { id: "bravo" }],
        incoming: [{ id: "alpha" }, { id: "alpha" }],
      },
      {
        reason: "an original identity is missing",
        previous: [{ id: "alpha" }, {}],
        incoming: [{ id: "alpha" }, {}],
      },
      {
        reason: "an incoming identity is missing",
        previous: [{ id: "alpha" }, { id: "bravo" }],
        incoming: [{ id: "alpha" }, {}],
      },
      {
        reason: "an identity is empty",
        previous: [{ id: "" }, { id: "bravo" }],
        incoming: [{ id: "" }, { id: "bravo" }],
      },
      {
        reason: "an incoming identity is an unresolved environment placeholder",
        previous: [{ id: "alpha" }, { id: "bravo" }],
        incoming: [{ id: "${ACCOUNT_ID}" }, { id: "bravo" }],
      },
      {
        reason: "an incoming identity contains an inline environment placeholder",
        previous: [{ id: "account-alpha" }, { id: "bravo" }],
        incoming: [{ id: "account-${ACCOUNT_ID}" }, { id: "bravo" }],
      },
    ])("keeps positional restoration when $reason", ({ previous, incoming }) => {
      const restored = restoreRedactedValues(
        { accounts: incoming.map((entry) => ({ ...entry, token: REDACTED_SENTINEL })) },
        {
          accounts: previous.map((entry, index) => ({
            ...entry,
            token: `synthetic-${index}-token`,
          })),
        },
        hints,
      );

      expect(restored.accounts.map((entry) => entry.token)).toEqual([
        "synthetic-0-token",
        "synthetic-1-token",
      ]);
    });
  });

  it("matches stable identities independently at each nested array boundary", () => {
    const hints: ConfigUiHints = {
      "providers[].accounts[].token": { sensitive: true },
    };
    const original = {
      providers: [
        {
          id: "provider-alpha",
          accounts: [{ id: "account-one", token: "synthetic-alpha-one-token" }],
        },
        {
          id: "provider-bravo",
          accounts: [
            { id: "account-one", token: "synthetic-bravo-one-token" },
            { id: "account-two", token: "synthetic-bravo-two-token" },
          ],
        },
      ],
    };
    const incoming = {
      providers: [
        {
          id: "provider-bravo",
          accounts: [
            { id: "account-two", token: REDACTED_SENTINEL },
            { id: "account-one", token: REDACTED_SENTINEL },
          ],
        },
      ],
    };

    const restored = restoreRedactedValues(incoming, original, hints);

    expect(restored.providers).toEqual([
      {
        id: "provider-bravo",
        accounts: [
          { id: "account-two", token: "synthetic-bravo-two-token" },
          { id: "account-one", token: "synthetic-bravo-one-token" },
        ],
      },
    ]);
  });

  it("keeps positional restoration for arrays of scalar secrets", () => {
    const hints: ConfigUiHints = { "apiKeys[]": { sensitive: true } };
    const original = { apiKeys: ["synthetic-first-key", "synthetic-second-key"] };

    const restored = restoreRedactedValues(
      { apiKeys: [REDACTED_SENTINEL, REDACTED_SENTINEL] },
      original,
      hints,
    );

    expect(restored).toEqual(original);
  });

  it("does not treat a redacted identifier as a stable array identity", () => {
    const hints: ConfigUiHints = {
      "accounts[].id": { sensitive: true },
      "accounts[].token": { sensitive: true },
    };
    const original = {
      accounts: [
        { id: "synthetic-first-id", token: "synthetic-first-token" },
        { id: "synthetic-second-id", token: "synthetic-second-token" },
      ],
    };
    const incoming = {
      accounts: [
        { id: REDACTED_SENTINEL, token: REDACTED_SENTINEL },
        { id: REDACTED_SENTINEL, token: REDACTED_SENTINEL },
      ],
    };

    expect(restoreRedactedValues(incoming, original, hints)).toEqual(original);
  });

  it("keeps reordered hook-mapping session keys redacted until identity-based restoration", () => {
    const hints: ConfigUiHints = { "hooks.mappings[].sessionKey": { sensitive: true } };
    const original = {
      hooks: {
        mappings: [
          { id: "alpha", sessionKey: "synthetic-alpha-session" },
          { id: "bravo", sessionKey: "synthetic-bravo-session" },
        ],
      },
    };
    const redacted = redactConfigSnapshot(makeSnapshot(original), hints);
    const incoming = {
      hooks: { mappings: [(redacted.config as typeof original).hooks.mappings[1]] },
    };

    expect(JSON.stringify(redacted)).not.toContain("synthetic-alpha-session");
    expect(JSON.stringify(redacted)).not.toContain("synthetic-bravo-session");
    expect(incoming.hooks.mappings[0]?.sessionKey).toBe(REDACTED_SENTINEL);
    expect(restoreRedactedValues(incoming, original, hints).hooks.mappings).toEqual([
      { id: "bravo", sessionKey: "synthetic-bravo-session" },
    ]);
  });

  it("restores redacted SecretRef ids for channels token paths", () => {
    const hints: ConfigUiHints = {
      "channels.discord.token": { sensitive: true },
    };
    const incoming = {
      channels: {
        discord: {
          token: {
            source: "env",
            provider: "default",
            id: REDACTED_SENTINEL,
          },
        },
      },
    };
    const original = {
      channels: {
        discord: {
          token: {
            source: "env",
            provider: "default",
            id: "DISCORD_BOT_TOKEN",
          },
        },
      },
    };
    const result = restoreRedactedValues(incoming, original, hints);
    expect(result.channels.discord.token).toEqual({
      source: "env",
      provider: "default",
      id: "DISCORD_BOT_TOKEN",
    });
  });

  it("rejects SecretRef source/provider changes when id is still redacted", () => {
    const incoming = {
      models: {
        providers: {
          default: {
            apiKey: {
              source: "file",
              provider: "vault",
              id: REDACTED_SENTINEL,
            },
          },
        },
      },
    };
    const original = {
      models: {
        providers: {
          default: {
            apiKey: {
              source: "env",
              provider: "default",
              id: "OPENAI_API_KEY",
            },
          },
        },
      },
    };
    const result = restoreRedactedValues_orig(incoming, original, mainSchemaHints);
    expect(result.ok).toBe(false);
    expect(result.humanReadableMessage).toContain("changed source/provider");
  });

  it("reports a provider-focused error when original SecretRefs lack provider", () => {
    const incoming = {
      models: {
        providers: {
          default: {
            apiKey: {
              source: "env",
              id: REDACTED_SENTINEL,
            },
          },
        },
      },
    };
    const original = {
      models: {
        providers: {
          default: {
            apiKey: {
              source: "env",
              id: "OPENAI_API_KEY",
            },
          },
        },
      },
    };
    const result = restoreRedactedValues_orig(incoming, original, mainSchemaHints);
    expect(result.ok).toBe(false);
    expect(result.humanReadableMessage).toContain("requires a provider field");
  });
});
