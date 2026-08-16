// Setup wizard helper tests cover channel setup step formatting and config writes.
import { expectDefined } from "@openclaw/normalization-core";
import {
  resolveSetupWizardAllowFromEntries,
  resolveSetupWizardGroupAllowlist,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  buildSingleChannelSecretPromptState,
  createAccountScopedAllowFromSection,
  createAccountScopedGroupAccessSection,
  createAllowFromSection,
  createPromptParsedAllowFromForAccount,
  createStandardChannelSetupStatus,
  createTopLevelChannelAllowFromSetter,
  createTopLevelChannelDmPolicy,
  createTopLevelChannelDmPolicySetter,
  createTopLevelChannelGroupPolicySetter,
  createTopLevelChannelParsedAllowFromPrompt,
  normalizeAllowFromEntries,
  noteChannelLookupFailure,
  noteChannelLookupSummary,
  parseMentionOrPrefixedId,
  parseSetupEntriesAllowingWildcard,
  patchChannelConfigForAccount,
  patchTopLevelChannelConfigSection,
  promptParsedAllowFromForAccount,
  parseSetupEntriesWithParser,
  promptSingleChannelSecretInput,
  promptResolvedAllowFrom,
  resolveAccountIdForConfigure,
  resolveEntriesWithOptionalToken,
  resolveSetupAccountId,
  setAccountAllowFromForChannel,
  setTopLevelChannelDmPolicyWithAllowFrom,
  setSetupChannelEnabled,
  splitSetupEntries,
} from "./setup-wizard-helpers.js";
import type { ChannelSetupAdapter } from "./types.adapters.js";

const matrixSingleAccountKeysToMove = [
  "allowBots",
  "deviceId",
  "deviceName",
  "dm",
  "encryption",
  "groups",
  "rooms",
] as const;
const matrixNamedAccountPromotionKeys = [
  "accessToken",
  "deviceId",
  "deviceName",
  "encryption",
  "homeserver",
  "userId",
] as const;
const telegramSingleAccountKeysToMove = ["streaming", "webhookSecret"] as const;
const telegramSetupSurface = {
  applyAccountConfig: ({ cfg }) => cfg,
  singleAccountKeysToMove: telegramSingleAccountKeysToMove,
} as ChannelSetupAdapter;

function collectNamedAccountIds(accounts: Record<string, unknown>): string[] {
  const ids: string[] = [];
  for (const accountId of Object.keys(accounts)) {
    if (accountId) {
      ids.push(accountId);
    }
  }
  return ids;
}

function resolveMatrixSingleAccountPromotionTarget(params: {
  channel: { defaultAccount?: string; accounts?: Record<string, unknown> };
}): string {
  const accounts = params.channel.accounts ?? {};
  const normalizedDefaultAccount = params.channel.defaultAccount?.trim()
    ? normalizeAccountId(params.channel.defaultAccount)
    : undefined;
  if (normalizedDefaultAccount) {
    return (
      Object.keys(accounts).find(
        (accountId) => normalizeAccountId(accountId) === normalizedDefaultAccount,
      ) ?? DEFAULT_ACCOUNT_ID
    );
  }
  const namedAccounts = collectNamedAccountIds(accounts);
  return namedAccounts.length === 1
    ? expectDefined(namedAccounts[0], "namedAccounts[0] test invariant")
    : DEFAULT_ACCOUNT_ID;
}

beforeEach(() => {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "matrix",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "matrix", label: "Matrix" }),
          setup: {
            singleAccountKeysToMove: matrixSingleAccountKeysToMove,
            namedAccountPromotionKeys: matrixNamedAccountPromotionKeys,
            resolveSingleAccountPromotionTarget: resolveMatrixSingleAccountPromotionTarget,
          },
        },
      },
      {
        pluginId: "telegram",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "telegram", label: "Telegram" }),
          setup: {
            singleAccountKeysToMove: telegramSingleAccountKeysToMove,
          },
        },
      },
    ]),
  );
});

afterAll(() => {
  resetPluginRuntimeStateForTest();
});

function createPrompter(inputs: string[]) {
  const text = vi.fn(async () => inputs.shift() ?? "");
  const note = vi.fn(async () => undefined);
  return {
    ...createWizardPrompter(),
    text,
    note,
  };
}

function parseCsvInputs(value: string): string[] {
  const entries: string[] = [];
  for (const part of value.split(",")) {
    const entry = part.trim();
    if (entry) {
      entries.push(entry);
    }
  }
  return entries;
}

type AllowFromResolver = (params: {
  token: string;
  entries: string[];
}) => Promise<Array<{ input: string; resolved: boolean; id?: string | null }>>;
function asAllowFromResolver(resolveEntries: ReturnType<typeof vi.fn>): AllowFromResolver {
  return resolveEntries as AllowFromResolver;
}

async function runPromptResolvedAllowFromWithToken(params: {
  prompter: ReturnType<typeof createPrompter>;
  resolveEntries: AllowFromResolver;
}) {
  return await promptResolvedAllowFrom({
    prompter: params.prompter,
    existing: [],
    token: "xoxb-test",
    message: "msg",
    placeholder: "placeholder",
    label: "allowlist",
    parseInputs: parseCsvInputs,
    parseId: () => null,
    invalidWithoutTokenNote: "ids only",
    resolveEntries: params.resolveEntries,
  });
}

