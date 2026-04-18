import { describe, expect, it, vi } from "vitest";
import {
  createPluginSetupWizardConfigure,
  createTestWizardPrompter,
  runSetupWizardConfigure,
  type WizardPrompter,
} from "../../../test/helpers/plugins/setup-wizard.js";
import type { OpenClawConfig } from "../runtime-api.js";
import { nostrSetupWizard } from "./setup-surface.js";
import {
  TEST_HEX_PRIVATE_KEY,
  TEST_SETUP_RELAY_URLS,
  buildResolvedNostrAccount,
  createConfiguredNostrCfg,
} from "./test-fixtures.js";
import { listNostrAccountIds, resolveDefaultNostrAccountId, resolveNostrAccount } from "./types.js";

function normalizeNostrTestEntry(entry: string): string {
  return entry
    .trim()
    .replace(/^nostr:/i, "")
    .toLowerCase();
}

function resolveNostrTestDmPolicy(params: {
  cfg: OpenClawConfig;
  account: ReturnType<typeof resolveNostrAccount>;
}) {
  return {
    cfg: params.cfg,
    accountId: params.account.accountId,
    policy: params.account.config.dmPolicy ?? "pairing",
    allowFrom: params.account.config.allowFrom ?? [],
    normalizeEntry: normalizeNostrTestEntry,
  };
}

const nostrTestPlugin = {
  id: "nostr",
  meta: {
    label: "Nostr",
    docsPath: "/channels/nostr",
    blurb: "Decentralized DMs via Nostr relays (NIP-04)",
  },
  capabilities: {
    chatTypes: ["direct"],
    media: false,
  },
  config: {
    listAccountIds: listNostrAccountIds,
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) =>
      resolveNostrAccount({ cfg, accountId }),
  },
  messaging: {
    normalizeTarget: (target: string) => normalizeNostrTestEntry(target),
    targetResolver: {
      looksLikeId: (input: string) => {
        const trimmed = input.trim();
        return trimmed.startsWith("npub1") || /^[0-9a-fA-F]{64}$/.test(trimmed);
      },
    },
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
  },
  pairing: {
    idLabel: "nostrPubkey",
    normalizeAllowEntry: normalizeNostrTestEntry,
  },
  security: {
    resolveDmPolicy: resolveNostrTestDmPolicy,
  },
  status: {
    defaultRuntime: {
      accountId: "default",
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
  },
  setupWizard: nostrSetupWizard,
  setup: {
    resolveAccountId: ({
      cfg,
      accountId,
    }: {
      cfg: OpenClawConfig;
      accountId?: string;
      input: unknown;
    }) => accountId?.trim() || resolveDefaultNostrAccountId(cfg),
  },
};

const nostrConfigure = createPluginSetupWizardConfigure(nostrTestPlugin);

function requireNostrLooksLikeId() {
  const looksLikeId = nostrTestPlugin.messaging?.targetResolver?.looksLikeId;
  if (!looksLikeId) {
    throw new Error("nostr messaging.targetResolver.looksLikeId missing");
  }
  return looksLikeId;
}

function requireNostrNormalizeTarget() {
  const normalize = nostrTestPlugin.messaging?.normalizeTarget;
  if (!normalize) {
    throw new Error("nostr messaging.normalizeTarget missing");
  }
  return normalize;
}

function requireNostrPairingNormalizer() {
  const normalize = nostrTestPlugin.pairing?.normalizeAllowEntry;
  if (!normalize) {
    throw new Error("nostr pairing.normalizeAllowEntry missing");
  }
  return normalize;
}

function requireNostrResolveDmPolicy() {
  const resolveDmPolicy = nostrTestPlugin.security?.resolveDmPolicy;
  if (!resolveDmPolicy) {
    throw new Error("nostr security.resolveDmPolicy missing");
  }
  return resolveDmPolicy;
}

