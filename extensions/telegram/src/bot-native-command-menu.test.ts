// Telegram tests cover bot native command menu plugin behavior.
import { describe, expect, it, vi } from "vitest";
import {
  buildCappedTelegramMenuCommands,
  buildPluginTelegramMenuCommands,
  syncTelegramMenuCommands,
} from "./bot-native-command-menu.js";

const TELEGRAM_COMMAND_TEXT_LIMIT = 5700;

function waitForTelegramMenu(assertion: () => void) {
  return vi.waitFor(assertion, { interval: 1 });
}

type SyncMenuOptions = {
  deleteMyCommands: ReturnType<typeof vi.fn>;
  setMyCommands: ReturnType<typeof vi.fn>;
  commandsToRegister: Parameters<typeof syncTelegramMenuCommands>[0]["commandsToRegister"];
  accountId: string;
  botToken: string;
  runtimeLog?: ReturnType<typeof vi.fn>;
  runtimeError?: ReturnType<typeof vi.fn>;
};

function syncMenuCommandsWithMocks(options: SyncMenuOptions): void {
  syncTelegramMenuCommands({
    bot: {
      api: { deleteMyCommands: options.deleteMyCommands, setMyCommands: options.setMyCommands },
    } as unknown as Parameters<typeof syncTelegramMenuCommands>[0]["bot"],
    runtime: {
      log: options.runtimeLog ?? vi.fn(),
      error: options.runtimeError ?? vi.fn(),
      exit: vi.fn(),
    } as Parameters<typeof syncTelegramMenuCommands>[0]["runtime"],
    commandsToRegister: options.commandsToRegister,
    accountId: options.accountId,
    botToken: options.botToken,
  });
}

function setMyCommandsCall(setMyCommands: ReturnType<typeof vi.fn>, index: number): unknown[] {
  const call = setMyCommands.mock.calls.at(index);
  if (!call) {
    throw new Error(`Expected setMyCommands call ${index}`);
  }
  return call;
}

function setMyCommandsPayload(
  setMyCommands: ReturnType<typeof vi.fn>,
  index: number,
): Array<unknown> {
  const payload = setMyCommandsCall(setMyCommands, index).at(0);
  if (!Array.isArray(payload)) {
    throw new Error(`Expected setMyCommands call ${index} to include a command payload`);
  }
  return payload;
}

