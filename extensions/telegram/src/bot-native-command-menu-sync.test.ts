// Telegram tests cover native command menu remote synchronization.
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncTelegramMenuCommands } from "./bot-native-command-menu.js";
import { setTelegramRuntime } from "./runtime.js";
import { clearTelegramRuntimeForTest } from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";

function waitForTelegramMenu(assertion: () => void) {
  return vi.waitFor(assertion, { interval: 1 });
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const ledgerRows = new Map<string, unknown>();
let nextBotId = 1_000_000;
const testBotIds = new Map<string, number>();

function createLedgerStore<T>(): PluginStateKeyedStore<T> {
  return {
    register: async (key, value) => {
      ledgerRows.set(key, value);
    },
    registerIfAbsent: async (key, value) => {
      if (ledgerRows.has(key)) {
        return false;
      }
      ledgerRows.set(key, value);
      return true;
    },
    lookup: async (key) => ledgerRows.get(key) as T | undefined,
    consume: async (key) => {
      const value = ledgerRows.get(key) as T | undefined;
      ledgerRows.delete(key);
      return value;
    },
    delete: async (key) => ledgerRows.delete(key),
    entries: async () => [],
    clear: async () => ledgerRows.clear(),
  };
}

type SyncMenuOptions = {
  deleteMyCommands?: ReturnType<typeof vi.fn>;
  setMyCommands: ReturnType<typeof vi.fn>;
  commandsToRegister: Parameters<typeof syncTelegramMenuCommands>[0]["commandsToRegister"];
  accountId: string;
  botIdentity?: string;
  botToken?: string;
  botId?: number;
  runtimeLog?: ReturnType<typeof vi.fn>;
  runtimeError?: ReturnType<typeof vi.fn>;
};

function resolveTestBotToken(options: SyncMenuOptions): string {
  if (options.botToken) {
    return options.botToken;
  }
  const identity = `${options.accountId}:${options.botIdentity ?? "default"}`;
  let botId = testBotIds.get(identity);
  if (!botId) {
    botId = nextBotId++;
    testBotIds.set(identity, botId);
  }
  return `${botId}:test-token`;
}

function syncMenuCommandsWithMocks(options: SyncMenuOptions): void {
  const api = {
    ...(options.deleteMyCommands ? { deleteMyCommands: options.deleteMyCommands } : {}),
    setMyCommands: options.setMyCommands,
  };
  syncTelegramMenuCommands({
    bot: { api } as unknown as Parameters<typeof syncTelegramMenuCommands>[0]["bot"],
    runtime: {
      log: options.runtimeLog ?? vi.fn(),
      error: options.runtimeError ?? vi.fn(),
      exit: vi.fn(),
    } as Parameters<typeof syncTelegramMenuCommands>[0]["runtime"],
    commandsToRegister: options.commandsToRegister,
    accountId: options.accountId,
    botId: options.botId,
    botToken: resolveTestBotToken(options),
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

beforeEach(() => {
  ledgerRows.clear();
  const openKeyedStore = (<T>() =>
    createLedgerStore<T>()) as TelegramRuntime["state"]["openKeyedStore"];
  setTelegramRuntime({ state: { openKeyedStore }, channel: {} } as TelegramRuntime);
});

afterEach(() => {
  clearTelegramRuntimeForTest();
});

describe("bot-native-command-menu sync lifecycle", () => {
  it("deletes stale commands before setting new menu", async () => {
    const callOrder: string[] = [];
    const deleteMyCommands = vi.fn(async (options?: { scope?: { type?: string } }) => {
      callOrder.push(options?.scope?.type ? `delete:${options.scope.type}` : "delete:default");
    });
    const setMyCommands = vi.fn(
      async (_commands: unknown, options?: { scope?: { type?: string } }) => {
        callOrder.push(options?.scope?.type ? `set:${options.scope.type}` : "set:default");
      },
    );

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      commandsToRegister: [{ command: "cmd", description: "Command" }],
      accountId: `test-delete-${Date.now()}`,
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(2));

    expect(callOrder).toEqual([
      "delete:default",
      "delete:all_group_chats",
      "set:default",
      "set:all_group_chats",
    ]);
  });

  it("registers the menu in default and group chat scopes", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const commands = [{ command: "cmd", description: "Command" }];

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      commandsToRegister: commands,
      accountId: `test-scopes-${Date.now()}`,
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(2));

    expect(setMyCommands).toHaveBeenCalledWith(commands);
    expect(setMyCommands).toHaveBeenCalledWith(commands, {
      scope: { type: "all_group_chats" },
    });
  });

  it("registers localized command descriptions per Telegram language scope", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const runtimeLog = vi.fn();
    const commands = [
      {
        command: "cmd",
        description: "Default",
        descriptionLocalizations: {
          ko: "한국어",
          "en-GB": "British English is unsupported by Telegram",
        },
      },
    ];

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeLog,
      commandsToRegister: commands,
      accountId: `test-localized-${Date.now()}`,
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(4));

    expect(deleteMyCommands).toHaveBeenCalledTimes(2);
    expect(setMyCommandsPayload(setMyCommands, 0)).toEqual([
      { command: "cmd", description: "Default" },
    ]);
    expect(setMyCommandsPayload(setMyCommands, 2)).toEqual([
      { command: "cmd", description: "한국어" },
    ]);
    expect(setMyCommandsCall(setMyCommands, 2).at(1)).toEqual({ language_code: "ko" });
    expect(setMyCommandsCall(setMyCommands, 3).at(1)).toEqual({
      scope: { type: "all_group_chats" },
      language_code: "ko",
    });
    expect(runtimeLog).toHaveBeenCalledWith(
      "Telegram command menu ignored unsupported description localization codes: en-GB.",
    );
  });

  it("caps localized command descriptions before registering Telegram variants", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      commandsToRegister: [
        {
          command: "long",
          description: "Default",
          descriptionLocalizations: { ko: "x".repeat(300) },
        },
      ],
      accountId: `test-localized-cap-${Date.now()}`,
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(4));

    const localizedPayload = setMyCommandsPayload(setMyCommands, 2);
    expect(localizedPayload[0]).toMatchObject({ command: "long" });
    expect((localizedPayload[0] as { description: string }).description).toHaveLength(256);
  });

  it("prioritizes configured, canonical, then alias commands under localization-only pressure", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const localizedDescription = "한".repeat(250);
    const canonical = Array.from({ length: 22 }, (_, index) => ({
      command: `canonical_${index}`,
      description: `Canonical ${index}`,
      descriptionLocalizations: { ko: localizedDescription },
    }));

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      commandsToRegister: [
        {
          command: "early_alias",
          description: "Alias",
          descriptionLocalizations: { ko: localizedDescription },
          isAlias: true,
        },
        ...canonical,
        {
          command: "configured",
          description: "Configured",
          descriptionLocalizations: { ko: localizedDescription },
          isConfigured: true,
        },
      ],
      accountId: `test-localized-pressure-${Date.now()}`,
    });

    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(4));
    const localizedNames = setMyCommandsPayload(setMyCommands, 2).map(
      (command) => (command as { command: string }).command,
    );
    expect(localizedNames).toEqual([
      "configured",
      ...canonical.map(({ command }) => command),
      "early_alias",
    ]);
    expect(setMyCommandsPayload(setMyCommands, 3)).toEqual(setMyCommandsPayload(setMyCommands, 2));
  });

  it("preserves ordinary localized order when localization creates no pressure", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      commandsToRegister: [
        {
          command: "early_alias",
          description: "Alias",
          descriptionLocalizations: { ko: "별칭" },
          isAlias: true,
        },
        {
          command: "canonical",
          description: "Canonical",
          descriptionLocalizations: { ko: "표준" },
        },
        {
          command: "configured",
          description: "Configured",
          descriptionLocalizations: { ko: "설정" },
          isConfigured: true,
        },
      ],
      accountId: `test-localized-no-pressure-${Date.now()}`,
    });

    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(4));
    expect(setMyCommandsPayload(setMyCommands, 2)).toEqual([
      { command: "early_alias", description: "별칭" },
      { command: "canonical", description: "표준" },
      { command: "configured", description: "설정" },
    ]);
    expect(setMyCommandsPayload(setMyCommands, 3)).toEqual(setMyCommandsPayload(setMyCommands, 2));
  });

  it("resyncs when command order changes (#32017)", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const commands = [
      { command: "bravo", description: "B" },
      { command: "alpha", description: "A" },
    ];
    const accountId = `test-order-stable-${Date.now()}`;

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      commandsToRegister: commands,
      accountId,
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(2));
    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      commandsToRegister: commands.toReversed(),
      accountId,
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(4));

    expect(deleteMyCommands).toHaveBeenCalledTimes(4);
  });

  it("resyncs when a command description changes (#32017)", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const accountId = `test-description-change-${Date.now()}`;

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      commandsToRegister: [{ command: "alpha", description: "A" }],
      accountId,
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(2));
    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      commandsToRegister: [{ command: "alpha", description: "Changed" }],
      accountId,
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(4));
  });

  it("resyncs delimiter-like command lists without hash collisions", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const accountId = `test-delimiter-collision-${Date.now()}`;

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      commandsToRegister: [{ command: "a", description: "b\0c\0d" }],
      accountId,
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(2));
    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      commandsToRegister: [
        { command: "a", description: "b" },
        { command: "c", description: "d" },
      ],
      accountId,
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(4));
  });

  it("skips sync when command hash is unchanged (#32017)", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const accountId = `test-skip-${Date.now()}`;
    const commands = [{ command: "skip_test", description: "Skip test command" }];

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      commandsToRegister: commands,
      accountId,
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(2));
    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      commandsToRegister: commands,
      accountId,
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(deleteMyCommands).toHaveBeenCalledTimes(2);
    expect(setMyCommands).toHaveBeenCalledTimes(2);
  });

  it("ignores internal priority metadata in the requested-state hash (#32017)", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const accountId = `test-priority-hash-${Date.now()}`;

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      commandsToRegister: [
        {
          command: "skip_test",
          description: "Skip test command",
          isAlias: true,
          isConfigured: true,
        },
      ],
      accountId,
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(2));

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      commandsToRegister: [{ command: "skip_test", description: "Skip test command" }],
      accountId,
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(deleteMyCommands).toHaveBeenCalledTimes(2);
    expect(setMyCommands).toHaveBeenCalledTimes(2);
  });

  it("does not reuse cached hash across different bot identities", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const accountId = `test-bot-identity-${Date.now()}`;
    const commands = [{ command: "same", description: "Same" }];

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      commandsToRegister: commands,
      accountId,
      botIdentity: "bot-a",
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(2));
    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      commandsToRegister: commands,
      accountId,
      botIdentity: "bot-b",
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(4));
  });

  it("does not cache empty-menu hash when deleteMyCommands fails", async () => {
    const deleteMyCommands = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient failure"))
      .mockResolvedValue(undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const accountId = `test-empty-delete-fail-${Date.now()}`;

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      commandsToRegister: [],
      accountId,
    });
    await waitForTelegramMenu(() => expect(deleteMyCommands).toHaveBeenCalledTimes(2));
    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      commandsToRegister: [],
      accountId,
    });
    await waitForTelegramMenu(() => expect(deleteMyCommands).toHaveBeenCalledTimes(4));
  });

  it("retries with fewer commands on BOT_COMMANDS_TOO_MUCH", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi
      .fn()
      .mockRejectedValueOnce(new Error("400: Bad Request: BOT_COMMANDS_TOO_MUCH"))
      .mockResolvedValue(undefined);
    const runtimeLog = vi.fn();
    const runtimeError = vi.fn();

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeLog,
      runtimeError,
      commandsToRegister: Array.from({ length: 100 }, (_, i) => ({
        command: `cmd_${i}`,
        description: `Command ${i}`,
      })),
      accountId: `test-retry-${Date.now()}`,
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(3));

    expect(setMyCommandsPayload(setMyCommands, 0)).toHaveLength(100);
    expect(setMyCommandsPayload(setMyCommands, 1)).toHaveLength(80);
    expect(setMyCommandsPayload(setMyCommands, 2)).toHaveLength(80);
    expect(setMyCommandsCall(setMyCommands, 2).at(1)).toEqual({
      scope: { type: "all_group_chats" },
    });
    expect(runtimeLog).toHaveBeenCalledWith(
      "Telegram rejected 100 commands (BOT_COMMANDS_TOO_MUCH); retrying with 80.",
    );
    expect(runtimeLog).toHaveBeenCalledWith(
      "Telegram accepted 80 commands after BOT_COMMANDS_TOO_MUCH (started with 100; omitted 20). Reduce plugin/skill/custom commands to expose more menu entries.",
    );
    expect(runtimeError).not.toHaveBeenCalled();
  });

  it("registers localized variants from the accepted retry command set", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi
      .fn()
      .mockRejectedValueOnce(new Error("400: Bad Request: BOT_COMMANDS_TOO_MUCH"))
      .mockResolvedValue(undefined);

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      commandsToRegister: Array.from({ length: 100 }, (_, i) => ({
        command: `cmd_${i}`,
        description: `Command ${i}`,
        descriptionLocalizations: { ko: `명령 ${i}` },
      })),
      accountId: `test-localized-retry-${Date.now()}`,
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(5));

    expect(setMyCommandsPayload(setMyCommands, 0)).toHaveLength(100);
    expect(setMyCommandsPayload(setMyCommands, 1)).toHaveLength(80);
    expect(setMyCommandsPayload(setMyCommands, 3)).toHaveLength(80);
    expect(setMyCommandsCall(setMyCommands, 3).at(1)).toEqual({ language_code: "ko" });
  });

  it.each([
    { label: "description envelope", error: { description: "BOT_COMMANDS_TOO_MUCH" } },
    { label: "message envelope", error: { message: "BOT_COMMANDS_TOO_MUCH" } },
  ])("retries when Telegram returns a plain-object $label error", async ({ error, label }) => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const runtimeLog = vi.fn();

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeLog,
      commandsToRegister: Array.from({ length: 10 }, (_, i) => ({
        command: `cmd_${i}`,
        description: `Command ${i}`,
      })),
      accountId: `test-envelope-${Date.now()}-${label}`,
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(3));
    expect(runtimeLog).toHaveBeenCalledWith(
      "Telegram rejected 10 commands (BOT_COMMANDS_TOO_MUCH); retrying with 8.",
    );
  });

  it("clears removed localized scope pairs in one strictly serialized generation", async () => {
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;
    const record = async (
      kind: string,
      options?: { scope?: { type?: string }; language_code?: string },
    ) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      events.push(
        `${kind}:${options?.language_code ?? "neutral"}:${options?.scope?.type ?? "default"}`,
      );
      await Promise.resolve();
      active -= 1;
    };
    const deleteMyCommands = vi.fn(async (options) => record("delete", options));
    const setMyCommands = vi.fn(async (_commands, options) => record("set", options));
    const accountId = `test-locale-removal-${Date.now()}`;

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      accountId,
      commandsToRegister: [
        {
          command: "cmd",
          description: "Default",
          descriptionLocalizations: { fr: "Français", ko: "한국어" },
        },
      ],
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(6));
    events.length = 0;
    deleteMyCommands.mockClear();
    setMyCommands.mockClear();

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      accountId,
      commandsToRegister: [
        {
          command: "cmd",
          description: "Default",
          descriptionLocalizations: { ko: "한국어" },
        },
      ],
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(4));

    expect(events).toEqual([
      "delete:neutral:default",
      "delete:neutral:all_group_chats",
      "delete:fr:default",
      "delete:fr:all_group_chats",
      "delete:ko:default",
      "delete:ko:all_group_chats",
      "set:neutral:default",
      "set:neutral:all_group_chats",
      "set:ko:default",
      "set:ko:all_group_chats",
    ]);
    expect(maxActive).toBe(1);
  });

  it("queues a later generation until the current remote-owner lane completes", async () => {
    const gate = createDeferred();
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;
    const deleteMyCommands = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      events.push("delete");
      active -= 1;
    });
    const setMyCommands = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      events.push("set");
      if (setMyCommands.mock.calls.length === 1) {
        await gate.promise;
      }
      active -= 1;
    });
    const accountId = `test-generation-queue-${Date.now()}`;

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      accountId,
      commandsToRegister: [{ command: "first", description: "First" }],
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(1));
    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      accountId,
      commandsToRegister: [{ command: "second", description: "Second" }],
    });
    await Promise.resolve();

    expect(deleteMyCommands).toHaveBeenCalledTimes(2);
    expect(setMyCommands).toHaveBeenCalledTimes(1);
    expect(active).toBe(1);
    gate.resolve();
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(4));

    expect(events).toEqual(["delete", "delete", "set", "set", "delete", "delete", "set", "set"]);
    expect(maxActive).toBe(1);
  });

  it("retries failed localized cleanup instead of hash-caching it", async () => {
    let failFrenchGroupClear = false;
    const deleteMyCommands = vi.fn(
      async (options?: { scope?: { type?: string }; language_code?: string }) => {
        if (
          failFrenchGroupClear &&
          options?.language_code === "fr" &&
          options.scope?.type === "all_group_chats"
        ) {
          failFrenchGroupClear = false;
          throw new Error("localized cleanup failed");
        }
      },
    );
    const setMyCommands = vi.fn(async () => undefined);
    const runtimeError = vi.fn();
    const accountId = `test-cleanup-retry-${Date.now()}`;

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeError,
      accountId,
      commandsToRegister: [
        { command: "cmd", description: "Default", descriptionLocalizations: { fr: "Français" } },
      ],
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(4));
    deleteMyCommands.mockClear();
    setMyCommands.mockClear();
    failFrenchGroupClear = true;

    const neutralCommands = [{ command: "cmd", description: "Default" }];
    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeError,
      accountId,
      commandsToRegister: neutralCommands,
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(2));
    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeError,
      accountId,
      commandsToRegister: neutralCommands,
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(4));

    const frenchGroupClears = deleteMyCommands.mock.calls.filter(
      ([options]) => options?.language_code === "fr" && options?.scope?.type === "all_group_chats",
    );
    expect(frenchGroupClears).toHaveLength(2);
    expect(runtimeError).toHaveBeenCalled();
  });

  it("keys the durable locale ledger by stable bot ID across token rotation", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const accountId = `test-ledger-bot-id-${Date.now()}`;

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      accountId,
      botToken: "987654321:old-token",
      commandsToRegister: [
        { command: "cmd", description: "Default", descriptionLocalizations: { fr: "Français" } },
      ],
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(4));
    expect([...ledgerRows.keys()]).toEqual(["987654321"]);
    deleteMyCommands.mockClear();
    setMyCommands.mockClear();

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      accountId,
      botToken: "987654321:new-token",
      commandsToRegister: [{ command: "cmd", description: "Default" }],
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(2));

    expect(deleteMyCommands).toHaveBeenCalledWith({ language_code: "fr" });
    expect(deleteMyCommands).toHaveBeenCalledWith({
      scope: { type: "all_group_chats" },
      language_code: "fr",
    });
    expect(ledgerRows.has("987654321")).toBe(false);
  });

  it("uses empty setMyCommands for each exact scope/language pair when delete is unavailable", async () => {
    const setMyCommands = vi.fn(async () => undefined);
    const accountId = `test-clear-fallback-${Date.now()}`;

    syncMenuCommandsWithMocks({
      setMyCommands,
      accountId,
      commandsToRegister: [
        { command: "cmd", description: "Default", descriptionLocalizations: { fr: "Français" } },
      ],
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(6));
    setMyCommands.mockClear();

    syncMenuCommandsWithMocks({
      setMyCommands,
      accountId,
      commandsToRegister: [{ command: "cmd", description: "Default" }],
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(6));

    expect(setMyCommands).toHaveBeenCalledWith([], { language_code: "fr" });
    expect(setMyCommands).toHaveBeenCalledWith([], {
      scope: { type: "all_group_chats" },
      language_code: "fr",
    });
  });
});
