import path from "node:path";
import type { AssistantMessage, Model } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  appendTranscriptMessages,
  appendTranscriptMessageSync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import { resetDiagnosticEventsForTest } from "../../infra/diagnostic-events.js";
import { createDiagnosticTraceContext } from "../../infra/diagnostic-trace-context.js";
import { resetDiagnosticRunActivityForTest } from "../../logging/diagnostic-run-activity.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../../logging/secret-redaction-registry.test-support.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-helpers.js";
import { createNestedToolActivity } from "../../sessions/nested-tool-activity.js";
import { closeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db.js";
import { toToolDefinitions } from "../agent-tool-definition-adapter.js";
import { isCodeModeExecTool } from "../code-mode-control-tools.js";
import { createCodeModeHarness, resetCodeModeTestState } from "../code-mode.test-support.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "../embedded-agent-runner/run/attempt.model-diagnostic-events.js";
import type { AgentMessage } from "../runtime/index.js";
import { guardSessionManager } from "../session-tool-result-guard-wrapper.js";
import { registerHeadlessToolSearchCatalog } from "../tool-search.js";
import { wrapStreamFnCodeModeSource } from "../transcript-code-mode-source.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "./agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import type { MessageEndEvent, ToolDefinition } from "./extensions/types.js";
import { SessionManager } from "./session-manager.js";

registerAgentSessionLoopTestLifecycle();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  resetDiagnosticEventsForTest();
  resetDiagnosticRunActivityForTest();
  resetGlobalHookRunner();
  resetSecretRedactionRegistryForTest();
});