describe("bot-native-command-menu", () => {
  const canonicalCommands = Array.from({ length: 100 }, (_, index) => ({
    command: `canonical_${index}`,
    description: `Canonical ${index}`,
  }));
  it.each([
    {
      label: ">100 count cap",
      allCommands: [
        { command: "early_alias", description: "Alias", isAlias: true },
        ...canonicalCommands,
        { command: "configured", description: "Configured", isConfigured: true },
      ],
      maxTotalChars: TELEGRAM_COMMAND_TEXT_LIMIT,
      retry: false,
      expected: ["configured", ...canonicalCommands.slice(0, 99).map(({ command }) => command)],
    },
    {
      label: "sub-100 text omission",
      allCommands: [
        { command: "early_alias", description: "Alias", isAlias: true },
        { command: "canonical_later", description: "Canonical" },
        { command: "custom_last", description: "Configured", isConfigured: true },
      ],
      maxTotalChars: 28,
      retry: false,
      expected: ["custom_last", "canonical_later"],
    },
    {
      label: "BOT_COMMANDS_TOO_MUCH retry",
      allCommands: [
        { command: "early_alias", description: "Alias", isAlias: true },
        { command: "canonical_a", description: "Canonical A" },
        { command: "configured", description: "Configured", isConfigured: true },
        { command: "canonical_b", description: "Canonical B" },
        { command: "canonical_c", description: "Canonical C" },
      ],
      maxTotalChars: TELEGRAM_COMMAND_TEXT_LIMIT,
      retry: true,
      expected: ["configured", "canonical_a", "canonical_b", "canonical_c"],
    },
    {
      label: "no pressure",
      allCommands: [
        { command: "early_alias", description: "🦞".repeat(250), isAlias: true },
        { command: "canonical", description: "Canonical" },
        { command: "plugin", description: "Plugin" },
        { command: "configured", description: "Configured", isConfigured: true },
      ],
      maxTotalChars: TELEGRAM_COMMAND_TEXT_LIMIT,
      retry: false,
      expected: ["early_alias", "canonical", "plugin", "configured"],
    },
  ])(
    "handles $label with configured, canonical, then alias pressure priority",
    async (testCase) => {
      const result = buildCappedTelegramMenuCommands({
        allCommands: testCase.allCommands,
        maxTotalChars: testCase.maxTotalChars,
      });
      if (!testCase.retry) {
        expect(result.commandsToRegister.map(({ command }) => command)).toEqual(testCase.expected);
        return;
      }

      const setMyCommands = vi
        .fn()
        .mockRejectedValueOnce(new Error("400: Bad Request: BOT_COMMANDS_TOO_MUCH"))
        .mockResolvedValue(undefined);
      syncMenuCommandsWithMocks({
        deleteMyCommands: vi.fn(async () => undefined),
        setMyCommands,
        commandsToRegister: result.commandsToRegister,
        accountId: `test-pressure-${Date.now()}`,
        botToken: "bot-a",
      });
      await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(3));
      const retryPayload = setMyCommandsPayload(setMyCommands, 1);
      expect(retryPayload.map((command) => (command as { command: string }).command)).toEqual(
        testCase.expected,
      );
      expect(setMyCommandsPayload(setMyCommands, 2)).toEqual(retryPayload);
      expect(retryPayload.every((command) => Object.keys(command as object).length === 2)).toBe(
        true,
      );
    },
  );

  it("does not reuse cached capped results for delimiter-like descriptions", () => {
    const first = buildCappedTelegramMenuCommands({
      allCommands: [{ command: "a", description: "b\0c\0d" }],
    });
    const second = buildCappedTelegramMenuCommands({
      allCommands: [
        { command: "a", description: "b" },
        { command: "c", description: "d" },
      ],
    });

    expect(first.commandsToRegister).toEqual([{ command: "a", description: "b\0c\0d" }]);
    expect(second.commandsToRegister).toEqual([
      { command: "a", description: "b" },
      { command: "c", description: "d" },
    ]);
  });

  it("validates plugin command specs and reports conflicts", () => {
    const existingCommands = new Set(["native"]);

    const result = buildPluginTelegramMenuCommands({
      specs: [
        { name: "valid", description: "  Works  " },
        { name: "bad-name!", description: "Bad" },
        { name: "native", description: "Conflicts with native" },
        { name: "valid", description: "Duplicate plugin name" },
        { name: "empty", description: "   " },
      ],
      existingCommands,
    });

    expect(result.commands).toEqual([{ command: "valid", description: "Works" }]);
    expect(result.issues).toContain(
      'Plugin command "/bad-name!" is invalid for Telegram (use a-z, 0-9, underscore; max 32 chars).',
    );
    expect(result.issues).toContain(
      'Plugin command "/native" conflicts with an existing Telegram command.',
    );
    expect(result.issues).toContain('Plugin command "/valid" is duplicated.');
    expect(result.issues).toContain('Plugin command "/empty" is missing a description.');
  });

  it("preserves plugin command description localizations for Telegram menu sync", () => {
    const result = buildPluginTelegramMenuCommands({
      specs: [
        {
          name: "valid",
          description: "Works",
          descriptionLocalizations: { ko: "작동함" },
        },
      ],
      existingCommands: new Set<string>(),
    });

    expect(result.commands).toEqual([
      {
        command: "valid",
        description: "Works",
        descriptionLocalizations: { ko: "작동함" },
      },
    ]);
    expect(result.issues).toStrictEqual([]);
  });

  it("normalizes hyphenated plugin command names", () => {
    const result = buildPluginTelegramMenuCommands({
      specs: [{ name: "agent-run", description: "Run agent" }],
      existingCommands: new Set<string>(),
    });

    expect(result.commands).toEqual([{ command: "agent_run", description: "Run agent" }]);
    expect(result.issues).toStrictEqual([]);
  });

  it("ignores malformed plugin specs without crashing", () => {
    const malformedSpecs = [
      { name: "valid", description: " Works " },
      { name: "missing-description", description: undefined },
      { name: undefined, description: "Missing name" },
    ] as unknown as Parameters<typeof buildPluginTelegramMenuCommands>[0]["specs"];

    const result = buildPluginTelegramMenuCommands({
      specs: malformedSpecs,
      existingCommands: new Set<string>(),
    });

    expect(result.commands).toEqual([{ command: "valid", description: "Works" }]);
    expect(result.issues).toContain(
      'Plugin command "/missing_description" is missing a description.',
    );
    expect(result.issues).toContain(
      'Plugin command "/<unknown>" is invalid for Telegram (use a-z, 0-9, underscore; max 32 chars).',
    );
  });
});
