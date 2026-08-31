// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import {
  invalidateChatMetadataStore,
  beginChatMetadataPublication,
} from "../../lib/chat/chat-metadata-store.ts";
import {
  SLASH_COMMANDS,
  getSlashCommandCategoryLabel,
  getSlashCommandDescription,
  type SlashCommandDef,
} from "../../lib/chat/commands.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import {
  applyRemoteSlashCommandsResult,
  dispatchChatSlashCommand,
  refreshSlashCommands,
} from "./chat-commands.ts";

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

function connectedSessionAccess() {
  return {
    client: { request: vi.fn() } as unknown as GatewayBrowserClient,
    connected: true,
    hello: sessionMutationGatewayHello(),
  };
}

function remoteCommand(name: string, description: string) {
  return {
    name,
    textAliases: [`/${name}`],
    description,
    source: "plugin" as const,
    scope: "text" as const,
    acceptsArgs: false,
  };
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

  it("reads commands from the chat metadata store without requesting commands.list", async () => {
    const request = vi.fn();
    const client = { request } as never;
    beginChatMetadataPublication(client, { agentId: "main" }).publish({
      commands: [remoteCommand("metadata-command", "Loaded from chat metadata.")],
    });

    await refreshSlashCommands({ client, agentId: "main" });

    expect(request).not.toHaveBeenCalled();
    expectRecordFields(requireCommandByName("metadata-command"), "metadata command", {
      description: "Loaded from chat metadata.",
      executeLocal: false,
    });
  });

  it("prefers stored metadata after the commands.list cache expires", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn().mockResolvedValue({
        commands: [remoteCommand("cached-command", "Loaded from commands.list.")],
      });
      const client = { request } as never;

      await refreshSlashCommands({ client, agentId: "main" });
      vi.advanceTimersByTime(60_001);
      beginChatMetadataPublication(client, { agentId: "main" }).publish({
        commands: [remoteCommand("metadata-command", "Loaded from chat metadata.")],
      });

      await refreshSlashCommands({ client, agentId: "main" });

      expect(request).toHaveBeenCalledOnce();
      expectRecordFields(requireCommandByName("metadata-command"), "metadata command", {
        description: "Loaded from chat metadata.",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retain applied metadata commands in the commands.list cache", async () => {
    const request = vi.fn().mockResolvedValue({
      commands: [remoteCommand("requested-command", "Loaded after metadata invalidation.")],
    });
    const client = { request } as never;
    const metadata = {
      commands: [remoteCommand("metadata-command", "Loaded from chat metadata.")],
    };
    beginChatMetadataPublication(client, { agentId: "main" }).publish(metadata);
    applyRemoteSlashCommandsResult({ client, agentId: "main", result: metadata });

    invalidateChatMetadataStore(client);
    await refreshSlashCommands({ client, agentId: "main" });

    expect(request).toHaveBeenCalledOnce();
    expectRecordFields(requireCommandByName("requested-command"), "requested command", {
      description: "Loaded after metadata invalidation.",
    });
  });
});

