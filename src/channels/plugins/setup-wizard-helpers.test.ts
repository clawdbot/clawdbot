import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveSetupWizardAllowFromEntries,
  resolveSetupWizardGroupAllowlist,
} from "../../../test/helpers/plugins/setup-wizard.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  applySingleTokenPromptResult,
  buildSingleChannelSecretPromptState,
  createAccountScopedAllowFromSection,
  createAccountScopedGroupAccessSection,
  createAllowFromSection,
  createLegacyCompatChannelDmPolicy,
  createNestedChannelParsedAllowFromPrompt,
  createPromptParsedAllowFromForAccount,
  createStandardChannelSetupStatus,
  createNestedChannelAllowFromSetter,
  createNestedChannelDmPolicy,
  createNestedChannelDmPolicySetter,
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
  patchNestedChannelConfigSection,
  patchLegacyDmChannelConfig,
  patchTopLevelChannelConfigSection,
  promptLegacyChannelAllowFrom,
  promptLegacyChannelAllowFromForAccount,
  promptParsedAllowFromForAccount,
  parseSetupEntriesWithParser,
  promptParsedAllowFromForScopedChannel,
  promptSingleChannelSecretInput,
  promptSingleChannelToken,
  promptResolvedAllowFrom,
  resolveAccountIdForConfigure,
  resolveEntriesWithOptionalToken,
  resolveGroupAllowlistWithLookupNotes,
  resolveParsedAllowFromEntries,
  resolveSetupAccountId,
  setAccountDmAllowFromForChannel,
  setAccountAllowFromForChannel,
  setAccountGroupPolicyForChannel,
  setChannelDmPolicyWithAllowFrom,
  setTopLevelChannelAllowFrom,
  setTopLevelChannelDmPolicyWithAllowFrom,
  setTopLevelChannelGroupPolicy,
  setNestedChannelAllowFrom,
  setNestedChannelDmPolicyWithAllowFrom,
  setLegacyChannelAllowFrom,
  setLegacyChannelDmPolicyWithAllowFrom,
  setSetupChannelEnabled,
  splitSetupEntries,
} from "./setup-wizard-helpers.js";

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
const telegramSingleAccountKeysToMove = ["streaming"] as const;

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
  const namedAccounts = Object.keys(accounts).filter(Boolean);
  return namedAccounts.length === 1 ? namedAccounts[0] : DEFAULT_ACCOUNT_ID;
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
  return {
    text: vi.fn(async () => inputs.shift() ?? ""),
    note: vi.fn(async () => undefined),
  };
}

function createTokenPrompter(params: { confirms: boolean[]; texts: string[] }) {
  const confirms = [...params.confirms];
  const texts = [...params.texts];
  return {
    confirm: vi.fn(async () => confirms.shift() ?? true),
    text: vi.fn(async () => texts.shift() ?? ""),
  };
}