describe("AgentSession runtime and transcript projections", () => {
  const source =
    "function computeToken() { return 42; }\nconst API_TOKEN = computeToken(); return API_TOKEN;";
  const genericLiteral = "fixture-only-not-a-real-secret";
  const registeredLiteral = "fixture-registered-source-value";
  const vendorLiteral = "sk-fixturesyntheticcredential1234567890";
  const customLiteral = "fixture-custom-source-value";
  const maskedSource = `const API_TOKEN = "${genericLiteral}"; const vendor = "${vendorLiteral}"; const registered = "${registeredLiteral}"; const custom = "${customLiteral}";\n${source.replaceAll("API_TOKEN", "OTHER_TOKEN")}`;
  const sourceCases = [
    { label: "JavaScript code", args: { code: source }, outcome: "completed" },
    {
      label: "explicit JavaScript",
      args: { code: source, language: "javascript" },
      outcome: "completed",
    },
    {
      label: "boolean state",
      args: { code: "const HAS_API_TOKEN = false; return HAS_API_TOKEN ? 0 : 42;" },
      outcome: "completed",
    },
    {
      label: "null state",
      args: { code: "let API_TOKEN = null; return API_TOKEN ?? 42;" },
      outcome: "completed",
    },
    ...["bash", "", null, 7].map((language) => ({
      label: `invalid language ${JSON.stringify(language)}`,
      args: { code: "API_TOKEN=fixtureUnquotedLiteral;", language },
      outcome: "validation",
    })),
    {
      label: "TypeScript annotation",
      args: { code: source.replace("API_TOKEN =", "API_TOKEN: number ="), language: "typescript" },
      outcome: "completed",
    },
    {
      label: "computed expression",
      args: { code: "const API_TOKEN = (40 + 2); return API_TOKEN;" },
      outcome: "completed",
    },
    {
      label: "ordinary total",
      args: { code: "const total = 40 + 2; return total;" },
      outcome: "completed",
    },
    { label: "command only", args: { command: source }, outcome: "validation" },
    { label: "paired aliases", args: { code: source, command: source }, outcome: "completed" },
    { label: "blank code alternate", args: { code: "", command: source }, outcome: "completed" },
    {
      label: "blank command alternate",
      args: { code: source, command: " " },
      outcome: "completed",
    },
    {
      label: "divergent aliases",
      args: { code: source, command: "const API_TOKEN = computeOtherToken(); return API_TOKEN;" },
      outcome: "error",
    },
    { label: "both blank", args: { code: " ", command: "" }, outcome: "error" },
    { label: "credential masking", args: { code: maskedSource }, outcome: "completed" },
  ];

  it.each(sourceCases)(
    "preserves $label through SQLite close, reopen, and the next provider context",
    async ({ args, outcome, label }) => {
      const dir = tempDirs.make("openclaw-code-source-projection-");
      const scope = {
        agentId: "main",
        sessionId: "source-projection",
        sessionKey: "agent:main:source-projection",
        storePath: path.join(dir, "sessions.json"),
      };
      const config = { logging: { redactPatterns: ["fixture-custom-source-value"] } };
      registerSecretValueForRedaction(registeredLiteral);
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const manager = SessionManager.open(scope, dir);
      guardSessionManager(manager, { config, allowedToolNames: ["exec", "wait"] });
      const originalArgs = {
        ...args,
        note: source,
        nested: { code: source, command: source },
        apiKey: "fixture-structured-secret",
      };
      const { tools, catalogRef } = createCodeModeHarness();
      registerHeadlessToolSearchCatalog({ catalogRef, tools: [] });
      streamMocks.streamSimple
        .mockImplementationOnce((model: Model) =>
          createAssistantResultStream(
            createAssistant(
              model,
              [
                { type: "text", text: source },
                { type: "toolCall", id: "call_source", name: "exec", arguments: originalArgs },
              ],
              "toolUse",
            ),
          ),
        )
        .mockImplementation((model: Model) =>
          createAssistantResultStream(createAssistant(model, [{ type: "text", text: "Done." }])),
        );
      try {
        if (label === "command only") {
          expect(await tools[0]!.execute("direct_alias", { command: source })).toMatchObject({
            details: { status: "completed", value: 42 },
          });
        }
        const { session } = await createTestSession({
          sessionManager: manager,
          customTools: toToolDefinitions(tools),
        });
        const model = session.agent.state.model!;
        let modelCallSeq = 0;
        session.agent.streamFn = wrapStreamFnCodeModeSource(
          wrapStreamFnWithDiagnosticModelCallEvents(session.agent.streamFn!, {
            runId: scope.sessionId,
            provider: model.provider,
            model: model.id,
            trace: createDiagnosticTraceContext(),
            nextCallId: () => `${scope.sessionId}:${++modelCallSeq}`,
          }),
          new Set(tools.filter(isCodeModeExecTool).map((tool) => tool.name)),
        );
        await session.prompt("Compute the harmless number.");
        expect(streamMocks.streamSimple).toHaveBeenCalledTimes(2);
        const liveResult = session.state.messages.find((message) => message.role === "toolResult");
        expect(liveResult).toMatchObject({ toolCallId: "call_source" });
        if (outcome === "validation") {
          expect(liveResult).toMatchObject({
            isError: true,
            content: [
              {
                text: expect.stringContaining(
                  label.startsWith("invalid language") ? "language" : "code",
                ),
              },
            ],
          });
        } else {
          expect(liveResult).toMatchObject({
            details: { status: outcome, ...(outcome === "completed" ? { value: 42 } : {}) },
          });
        }
        expect(
          session.state.messages.find((message) => message.role === "assistant"),
        ).toMatchObject({ content: [{ text: source }, { arguments: originalArgs }] });
        const cached = manager.buildSessionContext();
        session.dispose();
        const databasePath = resolveSqliteTargetFromSessionStorePath(scope.storePath).path!;
        expect(closeOpenClawAgentDatabaseByPath(databasePath)).toBe(true);
        const reopened = SessionManager.open(scope, dir);
        expect(reopened.buildSessionContext()).toEqual(cached);
        const { session: nextSession } = await createTestSession({
          sessionManager: reopened,
          customTools: toToolDefinitions(tools),
        });
        await nextSession.prompt("Recall the earlier calculation.");
        const providerContext = streamMocks.streamSimple.mock.calls.at(-1)![1];
        const assistant = providerContext.messages.find(
          (message: { role: string }) => message.role === "assistant",
        );
        expect(assistant).toMatchObject({
          content: [
            { text: expect.not.stringContaining("API_TOKEN = computeToken()") },
            {
              type: "toolCall",
              id: "call_source",
              name: "exec",
              arguments: {
                apiKey: expect.not.stringContaining("fixture-structured-secret"),
                note: expect.not.stringContaining("API_TOKEN = computeToken()"),
                nested: {
                  code: expect.not.stringContaining("API_TOKEN = computeToken()"),
                  command: expect.not.stringContaining("API_TOKEN = computeToken()"),
                },
              },
            },
          ],
        });
        const persistedArgs = assistant.content[1].arguments;
        for (const field of ["code", "command"] as const) {
          const value = field === "code" ? args.code : "command" in args ? args.command : undefined;
          if (typeof value !== "string") {
            expect(persistedArgs).not.toHaveProperty(field);
            continue;
          }
          if (label.startsWith("invalid language")) {
            expect(persistedArgs[field]).not.toContain("fixtureUnquotedLiteral");
          } else if (label === "credential masking") {
            expect(persistedArgs[field]).toContain(
              "OTHER_TOKEN = computeToken(); return OTHER_TOKEN;",
            );
            for (const literal of [
              genericLiteral,
              registeredLiteral,
              vendorLiteral,
              customLiteral,
            ]) {
              expect(persistedArgs[field]).not.toContain(literal);
            }
          } else {
            expect(persistedArgs[field]).toBe(value);
          }
        }
        const replayResult = providerContext.messages.find(
          (message: { role: string }) => message.role === "toolResult",
        );
        expect(replayResult.toolCallId).toBe(assistant.content[1].id);
        expect(providerContext.messages.indexOf(replayResult)).toBe(
          providerContext.messages.indexOf(assistant) + 1,
        );
      } finally {
        resetCodeModeTestState();
      }
    },
  );

  it.each(["message_end", "before_message_write"] as const)(
    "revalidates source ownership after %s replacements",
    async (hook) => {
      const dir = tempDirs.make("openclaw-source-hooks-");
      const scope = {
        agentId: "main",
        sessionId: "source-hooks",
        sessionKey: "agent:main:source-hooks",
        storePath: path.join(dir, "sessions.json"),
      };
      const { tools, catalogRef } = createCodeModeHarness();
      registerHeadlessToolSearchCatalog({ catalogRef, tools: [] });
      const other: ToolDefinition = {
        name: "other",
        label: "Other",
        description: "Ordinary JSON tool",
        parameters: Type.Object({ code: Type.String() }),
        execute: async () => ({ content: [{ type: "text", text: "ordinary" }], details: {} }),
      };
      const cases = [
        "unchanged",
        "clone",
        "mutate-source",
        "default-to-javascript",
        "javascript-to-default",
        "change-dialect",
        "unsupported-dialect",
        "malformed-dialect",
        "rename",
        "remove",
        "collision",
        "replace-with-literal",
      ] as const;
      let action: (typeof cases)[number] = "unchanged";
      let original: AssistantMessage | undefined;
      const replace = (message: AgentMessage): AgentMessage => {
        if (message.role !== "assistant" || message.stopReason !== "toolUse") {
          return message;
        }
        const call = message.content.find((block) => block.type === "toolCall")!;
        if (call.type !== "toolCall") {
          throw new Error("missing call");
        }
        if (!call.id.startsWith("hook_")) {
          return message;
        }
        switch (action) {
          case "clone":
            return { ...message, content: [{ ...call }] };
          case "mutate-source":
            call.arguments.code = source.replaceAll("42", "43");
            return message;
          case "default-to-javascript":
            call.arguments.language = "javascript";
            return message;
          case "javascript-to-default":
            delete call.arguments.language;
            return message;
          case "change-dialect":
            call.arguments.language = "typescript";
            return message;
          case "unsupported-dialect":
            call.arguments.language = "bash";
            return message;
          case "malformed-dialect":
            call.arguments.language = null;
            return message;
          case "rename":
            call.name = "other";
            return message;
          case "remove":
            return { ...message, content: [{ type: "text", text: "Removed call." }] };
          case "collision":
            return { ...message, content: [call, { ...call }] };
          case "replace-with-literal":
            return { ...message, content: [{ ...call, arguments: { code: maskedSource } }] };
          default:
            return { ...message, content: [{ type: "text", text: "Hook preserved call." }, call] };
        }
      };
      const resourceLoader =
        hook === "message_end"
          ? createResourceLoader(
              new Map([
                [
                  "message_end",
                  [
                    async (event: unknown) => ({
                      message: replace((event as MessageEndEvent).message),
                    }),
                  ],
                ],
              ]),
            )
          : createResourceLoader();
      if (hook === "before_message_write") {
        initializeGlobalHookRunner(
          createMockPluginRegistry([
            {
              hookName: hook,
              handler: (event: unknown) => ({
                message: replace((event as { message: AgentMessage }).message),
              }),
            },
          ]),
        );
      }
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const manager = SessionManager.open(scope, dir);
      guardSessionManager(manager, { config: {}, allowedToolNames: ["exec", "wait", "other"] });
      const { session } = await createTestSession({
        sessionManager: manager,
        customTools: [...toToolDefinitions(tools), other],
        resourceLoader,
      });
      session.agent.streamFn = wrapStreamFnCodeModeSource(
        session.agent.streamFn!,
        new Set(tools.filter(isCodeModeExecTool).map((tool) => tool.name)),
      );
      try {
        for (const nextAction of cases) {
          action = nextAction;
          streamMocks.streamSimple
            .mockImplementationOnce((model: Model) => {
              original = createAssistant(
                model,
                [
                  {
                    type: "toolCall",
                    id: `hook_${action}`,
                    name: "exec",
                    arguments: {
                      code: source,
                      ...(action === "javascript-to-default" ? { language: "javascript" } : {}),
                    },
                  },
                ],
                "toolUse",
              );
              return createAssistantResultStream(original);
            })
            .mockImplementation((model: Model) =>
              createAssistantResultStream(
                createAssistant(model, [{ type: "text", text: "Done." }]),
              ),
            );
          await session.prompt(`Test ${action}.`);
          const stored = manager
            .buildSessionContext()
            .messages.flatMap((message) =>
              message.role === "assistant"
                ? message.content.filter(
                    (block) => block.type === "toolCall" && block.id === `hook_${action}`,
                  )
                : [],
            );
          if (action === "remove") {
            expect(stored).toHaveLength(0);
            continue;
          }
          expect(stored.length).toBeGreaterThan(0);
          for (const block of stored) {
            if (block.type !== "toolCall") {
              throw new Error("unexpected stored block");
            }
            if (
              action === "unchanged" ||
              action === "default-to-javascript" ||
              action === "javascript-to-default"
            ) {
              expect(block.arguments.code).toBe(source);
            } else {
              expect(block.arguments.code).not.toContain("API_TOKEN = computeToken()");
            }
            expect(block.arguments.code).not.toContain(genericLiteral);
          }
          // Retaining or copying a completed response cannot reuse its append authority.
          const late = structuredClone(original!);
          late.content = [
            { type: "toolCall", id: `late_${action}`, name: "exec", arguments: { code: source } },
          ];
          manager.appendMessage(late);
          guardSessionManager(manager).clearPendingToolResults?.();
          const lateStored = manager.getLeafEntry();
          expect(lateStored).toMatchObject({
            message: {
              content: [
                { arguments: { code: expect.not.stringContaining("API_TOKEN = computeToken()") } },
              ],
            },
          });
        }
        const cached = manager.buildSessionContext();
        session.dispose();
        expect(
          closeOpenClawAgentDatabaseByPath(
            resolveSqliteTargetFromSessionStorePath(scope.storePath).path!,
          ),
        ).toBe(true);
        expect(SessionManager.open(scope, dir).buildSessionContext()).toEqual(cached);
      } finally {
        resetCodeModeTestState();
        resetGlobalHookRunner();
      }
    },
  );

  it("keeps mixed outer calls separate from a reentrant direct SQLite append", async () => {
    const dir = tempDirs.make("openclaw-source-mixed-");
    const scope = {
      agentId: "main",
      sessionId: "source-mixed",
      sessionKey: "agent:main:source-mixed",
      storePath: path.join(dir, "sessions.json"),
    };
    const { tools, catalogRef } = createCodeModeHarness();
    registerHeadlessToolSearchCatalog({ catalogRef, tools: [] });
    let reentrant: ReturnType<typeof appendTranscriptMessageSync<AgentMessage>>;
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: (event: unknown) => {
            const { message } = event as { message: AgentMessage };
            if (message.role === "assistant" && message.stopReason === "toolUse" && !reentrant) {
              // Even the exact live object cannot borrow its outer append's private options.
              reentrant = appendTranscriptMessageSync(scope, {
                message,
                eventId: "reentrant_source",
              });
            }
          },
        },
      ]),
    );
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const manager = SessionManager.open(scope, dir);
    guardSessionManager(manager, { config: {}, allowedToolNames: ["exec", "wait", "other"] });
    const otherParameters = Type.Object({ code: Type.String() });
    const other: ToolDefinition<typeof otherParameters> = {
      name: "other",
      label: "Other",
      description: "Ordinary tool",
      parameters: otherParameters,
      execute: async (_id, args) => ({
        content: [{ type: "text", text: "ordinary" }],
        details: { receivedOriginal: args.code === source },
      }),
    };
    streamMocks.streamSimple
      .mockImplementationOnce((model: Model) =>
        createAssistantResultStream(
          createAssistant(
            model,
            [
              { type: "toolCall", id: "mixed_rejected", name: "unavailable", arguments: {} },
              { type: "toolCall", id: "mixed_code", name: "exec", arguments: { code: source } },
              { type: "toolCall", id: "mixed_other", name: "other", arguments: { code: source } },
            ],
            "toolUse",
          ),
        ),
      )
      .mockImplementation((model: Model) =>
        createAssistantResultStream(createAssistant(model, [{ type: "text", text: "Done." }])),
      );
    try {
      const { session } = await createTestSession({
        sessionManager: manager,
        customTools: [...toToolDefinitions(tools), other],
      });
      session.agent.streamFn = wrapStreamFnCodeModeSource(
        session.agent.streamFn!,
        new Set(tools.filter(isCodeModeExecTool).map((tool) => tool.name)),
      );
      await session.prompt("Run both independent calls.");
      expect(streamMocks.streamSimple).toHaveBeenCalledTimes(2);
      expect(
        session.state.messages.filter((message) => message.role === "toolResult"),
      ).toMatchObject([
        { toolCallId: "mixed_rejected", isError: true },
        { toolCallId: "mixed_code", details: { value: 42 } },
        { toolCallId: "mixed_other", details: { receivedOriginal: true } },
      ]);
      expect(reentrant).toMatchObject({
        message: {
          content: [
            { arguments: { code: expect.not.stringContaining("API_TOKEN = computeToken()") } },
            { arguments: { code: expect.not.stringContaining("API_TOKEN = computeToken()") } },
          ],
        },
      });
      const stored = manager
        .getEntries()
        .filter(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "assistant" &&
            entry.message.stopReason === "toolUse",
        );
      expect(stored).toHaveLength(2);
      expect(stored[1]).toMatchObject({
        message: {
          content: [
            { id: "mixed_code", arguments: { code: source } },
            {
              id: "mixed_other",
              arguments: { code: expect.not.stringContaining("API_TOKEN = computeToken()") },
            },
          ],
        },
      });
      const cached = manager.buildSessionContext();
      session.dispose();
      expect(
        closeOpenClawAgentDatabaseByPath(
          resolveSqliteTargetFromSessionStorePath(scope.storePath).path!,
        ),
      ).toBe(true);
      expect(SessionManager.open(scope, dir).buildSessionContext()).toEqual(cached);
    } finally {
      resetGlobalHookRunner();
      resetCodeModeTestState();
    }
  });

  it("does not lend a previous run's source ownership to a reused manager or ordinary append batches", async () => {
    const dir = tempDirs.make("openclaw-source-reuse-");
    const scope = {
      agentId: "main",
      sessionId: "source-reuse",
      sessionKey: "agent:main:source-reuse",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const manager = SessionManager.open(scope, dir);
    const { tools, catalogRef } = createCodeModeHarness();
    registerHeadlessToolSearchCatalog({ catalogRef, tools: [] });
    const shell: ToolDefinition = {
      name: "exec",
      label: "Shell",
      description: "Ordinary shell owner",
      parameters: Type.Object({ command: Type.String() }),
      execute: async () => ({ content: [{ type: "text", text: source }], details: {} }),
    };
    try {
      for (const mode of ["code", "shell", "code"] as const) {
        guardSessionManager(manager, {
          config: {},
          allowedToolNames: ["exec", "wait"],
          runId: mode,
        });
        streamMocks.streamSimple
          .mockImplementationOnce((model: Model) =>
            createAssistantResultStream(
              createAssistant(
                model,
                [
                  {
                    type: "toolCall",
                    id: "reused_id",
                    name: "exec",
                    arguments: mode === "code" ? { code: source } : { command: source },
                  },
                ],
                "toolUse",
              ),
            ),
          )
          .mockImplementation((model: Model) =>
            createAssistantResultStream(createAssistant(model, [{ type: "text", text: "Done." }])),
          );
        const { session } = await createTestSession({
          sessionManager: manager,
          customTools: mode === "code" ? toToolDefinitions(tools) : [shell],
        });
        session.agent.streamFn = wrapStreamFnCodeModeSource(
          session.agent.streamFn!,
          new Set(mode === "code" ? tools.filter(isCodeModeExecTool).map((tool) => tool.name) : []),
        );
        await session.prompt(`Use ${mode} mode.`);
        const latestCall = manager
          .buildSessionContext()
          .messages.flatMap((message) =>
            message.role === "assistant"
              ? message.content.filter((block) => block.type === "toolCall")
              : [],
          )
          .at(-1)!;
        if (latestCall.type !== "toolCall") {
          throw new Error("missing latest call");
        }
        if (mode === "code") {
          expect(latestCall.arguments.code).toBe(source);
        } else {
          expect(latestCall.arguments.command).not.toContain("API_TOKEN = computeToken()");
        }
        session.dispose();
      }
      const nested = [
        createNestedToolActivity({
          runId: "run-test",
          scopeId: "scope-test",
          afterEntryId: null,
          startOrder: 0,
          toolCallId: "nested_shell",
          toolName: "exec",
          parentToolCallId: "reused_id",
          input: {
            command: source,
            code: source,
            nested: { code: source },
            toolKind: "code_mode_exec",
          },
          result: { content: [{ type: "text", text: source }], details: {} },
          isError: false,
          startedAt: 1,
          timestamp: 2,
        }),
      ];
      const messages = nested.map((message, index) => ({
        message: { ...message, idempotencyKey: `batch_${index}` },
        eventId: `batch_${index}`,
      }));
      const first = await appendTranscriptMessages(scope, { messages });
      const repeated = await appendTranscriptMessages(scope, { messages });
      expect(first.every((result) => result.appended)).toBe(true);
      expect(repeated.every((result) => !result.appended)).toBe(true);
      expect(repeated.map((result) => result.messageId)).toEqual(
        first.map((result) => result.messageId),
      );
      expect(
        closeOpenClawAgentDatabaseByPath(
          resolveSqliteTargetFromSessionStorePath(scope.storePath).path!,
        ),
      ).toBe(true);
      const replay = SessionManager.open(scope, dir).buildSessionContext().messages;
      expect(replay.some((message) => message.role === "custom")).toBe(false);
      const storedActivity = SessionManager.open(scope, dir).getBranch().at(-1);
      expect(storedActivity).toMatchObject({
        message: {
          details: {
            toolCallId: "nested_shell",
            parentToolCallId: "reused_id",
            input: {
              command: expect.not.stringContaining("API_TOKEN = computeToken()"),
              code: expect.not.stringContaining("API_TOKEN = computeToken()"),
              nested: { code: expect.not.stringContaining("API_TOKEN = computeToken()") },
            },
            result: {
              content: [{ text: expect.not.stringContaining("API_TOKEN = computeToken()") }],
            },
          },
        },
      });
    } finally {
      resetCodeModeTestState();
    }
  });
});
