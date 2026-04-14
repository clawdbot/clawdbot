import { describe, expect, it } from "vitest";
import {
  collectUnsupportedSecretRefConfigCandidates,
  getUnsupportedSecretRefSurfacePatterns,
} from "./unsupported-surface-policy.js";

describe("unsupported SecretRef surface policy metadata", () => {
  it("exposes the canonical unsupported surface patterns", () => {
    expect(getUnsupportedSecretRefSurfacePatterns().toSorted()).toEqual(
      [
        "commands.ownerDisplaySecret",
        "hooks.token",
        "hooks.gmail.pushToken",
        "hooks.mappings[].sessionKey",
        "auth-profiles.oauth.*",
        "channels.discord.threadBindings.webhookToken",
        "channels.discord.accounts.*.threadBindings.webhookToken",
        "channels.whatsapp.creds.json",
        "channels.whatsapp.accounts.*.creds.json",
      ].toSorted(),
    );
  });

  it("discovers concrete config candidates for unsupported mutable surfaces", () => {
    const candidates = collectUnsupportedSecretRefConfigCandidates({
      commands: { ownerDisplaySecret: { source: "env", provider: "default", id: "OWNER" } },
      hooks: {
        token: { source: "env", provider: "default", id: "HOOK_TOKEN" },
        gmail: { pushToken: { source: "env", provider: "default", id: "GMAIL_PUSH" } },
        mappings: [{ sessionKey: { source: "env", provider: "default", id: "S0" } }],
      },
      channels: {
        discord: {
          threadBindings: {
            webhookToken: { source: "env", provider: "default", id: "DISCORD_WEBHOOK" },
          },
          accounts: {
            ops: {
              threadBindings: {
                webhookToken: {
                  source: "env",
                  provider: "default",
                  id: "DISCORD_WEBHOOK_OPS",
                },
              },
            },
          },
        },
        whatsapp: {
          creds: { json: { source: "env", provider: "default", id: "WHATSAPP_JSON" } },
          accounts: {
            ops: {
              creds: {
                json: { source: "env", provider: "default", id: "WHATSAPP_JSON_OPS" },
              },
            },
          },
        },
      },
    });

    expect(candidates.map((candidate) => candidate.path).toSorted()).toEqual(
      [
        "commands.ownerDisplaySecret",
        "hooks.token",
        "hooks.gmail.pushToken",
        "hooks.mappings.0.sessionKey",
        "channels.discord.threadBindings.webhookToken",
        "channels.discord.accounts.ops.threadBindings.webhookToken",
        "channels.whatsapp.creds.json",
        "channels.whatsapp.accounts.ops.creds.json",
      ].toSorted(),
    );
  });
});