function createSecretInputPrompter(params: {
  selects: string[];
  confirms?: boolean[];
  texts?: string[];
}) {
  const selects = [...params.selects];
  const confirms = [...(params.confirms ?? [])];
  const texts = [...(params.texts ?? [])];
  const confirm = vi.fn(async () => confirms.shift() ?? false);
  const text = vi.fn(async () => texts.shift() ?? "");
  const note = vi.fn(async () => undefined);
  const prompter = createWizardPrompter(undefined, {
    defaultSelect: "plaintext",
    selectValues: selects,
  });
  return {
    ...prompter,
    select: vi.mocked(prompter.select),
    confirm,
    text,
    note,
  };
}

async function runPromptSingleChannelSecretInput(params: {
  prompter: ReturnType<typeof createSecretInputPrompter>;
  providerHint: string;
  credentialLabel: string;
  accountConfigured: boolean;
  canUseEnv: boolean;
  hasConfigToken: boolean;
  preferredEnvVar: string;
}) {
  return await promptSingleChannelSecretInput({
    cfg: {},
    prompter: params.prompter,
    providerHint: params.providerHint,
    credentialLabel: params.credentialLabel,
    accountConfigured: params.accountConfigured,
    canUseEnv: params.canUseEnv,
    hasConfigToken: params.hasConfigToken,
    envPrompt: "use env",
    keepPrompt: "keep",
    inputPrompt: "token",
    preferredEnvVar: params.preferredEnvVar,
  });
}

describe("buildSingleChannelSecretPromptState", () => {
  it.each([
    {
      name: "enables env path only when env is present and no config token exists",
      input: {
        accountConfigured: false,
        hasConfigToken: false,
        allowEnv: true,
        envValue: "token-from-env",
      },
      expected: {
        accountConfigured: false,
        hasConfigToken: false,
        canUseEnv: true,
      },
    },
    {
      name: "disables env path when config token already exists",
      input: {
        accountConfigured: true,
        hasConfigToken: true,
        allowEnv: true,
        envValue: "token-from-env",
      },
      expected: {
        accountConfigured: true,
        hasConfigToken: true,
        canUseEnv: false,
      },
    },
  ])("$name", ({ input, expected }) => {
    expect(buildSingleChannelSecretPromptState(input)).toEqual(expected);
  });
});

describe("promptResolvedAllowFrom", () => {
  it("re-prompts without token until all ids are parseable", async () => {
    const prompter = createPrompter(["@alice", "123"]);
    const resolveEntries = vi.fn();

    const result = await promptResolvedAllowFrom({
      prompter,
      existing: ["111"],
      token: "",
      message: "msg",
      placeholder: "placeholder",
      label: "allowlist",
      parseInputs: parseCsvInputs,
      parseId: (value) => (/^\d+$/.test(value.trim()) ? value.trim() : null),
      invalidWithoutTokenNote: "ids only",
      resolveEntries: resolveEntries as Parameters<
        typeof promptResolvedAllowFrom
      >[0]["resolveEntries"],
    });

    expect(result).toEqual(["111", "123"]);
    expect(prompter.note).toHaveBeenCalledWith("ids only", "allowlist");
    expect(resolveEntries).not.toHaveBeenCalled();
  });

  it("re-prompts when token resolution returns unresolved entries", async () => {
    const prompter = createPrompter(["alice", "bob"]);
    const resolveEntries = vi
      .fn()
      .mockResolvedValueOnce([{ input: "alice", resolved: false }])
      .mockResolvedValueOnce([{ input: "bob", resolved: true, id: "U123" }]);

    const result = await runPromptResolvedAllowFromWithToken({
      prompter,
      resolveEntries: asAllowFromResolver(resolveEntries),
    });

    expect(result).toEqual(["U123"]);
    expect(prompter.note).toHaveBeenCalledWith("Could not resolve: alice", "allowlist");
    expect(resolveEntries).toHaveBeenCalledTimes(2);
  });

  it("re-prompts when resolver throws before succeeding", async () => {
    const prompter = createPrompter(["alice", "bob"]);
    const resolveEntries = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce([{ input: "bob", resolved: true, id: "U234" }]);

    const result = await runPromptResolvedAllowFromWithToken({
      prompter,
      resolveEntries: asAllowFromResolver(resolveEntries),
    });

    expect(result).toEqual(["U234"]);
    expect(prompter.note).toHaveBeenCalledWith(
      "Failed to resolve usernames. Try again.",
      "allowlist",
    );
    expect(resolveEntries).toHaveBeenCalledTimes(2);
  });
});

