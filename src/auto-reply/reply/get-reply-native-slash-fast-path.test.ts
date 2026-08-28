import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import * as preparedModelCatalog from "../../agents/prepared-model-catalog.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  loadExactSessionEntry,
  loadSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import { markCompleteReplyConfig } from "./get-reply-fast-path.test-support.js";
import * as sessionPersistence from "./session-entry-persistence.js";
import { buildTestCtx } from "./test-ctx.js";
import type { TypingController } from "./typing.js";

const { handleCommandsMock, buildStatusReplyMock } = vi.hoisted(() => ({
  handleCommandsMock: vi.fn(),
  buildStatusReplyMock: vi.fn(),
}));

vi.mock("./commands.runtime.js", () => ({
  handleCommands: (...args: unknown[]) => handleCommandsMock(...args),
}));

vi.mock("./commands-status.js", () => ({
  buildStatusReply: (...args: unknown[]) => buildStatusReplyMock(...args),
}));

const { maybeResolveNativeSlashCommandFastReply } =
  await import("./get-reply-native-slash-fast-path.js");

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => cliBackendsTesting.resetDepsForTest());

const createTypingController = (): TypingController => ({
  onReplyStart: async () => {},
  startTypingLoop: async () => {},
  startTypingOnText: async () => {},
  refreshTypingTtl: () => {},
  isActive: () => false,
  markRunComplete: () => {},
  markDispatchIdle: () => {},
  cleanup: vi.fn(),
});

type NativeSlashFastReplyParams = Parameters<typeof maybeResolveNativeSlashCommandFastReply>[0];
type NativeSlashFastReplyDefaultKey =
  | "agentDir"
  | "agentCfg"
  | "defaultProvider"
  | "defaultModel"
  | "aliasIndex"
  | "provider"
  | "model"
  | "workspaceDir";

function runTestNativeSlashFastReply(
  overrides: Omit<NativeSlashFastReplyParams, NativeSlashFastReplyDefaultKey> &
    Partial<Pick<NativeSlashFastReplyParams, NativeSlashFastReplyDefaultKey>>,
) {
  return maybeResolveNativeSlashCommandFastReply({
    agentDir: "/tmp/agent",
    agentCfg: undefined,
    defaultProvider: "openai",
    defaultModel: "gpt-5.5",
    aliasIndex: { byKey: new Map(), byAlias: new Map() },
    provider: "openai",
    model: "gpt-5.5",
    workspaceDir: "/tmp/workspace",
    ...overrides,
  });
}

