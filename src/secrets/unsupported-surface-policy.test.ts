import { describe, expect, it, vi } from "vitest";

const { loadBundledChannelSecurityContractApiMock, loadPluginManifestRegistryMock } = vi.hoisted(
  () => ({
    loadBundledChannelSecurityContractApiMock: vi.fn((channelId: string) => {
      if (channelId === "discord") {
        return {
          unsupportedSecretRefSurfacePatterns: [
            "channels.discord.threadBindings.webhookToken",
            "channels.discord.accounts.*.threadBindings.webhookToken",
          ],
          collectUnsupportedSecretRefConfigCandidates: (raw: Record<string, unknown>) => {
            const discord = (raw.channels as Record<string, unknown> | undefined)?.discord as
              | Record<string, unknown>
              | undefined;
            const candidates: Array<{ path: string; value: unknown }> = [];
            const threadBindings = discord?.threadBindings as Record<string, unknown> | undefined;
            candidates.push({
              path: "channels.discord.threadBindings.webhookToken",
              value: threadBindings?.webhookToken,
            });
            const accounts = discord?.accounts as Record<string, unknown> | undefined;
            for (const [accountId, account] of Object.entries(accounts ?? {})) {
              const accountThreadBindings = (account as Record<string, unknown>).threadBindings as
                | Record<string, unknown>
                | undefined;
              candidates.push({
                path: `channels.discord.accounts.${accountId}.threadBindings.webhookToken`,
                value: accountThreadBindings?.webhookToken,
              });
            }
            return candidates;
          },
        };
      }
      if (channelId === "whatsapp") {
        return {
          unsupportedSecretRefSurfacePatterns: [
            "channels.whatsapp.creds.json",
            "channels.whatsapp.accounts.*.creds.json",
          ],
          collectUnsupportedSecretRefConfigCandidates: (raw: Record<string, unknown>) => {
            const whatsapp = (raw.channels as Record<string, unknown> | undefined)?.whatsapp as
              | Record<string, unknown>
              | undefined;
            const candidates: Array<{ path: string; value: unknown }> = [];
            const creds = whatsapp?.creds as Record<string, unknown> | undefined;
            candidates.push({
              path: "channels.whatsapp.creds.json",
              value: creds?.json,
            });
            const accounts = whatsapp?.accounts as Record<string, unknown> | undefined;
            for (const [accountId, account] of Object.entries(accounts ?? {})) {
              const accountCreds = (account as Record<string, unknown>).creds as
                | Record<string, unknown>
                | undefined;
              candidates.push({
                path: `channels.whatsapp.accounts.${accountId}.creds.json`,
                value: accountCreds?.json,
              });
            }
            return candidates;
          },
        };
      }
      return undefined;
    }),
    loadPluginManifestRegistryMock: vi.fn(() => ({
      plugins: [
        { id: "discord", origin: "bundled", channels: ["discord"] },
        { id: "whatsapp", origin: "bundled", channels: ["whatsapp"] },
      ],
      diagnostics: [],
    })),
  }),
);

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry: loadPluginManifestRegistryMock,
}));

vi.mock("./channel-contract-api.js", () => ({
  loadBundledChannelSecurityContractApi: loadBundledChannelSecurityContractApiMock,
}));

import {
  collectUnsupportedSecretRefConfigCandidates,
  getUnsupportedSecretRefSurfacePatterns,
} from "./unsupported-surface-policy.js";

describe("unsupported SecretRef surface policy metadata", () => {
  it("exposes the canonical unsupported surface patterns", () => {
    expect(getUnsupportedSecretRefSurfacePatterns()).toEqual([
      "commands.ownerDisplaySecret",
      "hooks.token",
      "hooks.gmail.pushToken",
      "hooks.mappings[].sessionKey",
      "auth-profiles.oauth.*",
      "channels.discord.threadBindings.webhookToken",
      "channels.discord.accounts.*.threadBindings.webhookToken",
      "channels.whatsapp.creds.json",
      "channels.whatsapp.accounts.*.creds.json",
    ]);
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