describe("promptSingleChannelSecretInput", () => {
  it("returns use-env action when plaintext mode selects env fallback", async () => {
    const prompter = createSecretInputPrompter({
      selects: ["plaintext"],
      confirms: [true],
    });

    const result = await runPromptSingleChannelSecretInput({
      prompter,
      providerHint: "telegram",
      credentialLabel: "Telegram bot token",
      accountConfigured: false,
      canUseEnv: true,
      hasConfigToken: false,
      preferredEnvVar: "TELEGRAM_BOT_TOKEN",
    });

    expect(result).toEqual({ action: "use-env" });
  });

  it("returns ref + resolved value when external env ref is selected", async () => {
    process.env.OPENCLAW_TEST_TOKEN = "secret-token";
    const prompter = createSecretInputPrompter({
      selects: ["ref", "env"],
      texts: ["OPENCLAW_TEST_TOKEN"],
    });

    const result = await runPromptSingleChannelSecretInput({
      prompter,
      providerHint: "discord",
      credentialLabel: "Discord bot token",
      accountConfigured: false,
      canUseEnv: false,
      hasConfigToken: false,
      preferredEnvVar: "OPENCLAW_TEST_TOKEN",
    });

    expect(result).toEqual({
      action: "set",
      value: {
        source: "env",
        provider: "default",
        id: "OPENCLAW_TEST_TOKEN",
      },
      resolvedValue: "secret-token",
    });
  });

  it("returns keep action when ref mode keeps an existing configured ref", async () => {
    const prompter = createSecretInputPrompter({
      selects: ["ref"],
      confirms: [true],
    });

    const result = await runPromptSingleChannelSecretInput({
      prompter,
      providerHint: "telegram",
      credentialLabel: "Telegram bot token",
      accountConfigured: true,
      canUseEnv: false,
      hasConfigToken: true,
      preferredEnvVar: "TELEGRAM_BOT_TOKEN",
    });

    expect(result).toEqual({ action: "keep" });
    expect(prompter.text).not.toHaveBeenCalled();
  });
});

describe("promptParsedAllowFromForAccount", () => {
  it("applies parsed allowFrom values through the provided writer", async () => {
    const prompter = createPrompter(["Alice, ALICE"]);

    const next = await promptParsedAllowFromForAccount({
      cfg: {
        channels: {
          imessage: {
            accounts: {
              alt: {
                allowFrom: ["old"],
              },
            },
          },
        },
      } as OpenClawConfig,
      accountId: "alt",
      defaultAccountId: DEFAULT_ACCOUNT_ID,
      prompter,
      noteTitle: "iMessage allowlist",
      noteLines: ["line"],
      message: "msg",
      placeholder: "placeholder",
      parseEntries: (raw) =>
        parseSetupEntriesWithParser(raw, (entry) => ({ value: entry.toLowerCase() })),
      getExistingAllowFrom: ({ cfg, accountId }) => [
        ...((
          cfg.channels?.imessage?.accounts?.[accountId] as
            | { allowFrom?: ReadonlyArray<string | number> }
            | undefined
        )?.allowFrom ?? []),
      ],
      applyAllowFrom: ({ cfg, accountId, allowFrom }) =>
        patchChannelConfigForAccount({
          cfg,
          channel: "imessage",
          accountId,
          patch: { allowFrom },
        }),
    });

    expect(
      (
        next.channels?.imessage?.accounts?.alt as
          | { allowFrom?: ReadonlyArray<string | number> }
          | undefined
      )?.allowFrom,
    ).toEqual(["alice"]);
    expect(prompter.note).toHaveBeenCalledWith("line", "iMessage allowlist");
  });

  it("can merge parsed values with existing entries", async () => {
    const next = await promptParsedAllowFromForAccount({
      cfg: {
        channels: {
          nostr: {
            allowFrom: ["old"],
          },
        },
      } as OpenClawConfig,
      defaultAccountId: DEFAULT_ACCOUNT_ID,
      prompter: createPrompter(["new"]),
      noteTitle: "Nostr allowlist",
      noteLines: ["line"],
      message: "msg",
      placeholder: "placeholder",
      parseEntries: (raw) => ({ entries: [raw.trim()] }),
      getExistingAllowFrom: ({ cfg }) => [...(cfg.channels?.nostr?.allowFrom ?? [])],
      mergeEntries: ({ existing, parsed }) => [...existing.map(String), ...parsed],
      applyAllowFrom: ({ cfg, allowFrom }) =>
        patchTopLevelChannelConfigSection({
          cfg,
          channel: "nostr",
          patch: { allowFrom },
        }),
    });

    expect(next.channels?.nostr?.allowFrom).toEqual(["old", "new"]);
  });
});

describe("createPromptParsedAllowFromForAccount", () => {
  it("supports computed default account ids and optional notes", async () => {
    const promptAllowFrom = createPromptParsedAllowFromForAccount<OpenClawConfig>({
      defaultAccountId: () => "work",
      message: "msg",
      placeholder: "placeholder",
      parseEntries: (raw) => ({ entries: [raw.trim().toLowerCase()] }),
      getExistingAllowFrom: ({ cfg, accountId }) => [
        ...((
          cfg.channels?.imessage?.accounts?.[accountId] as
            | { allowFrom?: ReadonlyArray<string | number> }
            | undefined
        )?.allowFrom ?? []),
      ],
      applyAllowFrom: ({ cfg, accountId, allowFrom }) =>
        patchChannelConfigForAccount({
          cfg,
          channel: "imessage",
          accountId,
          patch: { allowFrom },
        }),
    });

    const prompter = createPrompter(["Alice"]);
    const next = await promptAllowFrom({
      cfg: {
        channels: {
          imessage: {
            accounts: {
              work: {
                allowFrom: ["old"],
              },
            },
          },
        },
      },
      prompter,
    });

    expect(
      (
        next.channels?.imessage?.accounts?.work as
          | { allowFrom?: ReadonlyArray<string | number> }
          | undefined
      )?.allowFrom,
    ).toEqual(["alice"]);
    expect(prompter.note).not.toHaveBeenCalled();
  });
});