describe("maybeResolveNativeSlashCommandFastReply", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [{ id: "claude-cli", modelProvider: "anthropic" }] as never,
      resolvePluginSetupCliBackend: () => {
        throw new Error("native command attempted synchronous CLI setup discovery");
      },
    });
    vi.spyOn(preparedModelCatalog, "loadPreparedModelCatalogSnapshot").mockResolvedValue({
      entries: [
        {
          id: "gpt-5.5",
          name: "GPT",
          provider: "openai",
          contextWindow: 400_000,
          reasoning: false,
        },
        {
          id: "claude-fable-5",
          name: "Fable",
          provider: "anthropic",
          contextWindow: 1_000_000,
          reasoning: false,
        },
      ],
      routeVariants: [],
    });
    handleCommandsMock.mockReset();
    buildStatusReplyMock.mockReset();
    buildStatusReplyMock.mockResolvedValue({ text: "selected model status" });
  });

  async function resolveNativeDirectiveCommand(
    body: string,
    config?: OpenClawConfig,
    response: { shouldContinue: boolean; reply?: { text: string } } = { shouldContinue: true },
  ) {
    handleCommandsMock.mockResolvedValue(response);
    const commandName = body.slice(1).split(/\s+/, 1)[0] ?? "";
    const typing = createTypingController();
    const resolvedConfig =
      config ??
      ({
        session: {
          store: path.join(tempDirs.make("openclaw-native-directive-"), "sessions.json"),
        },
      } as OpenClawConfig);
    const result = await runTestNativeSlashFastReply({
      ctx: buildTestCtx({
        Body: body,
        BodyForAgent: body,
        RawBody: body,
        CommandBody: body,
        CommandSource: "native",
        CommandAuthorized: true,
        Provider: "telegram",
        Surface: "telegram",
        GatewayClientScopes: ["operator.admin"],
        SessionKey: "telegram:slash:123",
        CommandTargetSessionKey: "agent:main:telegram:123",
        CommandTurn: {
          kind: "native",
          source: "native",
          authorized: true,
          commandName,
          body,
        },
      }),
      cfg: markCompleteReplyConfig(resolvedConfig),
      agentId: "main",
      agentCfg: config?.agents?.defaults,
      commandAuthorized: true,
      typing,
    });

    return { result, typing, storePath: resolvedConfig.session?.store };
  }

  it("persists a native exec node selection before model dispatch", async () => {
    const { result, storePath } = await resolveNativeDirectiveCommand(
      "/exec host=node node=worker-1",
    );

    expect(result).toMatchObject({
      handled: true,
      reply: { text: expect.stringContaining("Exec defaults set (host=node, node=worker-1).") },
    });
    expect(
      loadExactSessionEntry({
        sessionKey: "agent:main:telegram:123",
        storePath: storePath ?? "",
      })?.entry,
    ).toMatchObject({ execHost: "node", execNode: "worker-1" });
  });

  it.each([
    { command: "/queue Can you diagnose this?", expected: 'Unrecognized queue mode "Can".' },
    { command: "/queue /think high", expected: 'Unrecognized queue mode "/think"' },
    {
      command: "/think about my deployment plan",
      expected: 'Unrecognized thinking level "about".',
    },
    {
      command: "/verbose explain quantum computing",
      expected: 'Unrecognized verbose level "explain".',
    },
    {
      command: "/trace banana please",
      expected: 'Unrecognized trace level "banana".',
    },
    {
      command: "/fast bananas please",
      expected: 'Unrecognized fast mode "bananas".',
    },
    {
      command: "/reasoning nonsense please",
      expected: 'Unrecognized reasoning level "nonsense".',
    },
  ])("validates every native directive argument: $command", async ({ command, expected }) => {
    const { result } = await resolveNativeDirectiveCommand(command);

    expect(result).toEqual({
      handled: true,
      reply: expect.objectContaining({ text: expect.stringContaining(expected) }),
    });
  });

  it.each([
    { command: "/queue collect please help", expected: 'Unexpected argument "please" for /queue.' },
    { command: "/think high please", expected: 'Unexpected argument "please" for /think.' },
    { command: "/verbose on please", expected: 'Unexpected argument "please" for /verbose.' },
    { command: "/fast on please", expected: 'Unexpected argument "please" for /fast.' },
    {
      command: "/reasoning on please",
      expected: 'Unexpected argument "please" for /reasoning.',
    },
    { command: "/exec host=node please", expected: 'Unexpected argument "please" for /exec.' },
    {
      command: "/model openai/gpt-5.5 --runtime codex --runtime acp",
      expected: 'Unexpected argument "--runtime" for /model.',
    },
    {
      command: "/model openai/gpt-5.5 -slow",
      expected: 'Unexpected argument "-slow" for /model.',
    },
  ])(
    "rejects trailing prose instead of dropping native command $command",
    async ({ command, expected }) => {
      const { result } = await resolveNativeDirectiveCommand(command);

      expect(result).toEqual({
        handled: true,
        reply: expect.objectContaining({ text: expected }),
      });
    },
  );

  it.each(["--runtime codex -s", "-s --runtime codex"])(
    "applies native /model runtime and session options from %s",
    async (options) => {
      const storePath = path.join(tempDirs.make("openclaw-native-model-options-"), "sessions.json");
      const { result } = await resolveNativeDirectiveCommand(
        `/model openai/gpt-5.5 ${options}`,
        {
          session: { store: storePath },
          agents: { defaults: { models: { "openai/gpt-5.5": {} } } },
        },
        { shouldContinue: true },
      );

      expect(result).toMatchObject({
        handled: true,
        reply: {
          text: "Session model reset to configured default (openai/gpt-5.5). Runtime set to codex for this session.",
        },
      });
      const sessionEntry = loadExactSessionEntry({
        sessionKey: "agent:main:telegram:123",
        storePath,
      })?.entry;
      expect(sessionEntry).toMatchObject({ agentRuntimeOverride: "codex" });
    },
  );

  it("marks native /compact terminal replies for delivery under message_tool_only (#90185)", async () => {
    const reply = {
      text: "⚙️ Compaction skipped: no real conversation messages yet • Context 12.1k",
    };
    const { result } = await resolveNativeDirectiveCommand("/compact", undefined, {
      shouldContinue: false,
      reply,
    });

    expect(result).toMatchObject({ handled: true, reply });
    if (!result.handled || !result.reply || Array.isArray(result.reply)) {
      throw new Error("expected single handled reply payload");
    }
    expect(getReplyPayloadMetadata(result.reply)?.deliverDespiteSourceReplySuppression).toBe(true);
  });

  it("resolves the selected model context for native compact", async () => {
    handleCommandsMock.mockResolvedValueOnce({
      shouldContinue: false,
      reply: { text: "⚙️ Compacted" },
    });

    const storePath = path.join(tempDirs.make("openclaw-native-override-"), "sessions.json");
    await replaceSessionEntry(
      { agentId: "main", sessionKey: "agent:main:main", storePath },
      {
        sessionId: "fable-session",
        updatedAt: Date.now(),
        providerOverride: "anthropic",
        modelOverride: "claude-fable-5",
        modelOverrideSource: "user",
        contextTokens: 1_000_000,
        agentRuntimeOverride: "claude-cli",
        thinkingLevel: "off",
      },
    );

    const typing = createTypingController();
    const result = await runTestNativeSlashFastReply({
      ctx: buildTestCtx({
        Body: "/compact",
        CommandBody: "/compact",
        CommandSource: "native",
        CommandAuthorized: true,
        SessionKey: "telegram:slash:123",
        CommandTargetSessionKey: "agent:main:main",
        CommandTurn: {
          kind: "native",
          source: "native",
          authorized: true,
          commandName: "compact",
          body: "/compact",
        },
      }),
      cfg: markCompleteReplyConfig(
        {
          session: { store: storePath },
        } as OpenClawConfig,
        { runtimeMode: "full" },
      ),
      agentId: "main",
      agentCfg: undefined,
      commandAuthorized: true,
      typing,
    });

    expect(result.handled).toBe(true);
    expect(handleCommandsMock).toHaveBeenCalledOnce();
    const call = handleCommandsMock.mock.calls[0]?.[0] as
      | { provider?: string; model?: string; contextTokens?: number }
      | undefined;
    // The selected model owns the context budget forwarded into command handling.
    expect(call?.provider).toBe("anthropic");
    expect(call?.model).toMatch(/claude-fable-5/);
    expect(call?.contextTokens).toBe(1_000_000);
    expect(typing.cleanup).toHaveBeenCalledTimes(1);
  });

  it.each([
    { source: "auto" as const, locked: false, expectedProvider: "openai" },
    { source: "auto" as const, locked: false, activeFallback: true, expectedProvider: "anthropic" },
    { source: "auto" as const, locked: true, expectedProvider: "anthropic" },
    { source: undefined, locked: false, legacyAuto: true, expectedProvider: "anthropic" },
    {
      source: "auto" as const,
      locked: false,
      selfOrigin: true,
      targetAgentId: "subagent",
      expectedProvider: "anthropic",
    },
    {
      source: "user" as const,
      locked: false,
      transportAuthorized: false,
      approvedByPolicy: true,
      expectedProvider: "anthropic",
    },
    {
      source: "user" as const,
      locked: false,
      overrideProvider: "claude-cli",
      hasBoundCli: true,
      expectedProvider: "anthropic",
    },
    {
      source: "user" as const,
      locked: false,
      allowed: ["openai/*"],
      agentAllowed: ["anthropic/legacy-fast-model", "anthropic/claude-sonnet-4-6"],
      targetAgentId: "research",
      overrideModel: "claude-sonnet-4-6",
      resolvedModel: "claude-sonnet-4-6",
      expectedProvider: "anthropic",
    },
    {
      source: "user" as const,
      locked: false,
      allowed: ["openai/*"],
      expectedProvider: "openai",
    },
    {
      source: "user" as const,
      locked: false,
      allowed: ["anthropic/*"],
      expectedProvider: "anthropic",
    },
    {
      source: "user" as const,
      locked: true,
      allowed: ["openai/*"],
      expectedProvider: "anthropic",
    },
    {
      source: "user" as const,
      locked: false,
      allowed: ["anthropic/*"],
      agentAllowed: ["openai/*"],
      expectedProvider: "openai",
    },
    {
      source: "user" as const,
      locked: false,
      allowed: ["anthropic/claude-fable-5"],
      overrideProvider: "openai",
      overrideModel: "gpt-5.5",
      expectedProvider: "openai",
      expectedContextTokens: 200_000,
    },
    {
      source: "user" as const,
      locked: false,
      allowed: ["openai/*"],
      agentAllowed: ["anthropic/claude-fable-5"],
      targetAgentId: "target",
      agentCap: 120_000,
      overrideProvider: "openai",
      overrideModel: "gpt-5.5",
      expectedProvider: "openai",
      expectedContextTokens: 200_000,
    },
  ])(
    "uses only user-selected or locked session overrides ($source, locked=$locked)",
    async (testCase) => {
      const { source, locked, expectedProvider } = testCase;
      const transportAuthorized =
        ("transportAuthorized" in testCase ? testCase.transportAuthorized : undefined) ?? true;
      handleCommandsMock.mockResolvedValueOnce({
        shouldContinue: false,
        reply: { text: "compacted" },
      });
      const targetAgentId =
        ("targetAgentId" in testCase ? testCase.targetAgentId : undefined) ?? "main";
      const resolvedModel = "resolvedModel" in testCase ? testCase.resolvedModel : undefined;
      const targetSessionKey = `agent:${targetAgentId}:main`;
      const storePath = path.join(tempDirs.make("openclaw-native-source-"), "sessions.json");
      await replaceSessionEntry(
        { agentId: targetAgentId, sessionKey: targetSessionKey, storePath },
        {
          sessionId: "selected-session",
          updatedAt: Date.now(),
          providerOverride:
            "overrideProvider" in testCase ? testCase.overrideProvider : "anthropic",
          modelOverride: "overrideModel" in testCase ? testCase.overrideModel : "claude-fable-5",
          modelOverrideSource: source,
          modelSelectionLocked: locked,
          contextTokens: 1_000_000,
          thinkingLevel: "off",
          ...("legacyAuto" in testCase || "selfOrigin" in testCase || "activeFallback" in testCase
            ? {
                modelOverrideFallbackOriginProvider:
                  "selfOrigin" in testCase ? "anthropic" : "openai",
                modelOverrideFallbackOriginModel:
                  "selfOrigin" in testCase ? "claude-fable-5" : "gpt-5.5",
              }
            : {}),
          ...("hasBoundCli" in testCase
            ? {
                agentHarnessId: "claude-cli",
                cliSessionBindings: {
                  "claude-cli": { sessionId: "native-claude-session", forceReuse: true },
                },
              }
            : {}),
        },
      );

      const result = await runTestNativeSlashFastReply({
        ctx: buildTestCtx({
          Body: "/compact",
          CommandBody: "/compact",
          CommandSource: "native",
          CommandAuthorized: transportAuthorized,
          Provider: "telegram",
          Surface: "telegram",
          From: "telegram:approved-sender",
          SenderId: "approved-sender",
          SessionKey: "telegram:slash:123",
          CommandTargetSessionKey: targetSessionKey,
          CommandTurn: {
            kind: "native",
            source: "native",
            authorized: transportAuthorized,
            commandName: "compact",
            body: "/compact",
          },
        }),
        cfg: markCompleteReplyConfig(
          {
            session: { store: storePath },
            ...("approvedByPolicy" in testCase
              ? { commands: { allowFrom: { "*": ["approved-sender"] } } }
              : {}),
            ...("allowed" in testCase
              ? {
                  agents: {
                    defaults: {
                      model: { primary: "openai/gpt-5.5" },
                      modelPolicy: { allow: testCase.allowed },
                    },
                    ...("agentAllowed" in testCase
                      ? {
                          list: [
                            {
                              id: targetAgentId,
                              modelPolicy: { allow: testCase.agentAllowed },
                              ...("agentCap" in testCase
                                ? { contextTokens: testCase.agentCap }
                                : {}),
                              ...(resolvedModel !== undefined
                                ? {
                                    models: {
                                      [`anthropic/${resolvedModel}`]: {
                                        alias: "legacy-fast-model",
                                      },
                                    },
                                  }
                                : {}),
                            },
                          ],
                        }
                      : {}),
                  },
                }
              : {}),
          } as OpenClawConfig,
          { runtimeMode: "full" },
        ),
        agentId: targetAgentId,
        commandAuthorized: transportAuthorized,
        aliasIndex: {
          byKey: new Map(),
          byAlias: new Map(
            resolvedModel !== undefined
              ? [
                  [
                    "legacy-fast-model",
                    {
                      alias: "legacy-fast-model",
                      ref: { provider: "anthropic", model: resolvedModel },
                    },
                  ],
                ]
              : [],
          ),
        },
        typing: createTypingController(),
      });

      expect(result.handled).toBe(true);
      expect(handleCommandsMock.mock.calls[0]?.[0]).toMatchObject({
        provider: expectedProvider,
        model:
          resolvedModel !== undefined
            ? resolvedModel
            : expectedProvider === "anthropic"
              ? "claude-fable-5"
              : "gpt-5.5",
        contextTokens:
          "expectedContextTokens" in testCase
            ? testCase.expectedContextTokens
            : expectedProvider === "anthropic"
              ? 1_000_000
              : 200_000,
      });
    },
  );

  it.each([
    { selection: "user override", source: "user" as const },
    { selection: "automatic fallback", source: "auto" as const },
    { selection: "channel override", source: undefined },
  ])("preserves canonical native /status $selection", async (testCase) => {
    vi.spyOn(preparedModelCatalog, "loadPreparedModelCatalog").mockResolvedValueOnce([]);
    const targetSessionKey = "agent:main:main";
    const storePath = path.join(tempDirs.make("openclaw-native-status-"), "sessions.json");
    await replaceSessionEntry(
      { agentId: "main", sessionKey: targetSessionKey, storePath },
      {
        sessionId: "status-session",
        updatedAt: Date.now(),
        contextTokens: 1_000_000,
        ...(testCase.source
          ? {
              providerOverride: "anthropic",
              modelOverride: "claude-fable-5",
              modelOverrideSource: testCase.source,
              ...(testCase.source === "auto"
                ? {
                    modelOverrideFallbackOriginProvider: "openai",
                    modelOverrideFallbackOriginModel: "gpt-5.5",
                    modelProvider: "openai",
                    model: "gpt-5.5",
                  }
                : {}),
            }
          : {
              delivery: normalizeSessionDeliveryState({ context: { channel: "telegram" } }),
              groupId: "123",
            }),
      },
    );

    const result = await runTestNativeSlashFastReply({
      ctx: buildTestCtx({
        Body: "/status",
        CommandBody: "/status",
        CommandSource: "native",
        CommandAuthorized: true,
        SessionKey: "telegram:slash:123",
        CommandTargetSessionKey: targetSessionKey,
        CommandTurn: {
          kind: "native",
          source: "native",
          authorized: true,
          commandName: "status",
          body: "/status",
        },
      }),
      cfg: markCompleteReplyConfig({
        session: { store: storePath },
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.5" },
            modelPolicy: { allow: ["openai/*"] },
          },
        },
        channels: { modelByChannel: { telegram: { "123": "openai/gpt-5.5" } } },
      } as OpenClawConfig),
      agentId: "main",
      commandAuthorized: true,
      typing: createTypingController(),
    });

    const statusCall = buildStatusReplyMock.mock.calls[0]?.[0];
    expect(statusCall).toMatchObject({ provider: "openai", model: "gpt-5.5" });
    if (testCase.source) {
      expect(statusCall.sessionEntry).toMatchObject({
        providerOverride: "anthropic",
        modelOverride: "claude-fable-5",
        modelOverrideSource: testCase.source,
      });
    } else {
      expect(statusCall.sessionEntry).not.toHaveProperty("providerOverride");
      expect(statusCall.sessionEntry).not.toHaveProperty("modelOverride");
    }
    expect(result).toMatchObject({ reply: { text: "selected model status" } });
  });

  it("keeps model-independent /status plugins available under an invalid model policy", async () => {
    const { result } = await resolveNativeDirectiveCommand(
      "/status plugins",
      { agents: { defaults: { modelPolicy: { allow: ["anthropic/*"] } } } } as OpenClawConfig,
      { shouldContinue: false, reply: { text: "plugin status" } },
    );

    expect(result).toMatchObject({ handled: true, reply: { text: "plugin status" } });
    expect(handleCommandsMock).toHaveBeenCalledOnce();
  });

  it.each(["model", "models", "help", "stop"])(
    "keeps /%s available to recover from an invalid default model policy",
    async (commandName) => {
      const { result } = await resolveNativeDirectiveCommand(
        `/${commandName}`,
        {
          session: {
            store: path.join(tempDirs.make("openclaw-native-recovery-"), "sessions.json"),
          },
          agents: {
            defaults: {
              modelPolicy: { allow: ["anthropic/*"] },
            },
          },
        } as OpenClawConfig,
        { shouldContinue: false, reply: { text: "recovery available" } },
      );

      expect(result).toMatchObject({ handled: true, reply: { text: "recovery available" } });
      expect(handleCommandsMock).toHaveBeenCalledOnce();
    },
  );

  it("handles authorized text slash commands before model dispatch", async () => {
    handleCommandsMock.mockResolvedValueOnce({
      shouldContinue: false,
      reply: { text: "Trajectory exports can include prompts." },
    });

    const typing = createTypingController();
    const ctx = buildTestCtx({
      Body: "/export-trajectory bundle",
      BodyForCommands: "/export-trajectory bundle",
      CommandBody: "/export-trajectory bundle",
      CommandSource: "text",
      CommandAuthorized: true,
      SessionKey: "agent:dev:webchat",
      Provider: "webchat",
      Surface: "webchat",
      OriginatingChannel: "webchat",
      ChatType: "direct",
      CommandTurn: {
        kind: "text-slash",
        source: "text",
        authorized: true,
        commandName: "export-trajectory",
        body: "/export-trajectory bundle",
      },
    });

    const result = await runTestNativeSlashFastReply({
      ctx,
      cfg: markCompleteReplyConfig({
        session: {
          store: path.join(tempDirs.make("openclaw-text-slash-"), "sessions.json"),
        },
      } as OpenClawConfig),
      agentId: "dev",
      commandAuthorized: true,
      typing,
    });

    expect(handleCommandsMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      handled: true,
      reply: expect.objectContaining({
        text: "Trajectory exports can include prompts.",
      }),
    });
    if (!result.handled || !result.reply || Array.isArray(result.reply)) {
      throw new Error("expected single handled reply");
    }
    expect(getReplyPayloadMetadata(result.reply)?.deliverDespiteSourceReplySuppression).toBe(true);
    expect(typing.cleanup).toHaveBeenCalledTimes(1);
  });

  it("leaves external text slash commands on the canonical session path", async () => {
    const typing = createTypingController();
    const ctx = buildTestCtx({
      Body: "/export-trajectory bundle",
      BodyForCommands: "/export-trajectory bundle",
      CommandBody: "/export-trajectory bundle",
      CommandSource: "text",
      CommandAuthorized: true,
      SessionKey: "agent:dev:telegram:group:123",
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "group",
      CommandTurn: {
        kind: "text-slash",
        source: "text",
        authorized: true,
        commandName: "export-trajectory",
        body: "/export-trajectory bundle",
      },
    });

    const result = await runTestNativeSlashFastReply({
      ctx,
      cfg: markCompleteReplyConfig({
        session: {
          store: path.join(tempDirs.make("openclaw-external-text-slash-"), "sessions.json"),
        },
      } as OpenClawConfig),
      agentId: "dev",
      commandAuthorized: true,
      typing,
    });

    expect(result).toEqual({ handled: false });
    expect(handleCommandsMock).not.toHaveBeenCalled();
    expect(typing.cleanup).not.toHaveBeenCalled();
  });

  it.each([
    { commandName: "config show", authorized: false },
    { commandName: "compact", authorized: false },
    { commandName: "compact", authorized: true, deniedByPolicy: true },
  ])("rejects unauthorized native /$commandName before model selection", async (testCase) => {
    const { commandName, authorized } = testCase;
    const storePath = path.join(
      tempDirs.make("openclaw-native-slash-unauthorized-"),
      "sessions.json",
    );
    const sessionKey = "agent:main:telegram:slash:unauthorized";
    handleCommandsMock.mockResolvedValueOnce({
      shouldContinue: false,
      reply: { text: "You are not authorized to use this command." },
    });

    const result = await runTestNativeSlashFastReply({
      ctx: buildTestCtx({
        Body: `/${commandName}`,
        CommandBody: `/${commandName}`,
        CommandSource: "native",
        CommandAuthorized: authorized,
        Provider: "telegram",
        Surface: "telegram",
        From: "telegram:denied-sender",
        SenderId: "denied-sender",
        CommandTargetSessionKey: sessionKey,
        CommandTurn: {
          kind: "native",
          source: "native",
          authorized,
          commandName: commandName.split(" ", 1)[0] ?? "",
          body: `/${commandName}`,
        },
      }),
      cfg: markCompleteReplyConfig({
        session: { store: storePath },
        ...("deniedByPolicy" in testCase
          ? { commands: { allowFrom: { "*": ["approved-sender"] } } }
          : {}),
      } as OpenClawConfig),
      agentId: "main",
      commandAuthorized: authorized,
      typing: createTypingController(),
    });

    expect(result).toEqual({
      handled: true,
      reply: expect.objectContaining({ text: "You are not authorized to use this command." }),
    });
    expect(handleCommandsMock).toHaveBeenCalledOnce();
    expect(handleCommandsMock.mock.calls[0]?.[0]).toMatchObject({
      provider: "openai",
      model: "gpt-5.5",
      command: { isAuthorizedSender: false },
    });
    if (!authorized) {
      expect(loadExactSessionEntry({ sessionKey, storePath })).toBeUndefined();
    }
  });

  it.each([
    { failure: "was deleted", deliver: true },
    { failure: "changed", deliver: false },
  ])(
    "rejects session initialization when it $failure during persistence",
    async ({ failure, deliver }) => {
      vi.spyOn(sessionPersistence, "persistReplySessionEntry").mockResolvedValueOnce({
        status: "lifecycle-invalidated",
        error: `Session "agent:main:main" ${failure} while starting work. Retry.`,
      });
      const { result } = await resolveNativeDirectiveCommand("/compact");

      expect(result).toEqual({
        handled: true,
        reply: expect.objectContaining({ text: expect.stringContaining(failure) }),
      });
      if (deliver) {
        if (!result.handled || !result.reply || Array.isArray(result.reply)) {
          throw new Error("expected single handled reply");
        }
        expect(getReplyPayloadMetadata(result.reply)?.deliverDespiteSourceReplySuppression).toBe(
          true,
        );
      }
      expect(handleCommandsMock).not.toHaveBeenCalled();
    },
  );

  it("adopts a supported legacy alias before native command initialization", async () => {
    const storePath = path.join(tempDirs.make("openclaw-native-slash-alias-"), "sessions.json");
    const sessionKey = "agent:main:main";
    await replaceSessionEntry({ sessionKey: "Agent:main:main", storePath }, {
      sessionId: "legacy-session",
      updatedAt: 1,
    } as SessionEntry);
    handleCommandsMock.mockImplementationOnce(async (params: { sessionEntry?: unknown }) => {
      expect(params.sessionEntry).toMatchObject({ sessionId: "legacy-session" });
      return { shouldContinue: false, reply: { text: "ok" } };
    });

    const result = await runTestNativeSlashFastReply({
      ctx: buildTestCtx({
        Body: "/compact",
        CommandBody: "/compact",
        CommandSource: "native",
        CommandAuthorized: true,
        CommandTargetSessionKey: sessionKey,
        CommandTurn: {
          kind: "native",
          source: "native",
          authorized: true,
          commandName: "compact",
          body: "/compact",
        },
      }),
      cfg: markCompleteReplyConfig({ session: { store: storePath } } as OpenClawConfig),
      agentId: "main",
      commandAuthorized: true,
      typing: createTypingController(),
    });

    expect(result).toEqual({
      handled: true,
      reply: expect.objectContaining({ text: "ok" }),
    });
    expect(handleCommandsMock).toHaveBeenCalledOnce();
  });

  it("does not mutate an archived session during native command initialization", async () => {
    const storePath = path.join(tempDirs.make("openclaw-native-slash-archived-"), "sessions.json");
    const sessionKey = "agent:main:main";
    const archivedEntry = {
      sessionId: "archived-session",
      updatedAt: 1,
      lastInteractionAt: 1,
      archivedAt: 2,
      channel: "telegram",
    };
    await replaceSessionEntry({ sessionKey, storePath }, archivedEntry as SessionEntry);
    const persistedArchivedEntry = loadExactSessionEntry({ sessionKey, storePath })?.entry;

    const result = await runTestNativeSlashFastReply({
      ctx: buildTestCtx({
        Body: "/compact",
        CommandBody: "/compact",
        CommandSource: "native",
        CommandAuthorized: true,
        Provider: "telegram",
        CommandTargetSessionKey: sessionKey,
        CommandTurn: {
          kind: "native",
          source: "native",
          authorized: true,
          commandName: "compact",
          body: "/compact",
        },
      }),
      cfg: markCompleteReplyConfig({ session: { store: storePath } } as OpenClawConfig),
      agentId: "main",
      commandAuthorized: true,
      typing: createTypingController(),
    });

    expect(result).toEqual({
      handled: true,
      reply: expect.objectContaining({ text: expect.stringContaining("is archived") }),
    });
    expect(handleCommandsMock).not.toHaveBeenCalled();
    expect(loadExactSessionEntry({ sessionKey, storePath })?.entry).toEqual(persistedArchivedEntry);
  });

  it("persists fast-path session initialization before command mutation", async () => {
    const storePath = path.join(tempDirs.make("openclaw-native-slash-init-"), "sessions.json");
    const sessionKey = "agent:main:main";
    await replaceSessionEntry({ sessionKey, storePath }, {
      sessionId: "session-1",
      updatedAt: 1,
      lastInteractionAt: 1,
      channel: "old-channel",
    } as SessionEntry);
    handleCommandsMock.mockImplementationOnce(async (params: { sessionEntry?: unknown }) => {
      const persisted = loadSessionEntry({ sessionKey, storePath });
      expect(params.sessionEntry).toMatchObject({
        sessionId: "session-1",
        updatedAt: 100,
        lastInteractionAt: 100,
        channel: "telegram",
      });
      expect(persisted).toMatchObject(params.sessionEntry as object);
      return { shouldContinue: false, reply: { text: "ok" } };
    });
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(100);

    try {
      await runTestNativeSlashFastReply({
        ctx: buildTestCtx({
          Body: "/compact",
          CommandBody: "/compact",
          CommandSource: "native",
          CommandAuthorized: true,
          Provider: "telegram",
          CommandTargetSessionKey: sessionKey,
          CommandTurn: {
            kind: "native",
            source: "native",
            authorized: true,
            commandName: "compact",
            body: "/compact",
          },
        }),
        cfg: markCompleteReplyConfig({ session: { store: storePath } } as OpenClawConfig),
        agentId: "main",
        commandAuthorized: true,
        typing: createTypingController(),
      });
    } finally {
      nowSpy.mockRestore();
    }

    expect(handleCommandsMock).toHaveBeenCalledTimes(1);
  });
});