describe("conversation reset confirmation", () => {
  it.each([
    ["stop", "chat.abort"],
    ["reset", "chat.send"],
    ["clear", "sessions.reset"],
    ["compact", "sessions.compact"],
  ] as const)("rejects /%s without its exact operator scope", async (command, method) => {
    const request = vi.fn();
    const reset = vi.fn();
    const client = { request } as unknown as GatewayBrowserClient;
    const host = {
      client,
      connected: true,
      hello: {
        auth: { role: "operator", scopes: ["operator.read"] },
        features: { methods: [method] },
      } as ApplicationGatewaySnapshot["hello"],
      sessionKey: "agent:main:current",
      chatRunId: command === "stop" ? "run-1" : null,
      sessions: { reset },
      confirmConversationReset: vi.fn(async () => true),
      lastError: null,
      chatError: null,
    };

    const result = await dispatchChatSlashCommand(host as never, command, "", {
      sendResetMessage: vi.fn(),
    });

    expect(result).toBe("failed");
    expect(request).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    expect(host.lastError).toBeTruthy();
  });

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
        ...connectedSessionAccess(),
        connectionEpoch: 1,
        sessionKey: "agent:main:current",
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
      ...connectedSessionAccess(),
      connectionEpoch: 1,
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

  it("does not send /reset through a replacement Gateway after confirmation", async () => {
    let settleConfirmation: ((confirmed: boolean) => void) | undefined;
    const confirmation = new Promise<boolean>((resolve) => {
      settleConfirmation = resolve;
    });
    const sendResetMessage = vi.fn(async () => {});
    const host = {
      client: { request: vi.fn() } as unknown as GatewayBrowserClient,
      connected: true,
      connectionEpoch: 1,
      hello: {
        auth: { role: "operator", scopes: ["operator.admin"] },
        features: { methods: ["chat.send"] },
      } as ApplicationGatewaySnapshot["hello"],
      sessionKey: "agent:main:current",
      chatRunId: null,
      confirmConversationReset: vi.fn(async () => await confirmation),
      lastError: null as string | null,
      chatError: null as string | null,
    };

    const pending = dispatchChatSlashCommand(host as never, "reset", "", {
      sendResetMessage,
    });
    host.client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    host.connectionEpoch += 1;
    settleConfirmation?.(true);

    await expect(pending).resolves.toBe("failed");
    expect(sendResetMessage).not.toHaveBeenCalled();
  });

  it("rechecks /reset admin scope after confirmation", async () => {
    let settleConfirmation: ((confirmed: boolean) => void) | undefined;
    const confirmation = new Promise<boolean>((resolve) => {
      settleConfirmation = resolve;
    });
    const sendResetMessage = vi.fn(async () => {});
    const host = {
      ...connectedSessionAccess(),
      connectionEpoch: 1,
      hello: {
        auth: { role: "operator", scopes: ["operator.admin"] },
        features: { methods: ["chat.send"] },
      } as ApplicationGatewaySnapshot["hello"],
      sessionKey: "agent:main:current",
      chatRunId: null,
      confirmConversationReset: vi.fn(async () => await confirmation),
      lastError: null as string | null,
      chatError: null as string | null,
    };

    const pending = dispatchChatSlashCommand(host as never, "reset", "", {
      sendResetMessage,
    });
    host.hello = {
      auth: { role: "operator", scopes: ["operator.write"] },
      features: { methods: ["chat.send"] },
    } as ApplicationGatewaySnapshot["hello"];
    settleConfirmation?.(true);

    await expect(pending).resolves.toBe("failed");
    expect(sendResetMessage).not.toHaveBeenCalled();
    expect(host.lastError).toContain("operator.admin");
  });

  it("continues /reset when the session key changes to an equivalent alias", async () => {
    let settleConfirmation: ((confirmed: boolean) => void) | undefined;
    const confirmation = new Promise<boolean>((resolve) => {
      settleConfirmation = resolve;
    });
    const sendResetMessage = vi.fn(async () => {});
    const host = {
      ...connectedSessionAccess(),
      connectionEpoch: 1,
      sessionKey: "main",
      hello: {
        ...connectedSessionAccess().hello,
        snapshot: {
          sessionDefaults: {
            defaultAgentId: "main",
            mainKey: "main",
            mainSessionKey: "agent:main:main",
            scope: "per-sender",
          },
        },
      },
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
        ...connectedSessionAccess(),
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
    const host = {
      ...connectedSessionAccess(),
      connectionEpoch: 1,
      sessionKey: "agent:main:current",
    };
    const result = await dispatchChatSlashCommand(host as never, "reset", "now", {
      sendResetMessage,
    });

    expect(result).toBe("completed");
    expect(sendResetMessage).toHaveBeenCalledWith(
      "/reset now",
      expect.objectContaining({
        target: expect.objectContaining({
          client: host.client,
          connectionEpoch: 1,
          sessionKey: "agent:main:current",
        }),
      }),
    );
  });

  it("cancels /clear before resetting a board-bearing session", async () => {
    const reset = vi.fn();
    const result = await dispatchChatSlashCommand(
      {
        ...connectedSessionAccess(),
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

  it("does not clear through a replacement Gateway after confirmation", async () => {
    let settleConfirmation: ((confirmed: boolean) => void) | undefined;
    const confirmation = new Promise<boolean>((resolve) => {
      settleConfirmation = resolve;
    });
    const reset = vi.fn();
    const originalClient = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const replacementClient = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const host = {
      client: originalClient,
      connected: true,
      connectionEpoch: 1,
      hello: {
        auth: { role: "operator", scopes: ["operator.admin"] },
        features: { methods: ["sessions.reset"] },
      } as ApplicationGatewaySnapshot["hello"],
      sessionKey: "agent:main:current",
      chatRunId: null,
      confirmConversationReset: vi.fn(async () => await confirmation),
      sessions: { reset },
      lastError: null as string | null,
      chatError: null as string | null,
    };

    const pending = dispatchChatSlashCommand(host as never, "clear", "", {
      sendResetMessage: vi.fn(),
    });
    host.client = replacementClient;
    host.connectionEpoch += 1;
    host.hello = {
      auth: { role: "operator", scopes: ["operator.write"] },
      features: { methods: ["sessions.reset"] },
    } as ApplicationGatewaySnapshot["hello"];
    settleConfirmation?.(true);

    await expect(pending).resolves.toBe("failed");
    expect(reset).not.toHaveBeenCalled();
    expect(host.lastError).toContain("connection changed");
  });

  it("rechecks /clear scope after confirmation", async () => {
    let settleConfirmation: ((confirmed: boolean) => void) | undefined;
    const confirmation = new Promise<boolean>((resolve) => {
      settleConfirmation = resolve;
    });
    const reset = vi.fn();
    const host = {
      ...connectedSessionAccess(),
      connectionEpoch: 1,
      hello: {
        auth: { role: "operator", scopes: ["operator.admin"] },
        features: { methods: ["sessions.reset"] },
      } as ApplicationGatewaySnapshot["hello"],
      sessionKey: "agent:main:current",
      chatRunId: null,
      confirmConversationReset: vi.fn(async () => await confirmation),
      sessions: { reset },
      lastError: null as string | null,
      chatError: null as string | null,
    };

    const pending = dispatchChatSlashCommand(host as never, "clear", "", {
      sendResetMessage: vi.fn(),
    });
    host.hello = {
      auth: { role: "operator", scopes: ["operator.write"] },
      features: { methods: ["sessions.reset"] },
    } as ApplicationGatewaySnapshot["hello"];
    settleConfirmation?.(true);

    await expect(pending).resolves.toBe("failed");
    expect(reset).not.toHaveBeenCalled();
    expect(host.lastError).toContain("operator.admin");
  });
});