describe("parsed allowFrom prompt builders", () => {
  it("builds a top-level parsed allowFrom prompt", async () => {
    const promptAllowFrom = createTopLevelChannelParsedAllowFromPrompt({
      channel: "nostr",
      defaultAccountId: DEFAULT_ACCOUNT_ID,
      noteTitle: "Nostr allowlist",
      noteLines: ["line"],
      message: "msg",
      placeholder: "placeholder",
      parseEntries: (raw) => ({ entries: [raw.trim().toLowerCase()] }),
    });

    const prompter = createPrompter(["npub1"]);
    const next = await promptAllowFrom({
      cfg: {},
      prompter,
    });

    expect(next.channels?.nostr?.allowFrom).toEqual(["npub1"]);
    expect(prompter.note).toHaveBeenCalledWith("line", "Nostr allowlist");
  });
});

describe("channel lookup note helpers", () => {
  it("emits summary lines for resolved and unresolved entries", async () => {
    const prompter = { note: vi.fn(async () => undefined) };
    await noteChannelLookupSummary({
      prompter,
      label: "Slack channels",
      resolvedSections: [
        { title: "Resolved", values: ["C1", "C2"] },
        { title: "Resolved guilds", values: [] },
      ],
      unresolved: ["#typed-name"],
    });
    expect(prompter.note).toHaveBeenCalledWith(
      "Resolved: C1, C2\nUnresolved (kept as typed): #typed-name",
      "Slack channels",
    );
  });

  it("skips note output when there is nothing to report", async () => {
    const prompter = { note: vi.fn(async () => undefined) };
    await noteChannelLookupSummary({
      prompter,
      label: "Discord channels",
      resolvedSections: [{ title: "Resolved", values: [] }],
      unresolved: [],
    });
    expect(prompter.note).not.toHaveBeenCalled();
  });

  it("formats lookup failures consistently", async () => {
    const prompter = { note: vi.fn(async () => undefined) };
    await noteChannelLookupFailure({
      prompter,
      label: "Discord channels",
      error: new Error("boom"),
    });
    expect(prompter.note).toHaveBeenCalledWith(
      "Channel lookup failed; keeping entries as typed. Error: boom",
      "Discord channels",
    );
  });
});

describe("setAccountAllowFromForChannel", () => {
  it("writes allowFrom on default account channel config", () => {
    const cfg: OpenClawConfig = {
      channels: {
        imessage: {
          enabled: true,
          allowFrom: ["old"],
          accounts: {
            work: { allowFrom: ["work-old"] },
          },
        },
      },
    };

    const next = setAccountAllowFromForChannel({
      cfg,
      channel: "imessage",
      accountId: DEFAULT_ACCOUNT_ID,
      allowFrom: ["new-default"],
    });

    expect(next.channels?.imessage?.allowFrom).toEqual(["new-default"]);
    expect(next.channels?.imessage?.accounts?.work?.allowFrom).toEqual(["work-old"]);
  });

  it("writes allowFrom on nested non-default account config", () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          enabled: true,
          allowFrom: ["default-old"],
          accounts: {
            alt: { enabled: true, account: "+15555550123", allowFrom: ["alt-old"] },
          },
        },
      },
    };

    const next = setAccountAllowFromForChannel({
      cfg,
      channel: "signal",
      accountId: "alt",
      allowFrom: ["alt-new"],
    });

    expect(next.channels?.signal?.allowFrom).toEqual(["default-old"]);
    expect(next.channels?.signal?.accounts?.alt?.allowFrom).toEqual(["alt-new"]);
    expect(next.channels?.signal?.accounts?.alt?.account).toBe("+15555550123");
  });
});