describe("nostrPlugin", () => {
  describe("meta", () => {
    it("has correct id", () => {
      expect(nostrTestPlugin.id).toBe("nostr");
    });

    it("has required meta fields", () => {
      expect(nostrTestPlugin.meta.label).toBe("Nostr");
      expect(nostrTestPlugin.meta.docsPath).toBe("/channels/nostr");
      expect(nostrTestPlugin.meta.blurb).toContain("NIP-04");
    });
  });

  describe("capabilities", () => {
    it("supports direct messages", () => {
      expect(nostrTestPlugin.capabilities.chatTypes).toContain("direct");
    });

    it("does not support groups (MVP)", () => {
      expect(nostrTestPlugin.capabilities.chatTypes).not.toContain("group");
    });

    it("does not support media (MVP)", () => {
      expect(nostrTestPlugin.capabilities.media).toBe(false);
    });
  });

  describe("config adapter", () => {
    it("listAccountIds returns empty array for unconfigured", () => {
      const cfg = { channels: {} };
      const ids = nostrTestPlugin.config.listAccountIds(cfg);
      expect(ids).toEqual([]);
    });

    it("listAccountIds returns default for configured", () => {
      const cfg = createConfiguredNostrCfg();
      const ids = nostrTestPlugin.config.listAccountIds(cfg);
      expect(ids).toContain("default");
    });
  });

  describe("messaging", () => {
    it("recognizes npub as valid target", () => {
      const looksLikeId = requireNostrLooksLikeId();

      expect(looksLikeId("npub1xyz123")).toBe(true);
    });

    it("recognizes hex pubkey as valid target", () => {
      const looksLikeId = requireNostrLooksLikeId();

      expect(looksLikeId(TEST_HEX_PRIVATE_KEY)).toBe(true);
    });

    it("rejects invalid input", () => {
      const looksLikeId = requireNostrLooksLikeId();

      expect(looksLikeId("not-a-pubkey")).toBe(false);
      expect(looksLikeId("")).toBe(false);
    });

    it("normalizeTarget strips spaced nostr prefixes", () => {
      const normalize = requireNostrNormalizeTarget();

      expect(normalize(`nostr:${TEST_HEX_PRIVATE_KEY}`)).toBe(TEST_HEX_PRIVATE_KEY);
      expect(normalize(`  nostr:${TEST_HEX_PRIVATE_KEY}  `)).toBe(TEST_HEX_PRIVATE_KEY);
    });
  });

  describe("outbound", () => {
    it("has correct delivery mode", () => {
      expect(nostrTestPlugin.outbound?.deliveryMode).toBe("direct");
    });

    it("has reasonable text chunk limit", () => {
      expect(nostrTestPlugin.outbound?.textChunkLimit).toBe(4000);
    });
  });

  describe("pairing", () => {
    it("has id label for pairing", () => {
      expect(nostrTestPlugin.pairing?.idLabel).toBe("nostrPubkey");
    });

    it("normalizes spaced nostr prefixes in allow entries", () => {
      const normalize = requireNostrPairingNormalizer();

      expect(normalize(`nostr:${TEST_HEX_PRIVATE_KEY}`)).toBe(TEST_HEX_PRIVATE_KEY);
      expect(normalize(`  nostr:${TEST_HEX_PRIVATE_KEY}  `)).toBe(TEST_HEX_PRIVATE_KEY);
    });
  });

  describe("security", () => {
    it("normalizes dm allowlist entries through the dm policy adapter", () => {
      const resolveDmPolicy = requireNostrResolveDmPolicy();

      const cfg = createConfiguredNostrCfg({
        dmPolicy: "allowlist",
        allowFrom: [`  nostr:${TEST_HEX_PRIVATE_KEY}  `],
      });
      const account = buildResolvedNostrAccount({
        config: cfg.channels.nostr,
      });

      const result = resolveDmPolicy({ cfg, account });
      if (!result) {
        throw new Error("nostr resolveDmPolicy returned null");
      }

      expect(result.policy).toBe("allowlist");
      expect(result.allowFrom).toEqual([`  nostr:${TEST_HEX_PRIVATE_KEY}  `]);
      expect(result.normalizeEntry?.(`  nostr:${TEST_HEX_PRIVATE_KEY}  `)).toBe(
        TEST_HEX_PRIVATE_KEY,
      );
    });
  });

  describe("status", () => {
    it("has default runtime", () => {
      expect(nostrTestPlugin.status?.defaultRuntime).toEqual({
        accountId: "default",
        running: false,
        lastStartAt: null,
        lastStopAt: null,
        lastError: null,
      });
    });
  });
});

