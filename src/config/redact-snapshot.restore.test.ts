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