describe("patchChannelConfigForAccount", () => {
  it("patches root channel config for default account", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          enabled: false,
          botToken: "old",
        },
      },
    };

    const next = patchChannelConfigForAccount({
      cfg,
      channel: "telegram",
      accountId: DEFAULT_ACCOUNT_ID,
      patch: { botToken: "new", dmPolicy: "allowlist" },
    });

    expect(next.channels?.telegram?.enabled).toBe(true);
    expect(next.channels?.telegram?.botToken).toBe("new");
    expect(next.channels?.telegram?.dmPolicy).toBe("allowlist");
  });

  it("patches nested account config and preserves existing enabled flag", () => {
    const cfg: OpenClawConfig = {
      channels: {
        slack: {
          enabled: true,
          accounts: {
            work: {
              enabled: false,
              botToken: "old-bot",
            },
          },
        },
      },
    };

    const next = patchChannelConfigForAccount({
      cfg,
      channel: "slack",
      accountId: "work",
      patch: { botToken: "new-bot", appToken: "new-app" },
    });

    expect(next.channels?.slack?.enabled).toBe(true);
    expect(next.channels?.slack?.accounts?.work?.enabled).toBe(false);
    expect(next.channels?.slack?.accounts?.work?.botToken).toBe("new-bot");
    expect(next.channels?.slack?.accounts?.work?.appToken).toBe("new-app");
  });

  it("moves single-account config into default account when patching non-default", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          enabled: true,
          botToken: "legacy-token",
          allowFrom: ["100"],
          groupPolicy: "allowlist",
          streaming: { mode: "partial" },
          webhookSecret: "legacy-webhook-secret",
        },
      },
    };

    const next = patchChannelConfigForAccount({
      cfg,
      channel: "telegram",
      accountId: "work",
      patch: { botToken: "work-token" },
      setupSurface: telegramSetupSurface,
    });

    expect(next.channels?.telegram?.accounts?.default).toEqual({
      botToken: "legacy-token",
      allowFrom: ["100"],
      groupPolicy: "allowlist",
      streaming: { mode: "partial" },
      webhookSecret: "legacy-webhook-secret",
    });
    expect(next.channels?.telegram?.botToken).toBeUndefined();
    expect(next.channels?.telegram?.allowFrom).toBeUndefined();
    expect(next.channels?.telegram?.groupPolicy).toBeUndefined();
    expect(next.channels?.telegram?.streaming).toBeUndefined();
    expect(next.channels?.telegram?.webhookSecret).toBeUndefined();
    expect(next.channels?.telegram?.accounts?.work?.botToken).toBe("work-token");
  });

  it("supports imessage/signal account-scoped channel patches", () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          enabled: false,
          accounts: {},
        },
        imessage: {
          enabled: false,
        },
      },
    };

    const signalNext = patchChannelConfigForAccount({
      cfg,
      channel: "signal",
      accountId: "work",
      patch: { account: "+15555550123", cliPath: "signal-cli" },
    });
    expect(signalNext.channels?.signal?.enabled).toBe(true);
    expect(signalNext.channels?.signal?.accounts?.work?.enabled).toBe(true);
    expect(signalNext.channels?.signal?.accounts?.work?.account).toBe("+15555550123");

    const imessageNext = patchChannelConfigForAccount({
      cfg: signalNext,
      channel: "imessage",
      accountId: DEFAULT_ACCOUNT_ID,
      patch: { cliPath: "imsg" },
    });
    expect(imessageNext.channels?.imessage?.enabled).toBe(true);
    expect(imessageNext.channels?.imessage?.cliPath).toBe("imsg");
  });
});

describe("setSetupChannelEnabled", () => {
  it("updates enabled and keeps existing channel fields", () => {
    const cfg: OpenClawConfig = {
      channels: {
        discord: {
          enabled: true,
          token: "abc",
        },
      },
    };

    const next = setSetupChannelEnabled(cfg, "discord", false);
    expect(next.channels?.discord?.enabled).toBe(false);
    expect(next.channels?.discord?.token).toBe("abc");
  });

  it("creates missing channel config with enabled state", () => {
    const next = setSetupChannelEnabled({}, "signal", true);
    expect(next.channels?.signal?.enabled).toBe(true);
  });
});

describe("setTopLevelChannelDmPolicyWithAllowFrom", () => {
  it("adds wildcard allowFrom for open policy", () => {
    const cfg: OpenClawConfig = {
      channels: {
        zalo: {
          dmPolicy: "pairing",
          allowFrom: ["12345"],
        },
      },
    };

    const next = setTopLevelChannelDmPolicyWithAllowFrom({
      cfg,
      channel: "zalo",
      dmPolicy: "open",
    });
    expect(next.channels?.zalo?.dmPolicy).toBe("open");
    expect(next.channels?.zalo?.allowFrom).toEqual(["12345", "*"]);
  });

  it("supports custom allowFrom lookup callback", () => {
    const cfg: OpenClawConfig = {
      channels: {
        "nextcloud-talk": {
          dmPolicy: "pairing",
          allowFrom: ["alice"],
        },
      },
    };

    const next = setTopLevelChannelDmPolicyWithAllowFrom({
      cfg,
      channel: "nextcloud-talk",
      dmPolicy: "open",
      getAllowFrom: (inputCfg) =>
        normalizeAllowFromEntries([...(inputCfg.channels?.["nextcloud-talk"]?.allowFrom ?? [])]),
    });
    expect(next.channels?.["nextcloud-talk"]?.allowFrom).toEqual(["alice", "*"]);
  });
});

describe("patchTopLevelChannelConfigSection", () => {
  it("clears requested fields before applying a patch", () => {
    const next = patchTopLevelChannelConfigSection({
      cfg: {
        channels: {
          nostr: {
            privateKey: "nsec1",
            relays: ["wss://old.example"],
          },
        },
      },
      channel: "nostr",
      clearFields: ["privateKey"],
      patch: { relays: ["wss://new.example"] },
      enabled: true,
    });

    expect(next.channels?.nostr?.privateKey).toBeUndefined();
    expect(next.channels?.nostr?.relays).toEqual(["wss://new.example"]);
    expect(next.channels?.nostr?.enabled).toBe(true);
  });
});

