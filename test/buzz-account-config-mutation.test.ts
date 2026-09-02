import { afterEach, expect, it, vi } from "vitest";
import { buzzPlugin, resolveBuzzAccount } from "../extensions/buzz/api.js";
import {
  applyPreparedChannelAccountConfiguration,
  prepareChannelAccountConfiguration,
} from "../src/channels/plugins/account-config-mutation.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";

const rootKey = "11".repeat(32);
const roomId = "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c";
const root = {
  relayUrl: "wss://root.example.com",
  privateKey: rootKey,
  name: "Root",
  groupPolicy: "allowlist" as const,
  groups: { [roomId]: { enabled: true } },
};
const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

afterEach(() => vi.unstubAllEnvs());

it.each([
  { label: "root plaintext", section: root },
  {
    label: "root environment",
    section: { relayUrl: root.relayUrl, name: root.name, groups: root.groups },
  },
  {
    label: "root without generic promotion keys",
    section: { relayUrl: root.relayUrl, privateKey: rootKey },
  },
  {
    label: "existing named identity",
    section: {
      ...root,
      accounts: {
        existing: { relayUrl: "wss://existing.example.com", privateKey: "33".repeat(32) },
      },
    },
  },
  {
    label: "explicit default identity",
    section: {
      ...root,
      accounts: { default: { relayUrl: "wss://default.example.com", privateKey: "44".repeat(32) } },
    },
  },
])("preserves $label through named Buzz account setup", async ({ section }) => {
  vi.stubEnv("BUZZ_PRIVATE_KEY", rootKey);
  const cfg: OpenClawConfig = { channels: { buzz: structuredClone(section) } };
  const before = structuredClone(cfg);
  const originalAccount = resolveBuzzAccount({ cfg, accountId: "default" });
  const prepared = await prepareChannelAccountConfiguration({
    cfg,
    plugin: buzzPlugin,
    requestedAccountId: "ada",
    resolveInput: () => ({
      name: " Ada ",
      relayUrl: "wss://ada.example.com",
      privateKey: "22".repeat(32),
    }),
    runtime,
  });
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) {
    throw new Error("Buzz account setup was rejected");
  }
  const applied = await applyPreparedChannelAccountConfiguration({
    cfg,
    channel: "buzz",
    prepared: prepared.value,
    runtime,
  });
  const { accounts, ...unchangedRoot } = applied.nextConfig.channels!.buzz!;
  const { accounts: originalAccounts, ...expectedRoot } = before.channels!.buzz!;
  expect(unchangedRoot).toEqual(expectedRoot);
  expect(accounts).toEqual({
    ...originalAccounts,
    ada: {
      enabled: true,
      name: "Ada",
      relayUrl: "wss://ada.example.com",
      privateKey: "22".repeat(32),
    },
  });
  expect(resolveBuzzAccount({ cfg: applied.nextConfig, accountId: "default" })).toMatchObject({
    publicKey: originalAccount.publicKey,
    relayUrl: originalAccount.relayUrl,
    configured: originalAccount.configured,
  });
  expect(cfg).toEqual(before);
});
