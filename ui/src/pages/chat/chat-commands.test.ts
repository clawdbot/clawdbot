// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  SLASH_COMMANDS,
  getSlashCommandCategoryLabel,
  getSlashCommandDescription,
  type SlashCommandDef,
} from "../../lib/chat/commands.ts";
import { dispatchChatSlashCommand, refreshSlashCommands } from "./chat-commands.ts";

function requireCommandByName(name: string): Record<string, unknown> {
  const command = SLASH_COMMANDS.find((entry) => entry.name === name);
  if (!command) {
    throw new Error(`expected slash command ${name}`);
  }
  return command as unknown as Record<string, unknown>;
}

function expectRecordFields(value: unknown, label: string, expected: Record<string, unknown>) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be an object`);
  }
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key]).toEqual(expectedValue);
  }
}

describe("refreshSlashCommands", () => {
  it("resolves localized UI command metadata", () => {
    const clear = SLASH_COMMANDS.find((entry) => entry.name === "clear");
    const redirect = SLASH_COMMANDS.find((entry) => entry.name === "redirect");
    expect(getSlashCommandDescription(clear as SlashCommandDef)).toBe("Clear chat history");
    expect(getSlashCommandDescription(redirect as SlashCommandDef)).toBe(
      "Abort and restart with a new message",
    );
    expect(getSlashCommandCategoryLabel("tools")).toBe("Tools");
  });

  it("exposes /learn through the browser fallback registry", () => {
    expectRecordFields(requireCommandByName("learn"), "learn command", {
      description: "Draft a reusable skill from recent work or named sources.",
      args: "[request]",
      category: "tools",
      executeLocal: false,
      tier: "standard",
    });
  });

  it("refreshes runtime commands from commands.list", async () => {
    const request = vi.fn().mockImplementation(async (method: string) => {
      expect(method).toBe("commands.list");
      return {
        commands: [
          {
            name: "pair",
            textAliases: ["/pair"],
            description: "Generate setup codes.",
            source: "plugin",
            scope: "both",
            acceptsArgs: true,
          },
        ],
      };
    });

    await refreshSlashCommands({
      client: { request } as never,
      agentId: "main",
    });

    expect(request).toHaveBeenCalledWith("commands.list", {
      agentId: "main",
      includeArgs: true,
      scope: "text",
    });
    expectRecordFields(requireCommandByName("pair"), "pair command", {
      name: "pair",
      description: "Generate setup codes.",
      executeLocal: false,
      tier: "standard",
    });
  });

  it("requests the gateway default agent when no explicit agentId is available", async () => {
    const request = vi.fn().mockResolvedValue({
      commands: [
        {
          name: "pair",
          textAliases: ["/pair"],
          description: "Generate setup codes.",
          source: "plugin",
          scope: "both",
          acceptsArgs: true,
        },
      ],
    });

    await refreshSlashCommands({
      client: { request } as never,
      agentId: undefined,
    });

    expect(request).toHaveBeenCalledWith("commands.list", {
      includeArgs: true,
      scope: "text",
    });
    expectRecordFields(requireCommandByName("pair"), "pair command", {
      name: "pair",
      description: "Generate setup codes.",
      executeLocal: false,
      tier: "standard",
    });
  });

  it("keeps local fallback commands after repeated gateway failures", async () => {
    const request = vi.fn().mockRejectedValue(new Error("offline"));
    const client = { request } as never;

    await refreshSlashCommands({ client, agentId: "main" });
    expectRecordFields(requireCommandByName("help"), "first fallback help command", {
      key: "help",
      executeLocal: true,
    });

    await refreshSlashCommands({ client, agentId: "main" });
    expect(request).toHaveBeenCalledTimes(2);
    expectRecordFields(requireCommandByName("help"), "second fallback help command", {
      key: "help",
      executeLocal: true,
    });
  });

  it("coalesces duplicate refreshes for the same agent", async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    const first = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const request = vi.fn().mockImplementationOnce(async () => await first);
    const client = { request } as never;

    const pending = refreshSlashCommands({
      client,
      agentId: "main",
    });
    const duplicate = refreshSlashCommands({
      client,
      agentId: "main",
    });
    resolveFirst?.({
      commands: [
        {
          name: "pair",
          textAliases: ["/pair"],
          description: "Generate setup codes.",
          source: "plugin",
          scope: "both",
          acceptsArgs: true,
        },
      ],
    });
    await pending;
    await duplicate;

    expect(request).toHaveBeenCalledTimes(1);
    expectRecordFields(requireCommandByName("pair"), "pair command", {
      name: "pair",
      description: "Generate setup codes.",
      executeLocal: false,
      tier: "standard",
    });
  });

  it("ignores stale refresh responses after switching agents", async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    const first = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const request = vi.fn((_: string, params: { agentId?: string }) => {
      if (params.agentId === "main") {
        return first;
      }
      return Promise.resolve({
        commands: [
          {
            name: "pair",
            textAliases: ["/pair"],
            description: "Generate setup codes.",
            source: "plugin",
            scope: "both",
            acceptsArgs: true,
          },
        ],
      });
    });
    const client = { request } as never;

    const pending = refreshSlashCommands({ client, agentId: "main" });
    await refreshSlashCommands({ client, agentId: "other" });
    resolveFirst?.({
      commands: [
        {
          name: "dreaming",
          textAliases: ["/dreaming"],
          description: "Enable or disable memory dreaming.",
          source: "plugin",
          scope: "both",
          acceptsArgs: true,
        },
      ],
    });
    await pending;

    expectRecordFields(requireCommandByName("pair"), "pair command", {
      name: "pair",
      description: "Generate setup codes.",
    });
    expect(SLASH_COMMANDS.find((entry) => entry.name === "dreaming")).toBeUndefined();
  });

  it("uses the fresh remote command cache for repeated refreshes", async () => {
    const request = vi.fn().mockResolvedValue({
      commands: [
        {
          name: "pair",
          textAliases: ["/pair"],
          description: "Generate setup codes.",
          source: "plugin",
          scope: "both",
          acceptsArgs: true,
        },
      ],
    });
    const client = { request } as never;

    await refreshSlashCommands({ client, agentId: "main" });
    await refreshSlashCommands({ client, agentId: "main" });

    expect(request).toHaveBeenCalledTimes(1);
    expectRecordFields(requireCommandByName("pair"), "pair command", {
      name: "pair",
      description: "Generate setup codes.",
    });
  });
});

describe("conversation reset confirmation", () => {
  it("propagates cancelled /new session creation", async () => {
    const result = await dispatchChatSlashCommand(
      { createChatSession: vi.fn(async () => false) } as never,
      "new",
      "",
      { sendResetMessage: vi.fn() },
    );

    expect(result).toBe("cancelled");
  });

  it("cancels /reset before sending when confirmation is rejected", async () => {
    const sendResetMessage = vi.fn(async () => {});
    const result = await dispatchChatSlashCommand(
      {
        confirmConversationReset: vi.fn(async () => false),
      } as never,
      "reset",
      "",
      { sendResetMessage },
    );

    expect(result).toBe("cancelled");
    expect(sendResetMessage).not.toHaveBeenCalled();
  });

  it("cancels /reset when the selected session changes during confirmation", async () => {
    let settleConfirmation: ((confirmed: boolean) => void) | undefined;
    const confirmation = new Promise<boolean>((resolve) => {
      settleConfirmation = resolve;
    });
    const sendResetMessage = vi.fn(async () => {});
    const host = {
      sessionKey: "agent:main:first",
      confirmConversationReset: vi.fn(async () => await confirmation),
    };

    const pending = dispatchChatSlashCommand(host as never, "reset", "", {
      sendResetMessage,
    });
    host.sessionKey = "agent:main:second";
    settleConfirmation?.(true);

    await expect(pending).resolves.toBe("cancelled");
    expect(sendResetMessage).not.toHaveBeenCalled();
  });

  it("continues /reset when the session key changes to an equivalent alias", async () => {
    let settleConfirmation: ((confirmed: boolean) => void) | undefined;
    const confirmation = new Promise<boolean>((resolve) => {
      settleConfirmation = resolve;
    });
    const sendResetMessage = vi.fn(async () => {});
    const host = {
      sessionKey: "main",
      confirmConversationReset: vi.fn(async () => await confirmation),
    };

    const pending = dispatchChatSlashCommand(host as never, "reset", "", {
      sendResetMessage,
    });
    host.sessionKey = "agent:main:main";
    settleConfirmation?.(true);

    await expect(pending).resolves.toBe("completed");
    expect(sendResetMessage).toHaveBeenCalledOnce();
  });

  it.each(["reset", "clear"])(
    "defers /%s when a run starts during confirmation",
    async (command) => {
      let settleConfirmation: ((confirmed: boolean) => void) | undefined;
      const confirmation = new Promise<boolean>((resolve) => {
        settleConfirmation = resolve;
      });
      const sendResetMessage = vi.fn(async () => {});
      const reset = vi.fn();
      const host = {
        chatRunId: null as string | null,
        sessionKey: "agent:main:current",
        confirmConversationReset: vi.fn(async () => await confirmation),
        sessions: { reset },
      };

      const pending = dispatchChatSlashCommand(host as never, command, "", {
        sendResetMessage,
      });
      host.chatRunId = "run-started-during-confirmation";
      settleConfirmation?.(true);

      await expect(pending).resolves.toBe("deferred");
      expect(sendResetMessage).not.toHaveBeenCalled();
      expect(reset).not.toHaveBeenCalled();
    },
  );

  it("keeps chat-only /reset unchanged", async () => {
    const sendResetMessage = vi.fn(async () => {});
    const result = await dispatchChatSlashCommand({} as never, "reset", "now", {
      sendResetMessage,
    });

    expect(result).toBe("completed");
    expect(sendResetMessage).toHaveBeenCalledWith("/reset now", {
      sendResetMessage,
    });
  });

  it("cancels /clear before resetting a board-bearing session", async () => {
    const reset = vi.fn();
    const result = await dispatchChatSlashCommand(
      {
        sessionKey: "agent:main:current",
        confirmConversationReset: vi.fn(async () => false),
        sessions: { reset },
      } as never,
      "clear",
      "",
      { sendResetMessage: vi.fn() },
    );

    expect(result).toBe("cancelled");
    expect(reset).not.toHaveBeenCalled();
  });
});