describe("nostr setup wizard", () => {
  it("configures a private key and relay URLs", async () => {
    const prompter = createTestWizardPrompter({
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Nostr private key (nsec... or hex)") {
          return TEST_HEX_PRIVATE_KEY;
        }
        if (message === "Relay URLs (comma-separated, optional)") {
          return TEST_SETUP_RELAY_URLS.join(", ");
        }
        throw new Error(`Unexpected prompt: ${message}`);
      }) as WizardPrompter["text"],
    });

    const result = await runSetupWizardConfigure({
      configure: nostrConfigure,
      cfg: {} as OpenClawConfig,
      prompter,
      options: {},
    });

    expect(result.accountId).toBe("default");
    expect(result.cfg.channels?.nostr?.enabled).toBe(true);
    expect(result.cfg.channels?.nostr?.privateKey).toBe(TEST_HEX_PRIVATE_KEY);
    expect(result.cfg.channels?.nostr?.relays).toEqual(TEST_SETUP_RELAY_URLS);
  });

  it("preserves the selected named account label during setup", async () => {
    const prompter = createTestWizardPrompter({
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Nostr private key (nsec... or hex)") {
          return TEST_HEX_PRIVATE_KEY;
        }
        if (message === "Relay URLs (comma-separated, optional)") {
          return "";
        }
        throw new Error(`Unexpected prompt: ${message}`);
      }) as WizardPrompter["text"],
    });

    const result = await runSetupWizardConfigure({
      configure: nostrConfigure,
      cfg: {} as OpenClawConfig,
      prompter,
      options: {},
      accountOverrides: {
        nostr: "work",
      },
    });

    expect(result.accountId).toBe("work");
    expect(result.cfg.channels?.nostr?.defaultAccount).toBe("work");
    expect(result.cfg.channels?.nostr?.privateKey).toBe(TEST_HEX_PRIVATE_KEY);
  });

  it("uses configured defaultAccount when setup accountId is omitted", () => {
    expect(
      nostrTestPlugin.setup?.resolveAccountId?.({
        cfg: createConfiguredNostrCfg({ defaultAccount: "work" }) as OpenClawConfig,
        accountId: undefined,
        input: {},
      } as never),
    ).toBe("work");
  });
});