describe("createTopLevelChannelDmPolicy", () => {
  it("creates a reusable dm policy definition", () => {
    const dmPolicy = createTopLevelChannelDmPolicy({
      label: "LINE",
      channel: "line",
      policyKey: "channels.line.dmPolicy",
      allowFromKey: "channels.line.allowFrom",
      getCurrent: (cfg) =>
        (cfg.channels?.line?.dmPolicy as
          | "open"
          | "pairing"
          | "allowlist"
          | "disabled"
          | undefined) ?? "pairing",
    });

    const next = dmPolicy.setPolicy(
      {
        channels: {
          line: {
            dmPolicy: "pairing",
            allowFrom: ["U123"],
          },
        },
      },
      "open",
    );

    expect(dmPolicy.getCurrent({})).toBe("pairing");
    expect(next.channels?.line?.dmPolicy).toBe("open");
    expect(next.channels?.line?.allowFrom).toEqual(["U123", "*"]);
  });
});

describe("createTopLevelChannelDmPolicySetter", () => {
  it("reuses the shared top-level dmPolicy writer", () => {
    const setPolicy = createTopLevelChannelDmPolicySetter({
      channel: "zalo",
    });
    const next = setPolicy(
      {
        channels: {
          zalo: {
            allowFrom: ["12345"],
          },
        },
      },
      "open",
    );

    expect(next.channels?.zalo?.dmPolicy).toBe("open");
    expect(next.channels?.zalo?.allowFrom).toEqual(["12345", "*"]);
  });
});

describe("createTopLevelChannelAllowFromSetter", () => {
  it("reuses the shared top-level allowFrom writer", () => {
    const setAllowFrom = createTopLevelChannelAllowFromSetter({
      channel: "msteams",
      enabled: true,
    });
    const next = setAllowFrom({}, ["user-1"]);

    expect(next.channels?.msteams?.allowFrom).toEqual(["user-1"]);
    expect(next.channels?.msteams?.enabled).toBe(true);
  });
});

describe("createTopLevelChannelGroupPolicySetter", () => {
  it("reuses the shared top-level groupPolicy writer", () => {
    const setGroupPolicy = createTopLevelChannelGroupPolicySetter({
      channel: "feishu",
      enabled: true,
    });
    const next = setGroupPolicy({}, "allowlist");

    expect(next.channels?.feishu?.groupPolicy).toBe("allowlist");
    expect(next.channels?.feishu?.enabled).toBe(true);
  });
});

describe("createAccountScopedAllowFromSection", () => {
  it("builds an account-scoped allowFrom section with shared apply wiring", async () => {
    const section = createAccountScopedAllowFromSection({
      channel: "discord",
      credentialInputKey: "token",
      message: "Discord allowFrom",
      placeholder: "@alice",
      invalidWithoutCredentialNote: "need ids",
      parseId: (value) => value.trim() || null,
      resolveEntries: async ({ entries }) =>
        entries.map((input) => ({ input, resolved: true, id: input.toUpperCase() })),
    });

    expect(section.credentialInputKey).toBe("token");
    await expect(
      resolveSetupWizardAllowFromEntries({
        resolveEntries: section.resolveEntries,
        accountId: DEFAULT_ACCOUNT_ID,
        entries: ["alice"],
      }),
    ).resolves.toEqual([{ input: "alice", resolved: true, id: "ALICE" }]);

    const next = await section.apply({
      cfg: {},
      accountId: DEFAULT_ACCOUNT_ID,
      allowFrom: ["123"],
    });

    expect(next.channels?.discord?.dmPolicy).toBe("allowlist");
    expect(next.channels?.discord?.allowFrom).toEqual(["123"]);
  });
});

describe("createAllowFromSection", () => {
  it("builds a parsed allowFrom section with default local resolution", async () => {
    const section = createAllowFromSection({
      helpTitle: "LINE allowlist",
      helpLines: ["line"],
      credentialInputKey: "token",
      message: "LINE allowFrom",
      placeholder: "U123",
      invalidWithoutCredentialNote: "need ids",
      parseId: (value) => value.trim().toUpperCase() || null,
      apply: ({ cfg, accountId, allowFrom }) =>
        patchChannelConfigForAccount({
          cfg,
          channel: "line",
          accountId,
          patch: { dmPolicy: "allowlist", allowFrom },
        }),
    });

    expect(section.helpTitle).toBe("LINE allowlist");
    await expect(
      resolveSetupWizardAllowFromEntries({
        resolveEntries: section.resolveEntries,
        accountId: DEFAULT_ACCOUNT_ID,
        entries: ["u1"],
      }),
    ).resolves.toEqual([{ input: "u1", resolved: true, id: "U1" }]);

    const next = await section.apply({
      cfg: {},
      accountId: DEFAULT_ACCOUNT_ID,
      allowFrom: ["U1"],
    });
    expect(next.channels?.line?.allowFrom).toEqual(["U1"]);
  });
});