function parseCsvInputs(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
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
    prompter: params.prompter as any,
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

async function runPromptSingleToken(params: {
  prompter: ReturnType<typeof createTokenPrompter>;
  accountConfigured: boolean;
  canUseEnv: boolean;
  hasConfigToken: boolean;
}) {
  return await promptSingleChannelToken({
    prompter: params.prompter,
    accountConfigured: params.accountConfigured,
    canUseEnv: params.canUseEnv,
    hasConfigToken: params.hasConfigToken,
    envPrompt: "use env",
    keepPrompt: "keep",
    inputPrompt: "token",
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
  return {
    select: vi.fn(async () => selects.shift() ?? "plaintext"),
    confirm: vi.fn(async () => confirms.shift() ?? false),
    text: vi.fn(async () => texts.shift() ?? ""),
    note: vi.fn(async () => undefined),
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
    prompter: params.prompter as any,
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

async function runPromptLegacyAllowFrom(params: {
  cfg?: OpenClawConfig;
  channel: "discord" | "slack";
  prompter: ReturnType<typeof createPrompter>;
  existing: string[];
  token: string;
  noteTitle: string;
  noteLines: string[];
  parseId: (value: string) => string | null;
  resolveEntries: AllowFromResolver;
}) {
  return await promptLegacyChannelAllowFrom({
    cfg: params.cfg ?? {},
    channel: params.channel,
    prompter: params.prompter as any,
    existing: params.existing,
    token: params.token,
    noteTitle: params.noteTitle,
    noteLines: params.noteLines,
    message: "msg",
    placeholder: "placeholder",
    parseId: params.parseId,
    invalidWithoutTokenNote: "ids only",
    resolveEntries: params.resolveEntries,
  });
}

describe("promptResolvedAllowFrom", () => {
  it("re-prompts without token until all ids are parseable", async () => {
    const prompter = createPrompter(["@alice", "123"]);
    const resolveEntries = vi.fn();

    const result = await promptResolvedAllowFrom({
      prompter: prompter as any,
      existing: ["111"],
      token: "",
      message: "msg",
      placeholder: "placeholder",
      label: "allowlist",
      parseInputs: parseCsvInputs,
      parseId: (value) => (/^\d+$/.test(value.trim()) ? value.trim() : null),
      invalidWithoutTokenNote: "ids only",
      resolveEntries: resolveEntries as any,
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

describe("promptLegacyChannelAllowFrom", () => {
  it("applies parsed ids without token resolution", async () => {
    const prompter = createPrompter([" 123 "]);
    const resolveEntries = vi.fn();

    const next = await runPromptLegacyAllowFrom({
      cfg: {} as OpenClawConfig,
      channel: "discord",
      existing: ["999"],
      prompter,
      token: "",
      noteTitle: "Discord allowlist",
      noteLines: ["line1", "line2"],
      parseId: (value) => (/^\d+$/.test(value.trim()) ? value.trim() : null),
      resolveEntries: asAllowFromResolver(resolveEntries),
    });

    expect(next.channels?.discord?.allowFrom).toEqual(["999", "123"]);
    expect(prompter.note).toHaveBeenCalledWith("line1\nline2", "Discord allowlist");
    expect(resolveEntries).not.toHaveBeenCalled();
  });

  it("uses resolver when token is present", async () => {
    const prompter = createPrompter(["alice"]);
    const resolveEntries = vi.fn(async () => [{ input: "alice", resolved: true, id: "U1" }]);

    const next = await runPromptLegacyAllowFrom({
      cfg: {} as OpenClawConfig,
      channel: "slack",
      prompter,
      existing: [],
      token: "xoxb-token",
      noteTitle: "Slack allowlist",
      noteLines: ["line"],
      parseId: () => null,
      resolveEntries: asAllowFromResolver(resolveEntries),
    });

    expect(next.channels?.slack?.allowFrom).toEqual(["U1"]);
    expect(resolveEntries).toHaveBeenCalledWith({ token: "xoxb-token", entries: ["alice"] });
  });
});

describe("promptLegacyChannelAllowFromForAccount", () => {
  it("resolves the account before delegating to the shared prompt flow", async () => {
    const prompter = createPrompter(["alice"]);

    const next = await promptLegacyChannelAllowFromForAccount({
      cfg: {
        channels: {
          slack: {
            dm: {
              allowFrom: ["U0"],
            },
          },
        },
      } as OpenClawConfig,
      channel: "slack",
      prompter: prompter as any,
      defaultAccountId: DEFAULT_ACCOUNT_ID,
      resolveAccount: () => ({
        botToken: "xoxb-token",
        dmAllowFrom: ["U0"],
      }),
      resolveExisting: (account) => account.dmAllowFrom,
      resolveToken: (account) => account.botToken,
      noteTitle: "Slack allowlist",
      noteLines: ["line"],
      message: "Slack allowFrom",
      placeholder: "@alice",
      parseId: () => null,
      invalidWithoutTokenNote: "need ids",
      resolveEntries: async ({ entries }) =>
        entries.map((input) => ({ input, resolved: true, id: input.toUpperCase() })),
    });

    expect(next.channels?.slack?.allowFrom).toEqual(["U0", "ALICE"]);
    expect(prompter.note).toHaveBeenCalledWith("line", "Slack allowlist");
  });
});

describe("promptSingleChannelToken", () => {
  it.each([
    {
      name: "uses env tokens when confirmed",
      confirms: [true],
      texts: [],
      state: {
        accountConfigured: false,
        canUseEnv: true,
        hasConfigToken: false,
      },
      expected: { useEnv: true, token: null },
      expectTextCalls: 0,
    },
    {
      name: "prompts for token when env exists but user declines env",
      confirms: [false],
      texts: ["abc"],
      state: {
        accountConfigured: false,
        canUseEnv: true,
        hasConfigToken: false,
      },
      expected: { useEnv: false, token: "abc" },
      expectTextCalls: 1,
    },
    {
      name: "keeps existing configured token when confirmed",
      confirms: [true],
      texts: [],
      state: {
        accountConfigured: true,
        canUseEnv: false,
        hasConfigToken: true,
      },
      expected: { useEnv: false, token: null },
      expectTextCalls: 0,
    },
    {
      name: "prompts for token when no env/config token is used",
      confirms: [false],
      texts: ["xyz"],
      state: {
        accountConfigured: true,
        canUseEnv: false,
        hasConfigToken: false,
      },
      expected: { useEnv: false, token: "xyz" },
      expectTextCalls: 1,
    },
  ])("$name", async ({ confirms, texts, state, expected, expectTextCalls }) => {
    const prompter = createTokenPrompter({ confirms, texts });
    const result = await runPromptSingleToken({
      prompter,
      ...state,
    });
    expect(result).toEqual(expected);
    expect(prompter.text).toHaveBeenCalledTimes(expectTextCalls);
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

describe("applySingleTokenPromptResult", () => {
  it("writes env selection as an empty patch on target account", () => {
    const next = applySingleTokenPromptResult({
      cfg: {},
      channel: "discord",
      accountId: "work",
      tokenPatchKey: "token",
      tokenResult: { useEnv: true, token: null },
    });

    expect(next.channels?.discord?.enabled).toBe(true);
    expect(next.channels?.discord?.accounts?.work?.enabled).toBe(true);
    expect(next.channels?.discord?.accounts?.work?.token).toBeUndefined();
  });

  it("writes provided token under requested key", () => {
    const next = applySingleTokenPromptResult({
      cfg: {},
      channel: "telegram",
      accountId: DEFAULT_ACCOUNT_ID,
      tokenPatchKey: "botToken",
      tokenResult: { useEnv: false, token: "abc" },
    });

    expect(next.channels?.telegram?.enabled).toBe(true);
    expect(next.channels?.telegram?.botToken).toBe("abc");
  });
});

describe("promptParsedAllowFromForScopedChannel", () => {
  it("writes parsed allowFrom values to default account channel config", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        imessage: {
          allowFrom: ["old"],
        },
      },
    };
    const prompter = createPrompter([" Alice, ALICE "]);

    const next = await promptParsedAllowFromForScopedChannel({
      cfg,
      channel: "imessage",
      defaultAccountId: DEFAULT_ACCOUNT_ID,
      prompter,
      noteTitle: "iMessage allowlist",
      noteLines: ["line1", "line2"],
      message: "msg",
      placeholder: "placeholder",
      parseEntries: (raw) =>
        parseSetupEntriesWithParser(raw, (entry) => ({ value: entry.toLowerCase() })),
      getExistingAllowFrom: ({ cfg }) => cfg.channels?.imessage?.allowFrom ?? [],
    });

    expect(next.channels?.imessage?.allowFrom).toEqual(["alice"]);
    expect(prompter.note).toHaveBeenCalledWith("line1\nline2", "iMessage allowlist");
  });

  it("writes parsed values to non-default account allowFrom", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          accounts: {
            alt: {
              allowFrom: ["+15555550123"],
            },
          },
        },
      },
    };
    const prompter = createPrompter(["+15555550124"]);

    const next = await promptParsedAllowFromForScopedChannel({
      cfg,
      channel: "signal",
      accountId: "alt",
      defaultAccountId: DEFAULT_ACCOUNT_ID,
      prompter,
      noteTitle: "Signal allowlist",
      noteLines: ["line"],
      message: "msg",
      placeholder: "placeholder",
      parseEntries: (raw) => ({ entries: [raw.trim()] }),
      getExistingAllowFrom: ({ cfg, accountId }) =>
        cfg.channels?.signal?.accounts?.[accountId]?.allowFrom ?? [],
    });

    expect(next.channels?.signal?.accounts?.alt?.allowFrom).toEqual(["+15555550124"]);
    expect(next.channels?.signal?.allowFrom).toBeUndefined();
  });

  it("uses parser validation from the prompt validate callback", async () => {
    const prompter = {
      note: vi.fn(async () => undefined),
      text: vi.fn(async (params: { validate?: (value: string) => string | undefined }) => {
        expect(params.validate?.("")).toBe("Required");
        expect(params.validate?.("bad")).toBe("bad entry");
        expect(params.validate?.("ok")).toBeUndefined();
        return "ok";
      }),
    };

    const next = await promptParsedAllowFromForScopedChannel({
      cfg: {},
      channel: "imessage",
      defaultAccountId: DEFAULT_ACCOUNT_ID,
      prompter,
      noteTitle: "title",
      noteLines: ["line"],
      message: "msg",
      placeholder: "placeholder",
      parseEntries: (raw) =>
        raw.trim() === "bad"
          ? { entries: [], error: "bad entry" }
          : { entries: [raw.trim().toLowerCase()] },
      getExistingAllowFrom: () => [],
    });

    expect(next.channels?.imessage?.allowFrom).toEqual(["ok"]);
  });
});

describe("promptParsedAllowFromForAccount", () => {
  it("applies parsed allowFrom values through the provided writer", async () => {
    const prompter = createPrompter(["Alice, ALICE"]);

    const next = await promptParsedAllowFromForAccount({
      cfg: {
        channels: {
          bluebubbles: {
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
      noteTitle: "BlueBubbles allowlist",
      noteLines: ["line"],
      message: "msg",
      placeholder: "placeholder",
      parseEntries: (raw) =>
        parseSetupEntriesWithParser(raw, (entry) => ({ value: entry.toLowerCase() })),
      getExistingAllowFrom: ({ cfg, accountId }) => [
        ...((
          cfg.channels?.bluebubbles?.accounts?.[accountId] as
            | { allowFrom?: ReadonlyArray<string | number> }
            | undefined
        )?.allowFrom ?? []),
      ],
      applyAllowFrom: ({ cfg, accountId, allowFrom }) =>
        patchChannelConfigForAccount({
          cfg,
          channel: "bluebubbles",
          accountId,
          patch: { allowFrom },
        }),
    });

    expect(
      (
        next.channels?.bluebubbles?.accounts?.alt as
          | { allowFrom?: ReadonlyArray<string | number> }
          | undefined
      )?.allowFrom,
    ).toEqual(["alice"]);
    expect(prompter.note).toHaveBeenCalledWith("line", "BlueBubbles allowlist");
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
          cfg.channels?.bluebubbles?.accounts?.[accountId] as
            | { allowFrom?: ReadonlyArray<string | number> }
            | undefined
        )?.allowFrom ?? []),
      ],
      applyAllowFrom: ({ cfg, accountId, allowFrom }) =>
        patchChannelConfigForAccount({
          cfg,
          channel: "bluebubbles",
          accountId,
          patch: { allowFrom },
        }),
    });

    const prompter = createPrompter(["Alice"]);
    const next = await promptAllowFrom({
      cfg: {
        channels: {
          bluebubbles: {
            accounts: {
              work: {
                allowFrom: ["old"],
              },
            },
          },
        },
      },
      prompter: prompter as any,
    });

    expect(
      (
        next.channels?.bluebubbles?.accounts?.work as
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
      prompter: prompter as any,
    });

    expect(next.channels?.nostr?.allowFrom).toEqual(["npub1"]);
    expect(prompter.note).toHaveBeenCalledWith("line", "Nostr allowlist");
  });

  it("builds a nested parsed allowFrom prompt", async () => {
    const promptAllowFrom = createNestedChannelParsedAllowFromPrompt({
      channel: "googlechat",
      section: "dm",
      defaultAccountId: DEFAULT_ACCOUNT_ID,
      enabled: true,
      message: "msg",
      placeholder: "placeholder",
      parseEntries: (raw) => ({ entries: [raw.trim()] }),
    });

    const next = await promptAllowFrom({
      cfg: {},
      prompter: createPrompter(["users/123"]) as any,
    });

    expect(next.channels?.googlechat?.enabled).toBe(true);
    expect(next.channels?.googlechat?.dm?.allowFrom).toEqual(["users/123"]);
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
        },
      },
    };

    const next = patchChannelConfigForAccount({
      cfg,
      channel: "telegram",
      accountId: "work",
      patch: { botToken: "work-token" },
    });

    expect(next.channels?.telegram?.accounts?.default).toEqual({
      botToken: "legacy-token",
      allowFrom: ["100"],
      groupPolicy: "allowlist",
      streaming: { mode: "partial" },
    });
    expect(next.channels?.telegram?.botToken).toBeUndefined();
    expect(next.channels?.telegram?.allowFrom).toBeUndefined();
    expect(next.channels?.telegram?.groupPolicy).toBeUndefined();
    expect(next.channels?.telegram?.streaming).toBeUndefined();
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

describe("patchLegacyDmChannelConfig", () => {
  it("patches discord root config and defaults dm.enabled to true", () => {
    const cfg: OpenClawConfig = {
      channels: {
        discord: {
          dmPolicy: "pairing",
        },
      },
    };

    const next = patchLegacyDmChannelConfig({
      cfg,
      channel: "discord",
      patch: { allowFrom: ["123"] },
    });
    expect(next.channels?.discord?.allowFrom).toEqual(["123"]);
    expect(next.channels?.discord?.dm?.enabled).toBe(true);
  });

  it("preserves explicit dm.enabled=false for slack", () => {
    const cfg: OpenClawConfig = {
      channels: {
        slack: {
          dm: {
            enabled: false,
          },
        },
      },
    };

    const next = patchLegacyDmChannelConfig({
      cfg,
      channel: "slack",
      patch: { dmPolicy: "open" },
    });
    expect(next.channels?.slack?.dmPolicy).toBe("open");
    expect(next.channels?.slack?.dm?.enabled).toBe(false);
  });
});

describe("setLegacyChannelDmPolicyWithAllowFrom", () => {
  it("adds wildcard allowFrom for open policy using legacy dm allowFrom fallback", () => {
    const cfg: OpenClawConfig = {
      channels: {
        discord: {
          dm: {
            enabled: false,
            allowFrom: ["123"],
          },
        },
      },
    };

    const next = setLegacyChannelDmPolicyWithAllowFrom({
      cfg,
      channel: "discord",
      dmPolicy: "open",
    });
    expect(next.channels?.discord?.dmPolicy).toBe("open");
    expect(next.channels?.discord?.allowFrom).toEqual(["123", "*"]);
    expect(next.channels?.discord?.dm?.enabled).toBe(false);
  });

  it("sets policy without changing allowFrom when not open", () => {
    const cfg: OpenClawConfig = {
      channels: {
        slack: {
          allowFrom: ["U1"],
        },
      },
    };

    const next = setLegacyChannelDmPolicyWithAllowFrom({
      cfg,
      channel: "slack",
      dmPolicy: "pairing",
    });
    expect(next.channels?.slack?.dmPolicy).toBe("pairing");
    expect(next.channels?.slack?.allowFrom).toEqual(["U1"]);
  });
});

describe("setLegacyChannelAllowFrom", () => {
  it("writes allowFrom through legacy dm patching", () => {
    const next = setLegacyChannelAllowFrom({
      cfg: {},
      channel: "slack",
      allowFrom: ["U123"],
    });
    expect(next.channels?.slack?.allowFrom).toEqual(["U123"]);
    expect(next.channels?.slack?.dm?.enabled).toBe(true);
  });
});

describe("setAccountGroupPolicyForChannel", () => {
  it("writes group policy on default account config", () => {
    const next = setAccountGroupPolicyForChannel({
      cfg: {},
      channel: "discord",
      accountId: DEFAULT_ACCOUNT_ID,
      groupPolicy: "open",
    });
    expect(next.channels?.discord?.groupPolicy).toBe("open");
    expect(next.channels?.discord?.enabled).toBe(true);
  });

  it("writes group policy on nested non-default account", () => {
    const next = setAccountGroupPolicyForChannel({
      cfg: {},
      channel: "slack",
      accountId: "work",
      groupPolicy: "disabled",
    });
    expect(next.channels?.slack?.accounts?.work?.groupPolicy).toBe("disabled");
    expect(next.channels?.slack?.accounts?.work?.enabled).toBe(true);
  });
});

describe("setChannelDmPolicyWithAllowFrom", () => {
  it("adds wildcard allowFrom when setting dmPolicy=open", () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          dmPolicy: "pairing",
          allowFrom: ["+15555550123"],
        },
      },
    };

    const next = setChannelDmPolicyWithAllowFrom({
      cfg,
      channel: "signal",
      dmPolicy: "open",
    });

    expect(next.channels?.signal?.dmPolicy).toBe("open");
    expect(next.channels?.signal?.allowFrom).toEqual(["+15555550123", "*"]);
  });

  it("sets dmPolicy without changing allowFrom for non-open policies", () => {
    const cfg: OpenClawConfig = {
      channels: {
        imessage: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    };

    const next = setChannelDmPolicyWithAllowFrom({
      cfg,
      channel: "imessage",
      dmPolicy: "pairing",
    });

    expect(next.channels?.imessage?.dmPolicy).toBe("pairing");
    expect(next.channels?.imessage?.allowFrom).toEqual(["*"]);
  });

  it("supports telegram channel dmPolicy updates", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          dmPolicy: "pairing",
          allowFrom: ["123"],
        },
      },
    };

    const next = setChannelDmPolicyWithAllowFrom({
      cfg,
      channel: "telegram",
      dmPolicy: "open",
    });
    expect(next.channels?.telegram?.dmPolicy).toBe("open");
    expect(next.channels?.telegram?.allowFrom).toEqual(["123", "*"]);
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

describe("setTopLevelChannelAllowFrom", () => {
  it("writes allowFrom and can force enabled state", () => {
    const next = setTopLevelChannelAllowFrom({
      cfg: {},
      channel: "msteams",
      allowFrom: ["user-1"],
      enabled: true,
    });
    expect(next.channels?.msteams?.allowFrom).toEqual(["user-1"]);
    expect(next.channels?.msteams?.enabled).toBe(true);
  });
});

describe("setTopLevelChannelGroupPolicy", () => {
  it("writes groupPolicy and can force enabled state", () => {
    const next = setTopLevelChannelGroupPolicy({
      cfg: {},
      channel: "feishu",
      groupPolicy: "allowlist",
      enabled: true,
    });
    expect(next.channels?.feishu?.groupPolicy).toBe("allowlist");
    expect(next.channels?.feishu?.enabled).toBe(true);
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

describe("patchNestedChannelConfigSection", () => {
  it("clears requested nested fields before applying a patch", () => {
    const next = patchNestedChannelConfigSection({
      cfg: {
        channels: {
          matrix: {
            dm: {
              policy: "pairing",
              allowFrom: ["@alice:example.org"],
            },
          },
        },
      },
      channel: "matrix",
      section: "dm",
      clearFields: ["allowFrom"],
      enabled: true,
      patch: { policy: "disabled" as const },
    });

    expect(next.channels?.matrix?.enabled).toBe(true);
    expect(next.channels?.matrix?.dm?.policy).toBe("disabled");
    expect(next.channels?.matrix?.dm?.allowFrom).toBeUndefined();
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

describe("setNestedChannelAllowFrom", () => {
  it("writes nested allowFrom and can force enabled state", () => {
    const next = setNestedChannelAllowFrom({
      cfg: {},
      channel: "googlechat",
      section: "dm",
      allowFrom: ["users/123"],
      enabled: true,
    });

    expect(next.channels?.googlechat?.enabled).toBe(true);
    expect(next.channels?.googlechat?.dm?.allowFrom).toEqual(["users/123"]);
  });
});

describe("setNestedChannelDmPolicyWithAllowFrom", () => {
  it("adds wildcard allowFrom for open policy inside a nested section", () => {
    const next = setNestedChannelDmPolicyWithAllowFrom({
      cfg: {
        channels: {
          matrix: {
            dm: {
              policy: "pairing",
              allowFrom: ["@alice:example.org"],
            },
          },
        },
      },
      channel: "matrix",
      section: "dm",
      dmPolicy: "open",
      enabled: true,
    });

    expect(next.channels?.matrix?.enabled).toBe(true);
    expect(next.channels?.matrix?.dm?.policy).toBe("open");
    expect(next.channels?.matrix?.dm?.allowFrom).toEqual(["@alice:example.org", "*"]);
  });
});

describe("createNestedChannelDmPolicy", () => {
  it("creates a reusable nested dm policy definition", () => {
    const dmPolicy = createNestedChannelDmPolicy({
      label: "Matrix",
      channel: "matrix",
      section: "dm",
      policyKey: "channels.matrix.dm.policy",
      allowFromKey: "channels.matrix.dm.allowFrom",
      getCurrent: (cfg) =>
        (
          cfg.channels?.matrix?.dm as
            | { policy?: "open" | "pairing" | "allowlist" | "disabled" }
            | undefined
        )?.policy ?? "pairing",
      enabled: true,
    });

    const next = dmPolicy.setPolicy(
      {
        channels: {
          matrix: {
            dm: {
              allowFrom: ["@alice:example.org"],
            },
          },
        },
      },
      "open",
    );

    expect(next.channels?.matrix?.enabled).toBe(true);
    expect(next.channels?.matrix?.dm?.policy).toBe("open");
    expect(next.channels?.matrix?.dm?.allowFrom).toEqual(["@alice:example.org", "*"]);
  });
});

describe("createNestedChannelDmPolicySetter", () => {
  it("reuses the shared nested dmPolicy writer", () => {
    const setPolicy = createNestedChannelDmPolicySetter({
      channel: "googlechat",
      section: "dm",
      enabled: true,
    });
    const next = setPolicy({}, "disabled");

    expect(next.channels?.googlechat?.enabled).toBe(true);
    expect(next.channels?.googlechat?.dm?.policy).toBe("disabled");
  });
});

describe("createNestedChannelAllowFromSetter", () => {
  it("reuses the shared nested allowFrom writer", () => {
    const setAllowFrom = createNestedChannelAllowFromSetter({
      channel: "googlechat",
      section: "dm",
      enabled: true,
    });
    const next = setAllowFrom({}, ["users/123"]);

    expect(next.channels?.googlechat?.enabled).toBe(true);
    expect(next.channels?.googlechat?.dm?.allowFrom).toEqual(["users/123"]);
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

describe("createLegacyCompatChannelDmPolicy", () => {
  it("reads nested legacy dm policy and writes top-level compat fields", () => {
    const dmPolicy = createLegacyCompatChannelDmPolicy({
      label: "Slack",
      channel: "slack",
    });

    expect(
      dmPolicy.getCurrent({
        channels: {
          slack: {
            dm: {
              policy: "open",
            },
          },
        },
      }),
    ).toBe("open");

    const next = dmPolicy.setPolicy(
      {
        channels: {
          slack: {
            dm: {
              allowFrom: ["U123"],
            },
          },
        },
      },
      "open",
    );

    expect(next.channels?.slack?.dmPolicy).toBe("open");
    expect(next.channels?.slack?.allowFrom).toEqual(["U123", "*"]);
  });

  it("honors named-account dm policy state and paths", () => {
    const dmPolicy = createLegacyCompatChannelDmPolicy({
      label: "Slack",
      channel: "slack",
    });

    expect(
      dmPolicy.getCurrent(
        {
          channels: {
            slack: {
              dmPolicy: "disabled",
              accounts: {
                alerts: {
                  dmPolicy: "allowlist",
                },
              },
            },
          },
        },
        "alerts",
      ),
    ).toBe("allowlist");

    expect(dmPolicy.resolveConfigKeys?.({}, "alerts")).toEqual({
      policyKey: "channels.slack.accounts.alerts.dmPolicy",
      allowFromKey: "channels.slack.accounts.alerts.allowFrom",
    });

    const next = dmPolicy.setPolicy(
      {
        channels: {
          slack: {
            allowFrom: ["U123"],
            accounts: {
              alerts: {},
            },
          },
        },
      },
      "open",
      "alerts",
    );

    expect(next.channels?.slack?.dmPolicy).toBeUndefined();
    expect(next.channels?.slack?.accounts?.alerts?.dmPolicy).toBe("open");
    expect(next.channels?.slack?.accounts?.alerts?.allowFrom).toEqual(["U123", "*"]);
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

describe("setAccountDmAllowFromForChannel", () => {
  it("writes account-scoped allowlist dm config", () => {
    const next = setAccountDmAllowFromForChannel({
      cfg: {},
      channel: "discord",
      accountId: DEFAULT_ACCOUNT_ID,
      allowFrom: ["123"],
    });

    expect(next.channels?.discord?.dmPolicy).toBe("allowlist");
    expect(next.channels?.discord?.allowFrom).toEqual(["123"]);
  });
});

describe("resolveGroupAllowlistWithLookupNotes", () => {
  it("returns resolved values when lookup succeeds", async () => {
    const prompter = createPrompter([]);
    await expect(
      resolveGroupAllowlistWithLookupNotes({
        label: "Discord channels",
        prompter,
        entries: ["general"],
        fallback: [],
        resolve: async () => ["guild/channel"],
      }),
    ).resolves.toEqual(["guild/channel"]);
    expect(prompter.note).not.toHaveBeenCalled();
  });

  it("notes lookup failure and returns the fallback", async () => {
    const prompter = createPrompter([]);
    await expect(
      resolveGroupAllowlistWithLookupNotes({
        label: "Slack channels",
        prompter,
        entries: ["general"],
        fallback: ["general"],
        resolve: async () => {
          throw new Error("boom");
        },
      }),
    ).resolves.toEqual(["general"]);
    expect(prompter.note).toHaveBeenCalledTimes(2);
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

describe("resolveParsedAllowFromEntries", () => {
  it("maps parsed ids into resolved/unresolved entries", () => {
    expect(
      resolveParsedAllowFromEntries({
        entries: ["alice", " "],
        parseId: (raw) => raw.trim() || null,
      }),
    ).toEqual([
      { input: "alice", resolved: true, id: "alice" },
      { input: " ", resolved: false, id: null },
    ]);
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
      prompter: {} as any,
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
      prompter: {} as any,
      label: "Signal",
      shouldPromptAccountIds: false,
      listAccountIds: () => ["default"],
      defaultAccountId: "fallback",
    });
    expect(accountId).toBe("fallback");
  });

  it("prompts for account id when prompting is enabled and no override is provided", async () => {
    const prompter = {
      select: vi.fn(async () => "prompted-id"),
      text: vi.fn(async () => ""),
      note: vi.fn(async () => undefined),
    };

    const accountId = await resolveAccountIdForConfigure({
      cfg: {},
      prompter: prompter as any,
      label: "Signal",
      shouldPromptAccountIds: true,
      listAccountIds: () => ["default", "prompted-id"],
      defaultAccountId: "fallback",
    });

    expect(accountId).toBe("prompted-id");
    expect(prompter.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Signal account",
        initialValue: "fallback",
      }),
    );
    expect(prompter.text).not.toHaveBeenCalled();
  });
});