describe("nostr account helpers", () => {
  describe("listNostrAccountIds", () => {
    it("returns empty array when not configured", () => {
      const cfg = { channels: {} };
      expect(listNostrAccountIds(cfg)).toEqual([]);
    });

    it("returns empty array when nostr section exists but no privateKey", () => {
      const cfg = { channels: { nostr: { enabled: true } } };
      expect(listNostrAccountIds(cfg)).toEqual([]);
    });

    it("returns default when privateKey is configured", () => {
      const cfg = createConfiguredNostrCfg();
      expect(listNostrAccountIds(cfg)).toEqual(["default"]);
    });

    it("returns configured defaultAccount when privateKey is configured", () => {
      const cfg = createConfiguredNostrCfg({ defaultAccount: "work" });
      expect(listNostrAccountIds(cfg)).toEqual(["work"]);
    });

    it("does not treat unresolved SecretRef privateKey as configured", () => {
      const cfg = {
        channels: {
          nostr: {
            privateKey: {
              source: "env",
              provider: "default",
              id: "NOSTR_PRIVATE_KEY",
            },
          },
        },
      };
      expect(listNostrAccountIds(cfg)).toEqual([]);
    });
  });

  describe("resolveDefaultNostrAccountId", () => {
    it("returns default when configured", () => {
      const cfg = createConfiguredNostrCfg();
      expect(resolveDefaultNostrAccountId(cfg)).toBe("default");
    });

    it("returns default when not configured", () => {
      const cfg = { channels: {} };
      expect(resolveDefaultNostrAccountId(cfg)).toBe("default");
    });

    it("prefers configured defaultAccount when present", () => {
      const cfg = createConfiguredNostrCfg({ defaultAccount: "work" });
      expect(resolveDefaultNostrAccountId(cfg)).toBe("work");
    });
  });

  describe("resolveNostrAccount", () => {
    it("resolves configured account", () => {
      const cfg = createConfiguredNostrCfg({
        name: "Test Bot",
        relays: ["wss://test.relay"],
        dmPolicy: "pairing" as const,
      });
      const account = resolveNostrAccount({ cfg });

      expect(account.accountId).toBe("default");
      expect(account.name).toBe("Test Bot");
      expect(account.enabled).toBe(true);
      expect(account.configured).toBe(true);
      expect(account.privateKey).toBe(TEST_HEX_PRIVATE_KEY);
      expect(account.publicKey).toMatch(/^[0-9a-f]{64}$/);
      expect(account.relays).toEqual(["wss://test.relay"]);
    });

    it("resolves unconfigured account with defaults", () => {
      const cfg = { channels: {} };
      const account = resolveNostrAccount({ cfg });

      expect(account.accountId).toBe("default");
      expect(account.enabled).toBe(true);
      expect(account.configured).toBe(false);
      expect(account.privateKey).toBe("");
      expect(account.publicKey).toBe("");
      expect(account.relays).toContain("wss://relay.damus.io");
      expect(account.relays).toContain("wss://nos.lol");
    });

    it("handles disabled channel", () => {
      const cfg = createConfiguredNostrCfg({ enabled: false });
      const account = resolveNostrAccount({ cfg });

      expect(account.enabled).toBe(false);
      expect(account.configured).toBe(true);
    });

    it("handles custom accountId parameter", () => {
      const cfg = createConfiguredNostrCfg();
      const account = resolveNostrAccount({ cfg, accountId: "custom" });

      expect(account.accountId).toBe("custom");
    });

    it("handles allowFrom config", () => {
      const cfg = createConfiguredNostrCfg({
        allowFrom: ["npub1test", "0123456789abcdef"],
      });
      const account = resolveNostrAccount({ cfg });

      expect(account.config.allowFrom).toEqual(["npub1test", "0123456789abcdef"]);
    });

    it("handles invalid private key gracefully", () => {
      const cfg = {
        channels: {
          nostr: {
            privateKey: "invalid-key",
          },
        },
      };
      const account = resolveNostrAccount({ cfg });

      expect(account.configured).toBe(true);
      expect(account.publicKey).toBe("");
    });

    it("does not treat unresolved SecretRef privateKey as configured", () => {
      const secretRef = {
        source: "env" as const,
        provider: "default",
        id: "NOSTR_PRIVATE_KEY",
      };
      const cfg = {
        channels: {
          nostr: {
            privateKey: secretRef,
          },
        },
      };
      const account = resolveNostrAccount({ cfg });

      expect(account.configured).toBe(false);
      expect(account.privateKey).toBe("");
      expect(account.publicKey).toBe("");
      expect(account.config.privateKey).toEqual(secretRef);
    });

    it("preserves all config options", () => {
      const cfg = createConfiguredNostrCfg({
        name: "Bot",
        enabled: true,
        relays: ["wss://relay1", "wss://relay2"],
        dmPolicy: "allowlist" as const,
        allowFrom: ["pubkey1", "pubkey2"],
      });
      const account = resolveNostrAccount({ cfg });

      expect(account.config).toEqual({
        privateKey: TEST_HEX_PRIVATE_KEY,
        name: "Bot",
        enabled: true,
        relays: ["wss://relay1", "wss://relay2"],
        dmPolicy: "allowlist",
        allowFrom: ["pubkey1", "pubkey2"],
      });
    });
  });

  describe("setup wizard", () => {
    it("keeps unresolved SecretRef privateKey visible without marking the account configured", () => {
      const secretRef = {
        source: "env" as const,
        provider: "default",
        id: "NOSTR_PRIVATE_KEY",
      };
      const cfg = {
        channels: {
          nostr: {
            privateKey: secretRef,
          },
        },
      };
      const credential = nostrSetupWizard.credentials?.[0];
      if (!credential?.inspect) {
        throw new Error("nostr setup credential inspect missing");
      }

      expect(credential.inspect({ cfg, accountId: "default" })).toEqual({
        accountConfigured: false,
        hasConfiguredValue: true,
        resolvedValue: undefined,
        envValue: undefined,
      });
    });
  });
});