describe("createAccountScopedGroupAccessSection", () => {
  it("builds group access with shared setPolicy and fallback lookup notes", async () => {
    const prompter = createPrompter([]);
    const section = createAccountScopedGroupAccessSection({
      channel: "slack",
      label: "Slack channels",
      placeholder: "#general",
      currentPolicy: () => "allowlist",
      currentEntries: () => [],
      updatePrompt: () => false,
      resolveAllowlist: async () => {
        throw new Error("boom");
      },
      fallbackResolved: (entries) => entries,
      applyAllowlist: ({ cfg, resolved, accountId }) =>
        patchChannelConfigForAccount({
          cfg,
          channel: "slack",
          accountId,
          patch: {
            channels: Object.fromEntries(resolved.map((entry) => [entry, { allow: true }])),
          },
        }),
    });

    const policyNext = section.setPolicy({
      cfg: {},
      accountId: DEFAULT_ACCOUNT_ID,
      policy: "open",
    });
    expect(policyNext.channels?.slack?.groupPolicy).toBe("open");

    await expect(
      resolveSetupWizardGroupAllowlist({
        resolveAllowlist: section.resolveAllowlist,
        accountId: DEFAULT_ACCOUNT_ID,
        entries: ["general"],
        prompter,
      }),
    ).resolves.toEqual(["general"]);
    expect(prompter.note).toHaveBeenCalledTimes(2);

    const allowlistNext = section.applyAllowlist?.({
      cfg: {},
      accountId: DEFAULT_ACCOUNT_ID,
      resolved: ["C123"],
    });
    expect(allowlistNext?.channels?.slack?.channels).toEqual({
      C123: { allow: true },
    });
  });
});

describe("splitSetupEntries", () => {
  it("splits comma/newline/semicolon input and trims blanks", () => {
    expect(splitSetupEntries(" alice, bob \ncarol;  ;\n")).toEqual(["alice", "bob", "carol"]);
  });
});

describe("parseSetupEntriesWithParser", () => {
  it("maps entries and de-duplicates parsed values", () => {
    expect(
      parseSetupEntriesWithParser(" alice, ALICE ; * ", (entry) => {
        if (entry === "*") {
          return { value: "*" };
        }
        return { value: entry.toLowerCase() };
      }),
    ).toEqual({
      entries: ["alice", "*"],
    });
  });

  it("returns parser errors and clears parsed entries", () => {
    expect(
      parseSetupEntriesWithParser("ok, bad", (entry) =>
        entry === "bad" ? { error: "invalid entry: bad" } : { value: entry },
      ),
    ).toEqual({
      entries: [],
      error: "invalid entry: bad",
    });
  });
});

describe("parseSetupEntriesAllowingWildcard", () => {
  it("preserves wildcard and delegates non-wildcard entries", () => {
    expect(
      parseSetupEntriesAllowingWildcard(" *, Foo ", (entry) => ({
        value: entry.toLowerCase(),
      })),
    ).toEqual({
      entries: ["*", "foo"],
    });
  });

  it("returns parser errors for non-wildcard entries", () => {
    expect(
      parseSetupEntriesAllowingWildcard("ok,bad", (entry) =>
        entry === "bad" ? { error: "bad entry" } : { value: entry },
      ),
    ).toEqual({
      entries: [],
      error: "bad entry",
    });
  });
});

describe("resolveEntriesWithOptionalToken", () => {
  it("returns unresolved entries when token is missing", async () => {
    await expect(
      resolveEntriesWithOptionalToken({
        entries: ["alice", "bob"],
        buildWithoutToken: (input) => ({ input, resolved: false, id: null }),
        resolveEntries: async () => {
          throw new Error("should not run");
        },
      }),
    ).resolves.toEqual([
      { input: "alice", resolved: false, id: null },
      { input: "bob", resolved: false, id: null },
    ]);
  });

  it("delegates to the resolver when token exists", async () => {
    await expect(
      resolveEntriesWithOptionalToken<{
        input: string;
        resolved: boolean;
        id: string | null;
      }>({
        token: "xoxb-test",
        entries: ["alice"],
        buildWithoutToken: (input) => ({ input, resolved: false, id: null }),
        resolveEntries: async ({ token, entries }) =>
          entries.map((input) => ({ input, resolved: true, id: `${token}:${input}` })),
      }),
    ).resolves.toEqual([{ input: "alice", resolved: true, id: "xoxb-test:alice" }]);
  });
});

describe("parseMentionOrPrefixedId", () => {
  it("parses mention ids", () => {
    expect(
      parseMentionOrPrefixedId({
        value: "<@!123>",
        mentionPattern: /^<@!?(\d+)>$/,
        prefixPattern: /^(user:|discord:)/i,
        idPattern: /^\d+$/,
      }),
    ).toBe("123");
  });

  it("parses prefixed ids and normalizes result", () => {
    expect(
      parseMentionOrPrefixedId({
        value: "slack:u123abc",
        mentionPattern: /^<@([A-Z0-9]+)>$/i,
        prefixPattern: /^(slack:|user:)/i,
        idPattern: /^[A-Z][A-Z0-9]+$/i,
        normalizeId: (id) => id.toUpperCase(),
      }),
    ).toBe("U123ABC");
  });

  it("returns null for blank or invalid input", () => {
    expect(
      parseMentionOrPrefixedId({
        value: "   ",
        mentionPattern: /^<@!?(\d+)>$/,
        prefixPattern: /^(user:|discord:)/i,
        idPattern: /^\d+$/,
      }),
    ).toBeNull();
    expect(
      parseMentionOrPrefixedId({
        value: "@alice",
        mentionPattern: /^<@!?(\d+)>$/,
        prefixPattern: /^(user:|discord:)/i,
        idPattern: /^\d+$/,
      }),
    ).toBeNull();
  });
});

