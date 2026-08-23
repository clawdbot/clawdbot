// Covers restoring redacted config snapshots into writable config values.

import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { redactSnapshotTestHints as mainSchemaHints } from "../../test/helpers/config/redact-snapshot-test-hints.js";
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

  it("preserves explicitly changed sensitive values", () => {
    const incoming = {
      gateway: { auth: { token: "new-token-value-from-user" } },
    };
    const original = {
      gateway: { auth: { token: "old-token-value" } },
    };
    const result = restoreRedactedValues(incoming, original) as typeof incoming;
    expect(result.gateway.auth.token).toBe("new-token-value-from-user");
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
    const result = restoreRedactedValues(incoming, original) as typeof incoming;
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
    const result = restoreRedactedValues(incoming, original) as typeof incoming;
    expect(result.channels.slack.accounts.ws1.botToken).toBe("original-ws1-token-value");
    expect(result.channels.slack.accounts.ws2.botToken).toBe("user-typed-new-token-value");
  });

  it("handles missing original gracefully", () => {
    const incoming = {
      channels: { newChannel: { token: REDACTED_SENTINEL } },
    };
    const original = {};
    expect(restoreRedactedValues_orig(incoming, original).ok).toBe(false);
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
    const custom = (redacted.config as typeof originalConfig).custom as Record<string, string>;
    expect(custom.myApiKey).toBe(REDACTED_SENTINEL);
    expect(custom.displayName).toBe("My Bot");

    const restored = restoreRedactedValues(
      redacted.config,
      snapshot.config,
      hints,
    ) as typeof originalConfig;
    expect(restored).toEqual(originalConfig);
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
    const result = restoreRedactedValues(incoming, original, hints) as typeof incoming;
    expect(
      expectDefined(
        result.channels.slack.accounts[0],
        "result.channels.slack.accounts[0] test invariant",
      ).botToken,
    ).toBe("original-token-first-account");
    expect(
      expectDefined(
        result.channels.slack.accounts[1],
        "result.channels.slack.accounts[1] test invariant",
      ).botToken,
    ).toBe("user-provided-new-token-value");
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

    it("keeps a unique owner's secret when an unidentified sibling is deleted", () => {
      const previous = {
        accounts: [
          { token: "synthetic-unidentified-token" },
          { id: "bravo", token: "synthetic-bravo-token" },
        ],
      };
      const incoming = {
        accounts: [{ id: "bravo", token: REDACTED_SENTINEL }],
      };

      expect(restoreRedactedValues(incoming, previous, hints).accounts).toEqual([
        { id: "bravo", token: "synthetic-bravo-token" },
      ]);
    });

    it("keeps a unique owner's secret when ambiguous sibling identities are deleted", () => {
      const previous = {
        accounts: [
          { id: "duplicate", token: "synthetic-first-duplicate-token" },
          { id: "duplicate", token: "synthetic-second-duplicate-token" },
          { id: "bravo", token: "synthetic-bravo-token" },
        ],
      };
      const incoming = {
        accounts: [{ id: "bravo", token: REDACTED_SENTINEL }],
      };

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
        previous: [
          { id: "duplicate", token: "synthetic-first-token" },
          { id: "duplicate", token: "synthetic-second-token" },
        ],
        incoming: [
          { id: "duplicate", token: REDACTED_SENTINEL },
          { id: "duplicate", token: REDACTED_SENTINEL },
        ],
      },
      {
        reason: "incoming identities are duplicated",
        previous: [
          { id: "alpha", token: "synthetic-first-token" },
          { id: "bravo", token: "synthetic-second-token" },
        ],
        incoming: [
          { id: "alpha", token: REDACTED_SENTINEL },
          { id: "alpha", token: REDACTED_SENTINEL },
        ],
      },
      {
        reason: "an original identity is missing",
        previous: [
          { id: "alpha", token: "synthetic-first-token" },
          { token: "synthetic-second-token" },
        ],
        incoming: [{ id: "alpha", token: REDACTED_SENTINEL }, { token: REDACTED_SENTINEL }],
      },
      {
        reason: "an incoming identity is missing",
        previous: [
          { id: "alpha", token: "synthetic-first-token" },
          { id: "bravo", token: "synthetic-second-token" },
        ],
        incoming: [{ id: "alpha", token: REDACTED_SENTINEL }, { token: REDACTED_SENTINEL }],
      },
      {
        reason: "an identity is empty",
        previous: [
          { id: "", token: "synthetic-first-token" },
          { id: "bravo", token: "synthetic-second-token" },
        ],
        incoming: [
          { id: "", token: REDACTED_SENTINEL },
          { id: "bravo", token: REDACTED_SENTINEL },
        ],
      },
      {
        reason: "an incoming identity is an unresolved environment placeholder",
        previous: [
          { id: "alpha", token: "synthetic-first-token" },
          { id: "bravo", token: "synthetic-second-token" },
        ],
        incoming: [
          { id: "${ACCOUNT_ID}", token: REDACTED_SENTINEL },
          { id: "bravo", token: REDACTED_SENTINEL },
        ],
      },
      {
        reason: "an incoming identity contains an inline environment placeholder",
        previous: [
          { id: "account-alpha", token: "synthetic-first-token" },
          { id: "bravo", token: "synthetic-second-token" },
        ],
        incoming: [
          { id: "account-${ACCOUNT_ID}", token: REDACTED_SENTINEL },
          { id: "bravo", token: REDACTED_SENTINEL },
        ],
      },
    ])("keeps positional restoration when $reason", ({ previous, incoming }) => {
      const restored = restoreRedactedValues({ accounts: incoming }, { accounts: previous }, hints);

      expect(restored.accounts.map((entry) => entry.token)).toEqual([
        "synthetic-first-token",
        "synthetic-second-token",
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