describe("normalizeAllowFromEntries", () => {
  it("normalizes values, preserves wildcard, and removes duplicates", () => {
    expect(
      normalizeAllowFromEntries([" +15555550123 ", "*", "+15555550123", "bad"], (value) =>
        value.startsWith("+1") ? value : null,
      ),
    ).toEqual(["+15555550123", "*"]);
  });

  it("trims and de-duplicates without a normalizer", () => {
    expect(normalizeAllowFromEntries([" alice ", "bob", "alice"])).toEqual(["alice", "bob"]);
  });
});

describe("createStandardChannelSetupStatus", () => {
  it("returns the shared status fields without status lines by default", async () => {
    const status = createStandardChannelSetupStatus({
      channelLabel: "Demo",
      configuredLabel: "configured",
      unconfiguredLabel: "needs token",
      configuredHint: "ready",
      unconfiguredHint: "missing token",
      configuredScore: 2,
      unconfiguredScore: 0,
      resolveConfigured: ({ cfg }) => Boolean(cfg.channels?.demo),
    });

    expect(status.configuredHint).toBe("ready");
    expect(status.unconfiguredHint).toBe("missing token");
    expect(status.configuredScore).toBe(2);
    expect(status.unconfiguredScore).toBe(0);
    expect(await status.resolveConfigured({ cfg: { channels: { demo: {} } } })).toBe(true);
    expect(status.resolveStatusLines).toBeUndefined();
  });

  it("builds the default status line plus extra lines when requested", async () => {
    const status = createStandardChannelSetupStatus({
      channelLabel: "Demo",
      configuredLabel: "configured",
      unconfiguredLabel: "needs token",
      includeStatusLine: true,
      resolveConfigured: ({ cfg }) => Boolean(cfg.channels?.demo),
      resolveExtraStatusLines: ({ configured }) => [`Configured: ${configured ? "yes" : "no"}`],
    });

    expect(
      await status.resolveStatusLines?.({
        cfg: { channels: { demo: {} } },
        configured: true,
      }),
    ).toEqual(["Demo: configured", "Configured: yes"]);
  });
});

describe("resolveSetupAccountId", () => {
  it("normalizes provided account ids", () => {
    expect(
      resolveSetupAccountId({
        accountId: " Work Account ",
        defaultAccountId: DEFAULT_ACCOUNT_ID,
      }),
    ).toBe("work-account");
  });

  it("falls back to default account id when input is blank", () => {
    expect(
      resolveSetupAccountId({
        accountId: "   ",
        defaultAccountId: "custom-default",
      }),
    ).toBe("custom-default");
  });
});

describe("resolveAccountIdForConfigure", () => {
  it("uses normalized override without prompting", async () => {
    const accountId = await resolveAccountIdForConfigure({
      cfg: {},
      prompter: createWizardPrompter(),
      label: "Signal",
      accountOverride: " Team Primary ",
      shouldPromptAccountIds: true,
      listAccountIds: () => ["default", "team-primary"],
      defaultAccountId: DEFAULT_ACCOUNT_ID,
    });
    expect(accountId).toBe("team-primary");
  });

  it("uses default account when override is missing and prompting disabled", async () => {
    const accountId = await resolveAccountIdForConfigure({
      cfg: {},
      prompter: createWizardPrompter(),
      label: "Signal",
      shouldPromptAccountIds: false,
      listAccountIds: () => ["default"],
      defaultAccountId: "fallback",
    });
    expect(accountId).toBe("fallback");
  });

  it("prompts for account id when prompting is enabled and no override is provided", async () => {
    const basePrompter = createWizardPrompter(undefined, { defaultSelect: "prompted-id" });
    const prompter = {
      ...basePrompter,
      select: vi.mocked(basePrompter.select),
    };

    const accountId = await resolveAccountIdForConfigure({
      cfg: {},
      prompter,
      label: "Signal",
      shouldPromptAccountIds: true,
      listAccountIds: () => ["default", "prompted-id"],
      defaultAccountId: "fallback",
    });

    expect(accountId).toBe("prompted-id");
    const selectCalls = prompter.select.mock.calls as unknown as Array<
      [{ message?: string; initialValue?: string }]
    >;
    const selectOptions = selectCalls[0]?.[0] as
      | { message?: string; initialValue?: string }
      | undefined;
    expect(selectOptions?.message).toBe("Signal account");
    expect(selectOptions?.initialValue).toBe("fallback");
    expect(prompter.text).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
