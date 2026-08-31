import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAssistantMessageEventStream, type Model } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it } from "vitest";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createOpenClawReadTool,
  createSandboxedReadTool,
  wrapReadToolWithSkillContent,
} from "./agent-tools.read.js";
import {
  expectCodeModeSharedBudget,
  expectOriginalCodeModeMarker,
  fakeTool,
  resetCodeModeTestState,
  resultDetails,
} from "./code-mode.test-support.js";
import { submitEmbeddedAttemptPrompt } from "./embedded-agent-runner/run/attempt-prompt-submit.js";
import {
  clearEmbeddedSessionPromptStates,
  getEmbeddedSessionPromptState,
} from "./embedded-agent-runner/session-prompt-state.js";
import { installToolResultContextGuard } from "./embedded-agent-runner/tool-result-context-guard.js";
import { estimateToolResultTextChars } from "./embedded-agent-runner/tool-result-text-budget.js";
import { truncateOversizedToolResultsInMessages } from "./embedded-agent-runner/tool-result-truncation.js";
import { createAgentHarnessToolSurfaceRuntimeCore } from "./harness/tool-surface-bridge.js";
import { projectMcpCallToolResult } from "./mcp-content.js";
import { Agent, type AgentMessage, type AgentToolResult } from "./runtime/index.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";
import { SessionManager } from "./sessions/session-manager.js";
import { createReadTool } from "./sessions/tools/read.js";
import type { ReadToolContinuation } from "./sessions/tools/tool-contracts.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";
import { resolveLiveToolResultMaxChars } from "./tool-result-limits.js";

const sessionId = "result-budget-boundary";
const model = {
  id: "budget-fixture",
  name: "Budget fixture",
  provider: "test-provider",
  api: "openai-responses",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 1_000,
  compat: {},
} satisfies Model;

type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;

function message(
  result: AgentToolResult<unknown>,
  toolName: string,
  toolCallId = toolName,
): ToolResultMessage {
  return {
    ...result,
    role: "toolResult",
    toolName,
    toolCallId,
    isError: false,
    timestamp: 1,
  };
}

function text(result: { content: AgentToolResult<unknown>["content"] }): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function toolResult(messages: AgentMessage[], index: number): ToolResultMessage {
  const result = messages[index];
  if (result?.role !== "toolResult") {
    throw new Error("Expected a tool result at the model boundary");
  }
  return result;
}

async function dispatch(
  messages: AgentMessage[],
  contextWindowTokens = model.contextWindow,
): Promise<AgentMessage[]> {
  let sent: AgentMessage[] = [];
  const agent = new Agent({
    initialState: { model, messages },
    streamFn: (_model, context) => {
      sent = context.messages;
      return createAssistantMessageEventStream();
    },
  });
  const cleanup = installToolResultContextGuard({
    agent,
    contextWindowTokens,
  });
  const activeSession = {
    agent,
    get messages() {
      return agent.state.messages;
    },
  };
  const sessionPromptState = getEmbeddedSessionPromptState(sessionId);
  try {
    await submitEmbeddedAttemptPrompt({
      attempt: { sessionId },
      activeSession,
      contextTokenBudget: contextWindowTokens,
      images: [],
      modelPrompt: "",
      transcriptPrompt: "",
      systemPrompt: "",
      runtimeOnly: true,
      sessionPromptState,
      toolResultMaxChars: resolveLiveToolResultMaxChars({
        contextWindowTokens,
      }),
      toolResultAggregateMaxChars: 128_000,
      toolResultPromptProjectionState: sessionPromptState.toolResults,
      trajectoryRecorder: null,
      transcriptLeafId: null,
      onFinalPromptText: () => {},
      onSteeringAcknowledged: () => {},
      promptActiveSession: async () => {
        const context = await agent.transformContext!(messages, new AbortController().signal);
        await agent.streamFn(model, { messages: await agent.convertToLlm(context) });
      },
    });
    return sent;
  } finally {
    cleanup();
  }
}

afterEach(() => {
  resetCodeModeTestState();
  clearEmbeddedSessionPromptStates([sessionId]);
});

describe("fresh producer results through persistence and model guards", () => {
  it.each([
    { name: "default accented", first: "🦞".repeat(9000), last: "é".repeat(18000) },
    { name: "ASCII", first: "a".repeat(40_000), last: "b".repeat(40_000) },
    { name: "equal-byte Euro control", first: "🦞".repeat(9000), last: "€".repeat(12_000) },
    { name: "CJK", first: "中".repeat(9000), last: "界".repeat(9000) },
    { name: "JSON escaping", first: '\u0001"\\\n'.repeat(4000), last: '\t"\\'.repeat(4000) },
    {
      name: "large final value",
      first: "é".repeat(15_000),
      last: "",
      value: { text: "🦞".repeat(12_000) },
    },
    { name: "long failure", first: "x".repeat(35_000), last: "é".repeat(9000), fail: true },
    { name: "small byte cap", first: "🦞".repeat(140), last: "é".repeat(240), cap: 1024 },
    {
      name: "effective raw-weight context",
      first: "é".repeat(6000),
      last: "é".repeat(6000),
      context: 8000,
    },
    { name: "ordinary incremental", first: "first", last: "second" },
  ])(
    "keeps $name Code Mode output complete after yield and provider dispatch",
    async (scenario) => {
      const { first: firstText, last: lastText } = scenario;
      const cap = "cap" in scenario ? scenario.cap! : 65536;
      const context = "context" in scenario ? scenario.context! : model.contextWindow;
      const fail = "fail" in scenario && scenario.fail;
      const value = "value" in scenario ? scenario.value : true;
      const state = await createOpenClawTestState({ label: "code-mode-result-budget" });
      const runtime = createAgentHarnessToolSurfaceRuntimeCore({
        config: { tools: { codeMode: { enabled: true, maxOutputBytes: cap } } },
        model,
        contextTokenBudget: context,
        modelToolsEnabled: true,
        sessionId,
        executeTool: async () => {
          throw new Error("This fixture has no catalog tools");
        },
      });
      try {
        const tools = runtime.compactTools([]).tools;
        const first = message(
          await tools[0]!.execute("first", {
            code: `text(${JSON.stringify(firstText)}); await yield_control(); await yield_control(); ${lastText ? `text(${JSON.stringify(lastText)});` : ""} ${fail ? 'throw new Error("DIAGNOSTIC" + "é".repeat(40000));' : `return ${JSON.stringify(value)};`}`,
          }),
          "exec",
        );
        const firstSent = await dispatch([first], context);
        expect(JSON.parse(text(toolResult(firstSent, 0)))).toMatchObject({
          status: "waiting",
          runId: resultDetails(first).runId,
        });
        const empty = message(
          await tools[1]!.execute("empty", { runId: resultDetails(first).runId }),
          "wait",
          "empty",
        );
        expect(resultDetails(empty)).toMatchObject({ status: "waiting", output: [] });
        const final = message(
          await tools[1]!.execute("second", { runId: resultDetails(first).runId }),
          "wait",
        );
        const sent = await dispatch([first, empty, final], context);
        expect(text(toolResult(sent, 0))).toBe(text(toolResult(firstSent, 0)));
        const finalText = text(toolResult(sent, 2));
        expect(() => JSON.parse(finalText)).not.toThrow();
        expect(JSON.parse(finalText)).toMatchObject({ status: fail ? "failed" : "completed" });
        const original = [
          { type: "text", text: firstText },
          ...(lastText ? [{ type: "text", text: lastText }] : []),
        ];
        const details = resultDetails(final);
        const output = details.output as unknown[];
        if (scenario.name === "ordinary incremental") {
          expect(output).toEqual([original[1]]);
        } else if (output.length > 0) {
          expectOriginalCodeModeMarker(output[0], original);
        } else {
          expect(lastText).toBe("");
          expect(
            Buffer.byteLength(JSON.stringify(original)) +
              Buffer.byteLength(JSON.stringify(details.value)),
          ).toBeLessThanOrEqual(cap);
        }
        if (fail) {
          expect(details).toMatchObject({
            code: "internal_error",
            failurePhase: "bridge",
            bridgeDispatchStarted: true,
            error: expect.stringMatching(/^Error: DIAGNOSTIC.*\[error truncated\]$/s),
          });
        } else if (value === true) {
          expect(details.value).toBe(true);
        } else {
          expectOriginalCodeModeMarker(details.value, value);
        }

        const scope = {
          agentId: "main",
          sessionId,
          sessionKey: "agent:main:result-budget",
          storePath: join(state.sessionsDir(), "sessions.json"),
        };
        await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });
        const manager = SessionManager.open(scope, state.workspaceDir);
        const maxChars = resolveLiveToolResultMaxChars({ contextWindowTokens: context });
        installSessionToolResultGuard(manager, { maxToolResultChars: maxChars });
        for (const [index, frame] of [first, empty, final].entries()) {
          expect(
            text(toolResult(sent, index)) === text(frame),
            "fresh producer text must pass unchanged",
          ).toBe(true);
          expect(estimateToolResultTextChars(text(frame))).toBeLessThanOrEqual(maxChars);
          expect(
            estimateToolResultTextChars(text(frame), { minimumRawWeight: 2 }),
          ).toBeLessThanOrEqual(context);
          expectCodeModeSharedBudget(resultDetails(frame), cap);
          manager.appendMessage(frame);
        }
        manager.flushPendingPersistence();
        const reloaded = SessionManager.open(scope, state.workspaceDir).buildSessionContext()
          .messages;
        expect(text(toolResult(reloaded, 2))).toBe(finalText);
        expect(text(toolResult(await dispatch(reloaded, context), 2))).toBe(finalText);
      } finally {
        runtime.cleanup();
        await state.cleanup();
      }
    },
  );

  it.each([
    { name: "host ASCII", sandbox: false, source: "0123456789".repeat(12_000), context: 128_000 },
    { name: "sandbox Unicode", sandbox: true, source: "中é🦞".repeat(18_000), context: 128_000 },
    {
      name: "sandbox resolved filename",
      sandbox: true,
      source: "x".repeat(60_000),
      context: 128_000,
    },
    {
      name: "effective raw-weight context",
      sandbox: false,
      source: "é".repeat(16_000),
      context: 8000,
    },
  ])(
    "keeps the read owner's exact cursor through the downstream result guard: $name",
    async ({ name, sandbox, source, context }) => {
      const state = await createOpenClawTestState({ label: "read-result-budget" });
      try {
        const resolved = name === "sandbox resolved filename";
        const file = join(state.workspaceDir, resolved ? "notes 3.04 PM.txt" : "long-line.txt");
        await writeFile(resolved ? file.replace(" PM", "\u202fPM") : file, source);
        const read = sandbox
          ? createSandboxedReadTool({
              root: state.workspaceDir,
              bridge: createHostSandboxFsBridge(state.workspaceDir),
              modelContextWindowTokens: context,
            })
          : createOpenClawReadTool(createReadTool(state.workspaceDir), {
              modelContextWindowTokens: context,
              cwd: state.workspaceDir,
            });
        let collected = "";
        let continuation: ReadToolContinuation | undefined;
        for (let index = 0; index < 16; index++) {
          const page = message(
            await read.execute(`read-${index}`, { path: file, ...continuation }),
            "read",
            `read-${index}`,
          );
          const sent = toolResult(await dispatch([page], context), 0);
          expect(
            text(sent) === text(page),
            "no later clipping may discard already-advanced read bytes",
          ).toBe(true);
          continuation = resultDetails(page).continuation as ReadToolContinuation | undefined;
          const pageText = resolved ? text(sent).slice(text(sent).indexOf("\n") + 1) : text(sent);
          if (!continuation) {
            collected += pageText;
            break;
          }
          expect(continuation.kind).toBe("cursor");
          const chunk = pageText.slice(0, pageText.lastIndexOf("\n\n["));
          expect(chunk.length).toBeGreaterThan(0);
          collected += chunk;
          expect(text(sent)).toContain(`cursor=${collected.length}`);
          expect(collected).toBe(source.slice(0, collected.length));
        }
        expect(collected).toBe(source);
      } finally {
        await state.cleanup();
      }
    },
  );

  it.each([false, true])(
    "preserves wrapped network result structure and terminal batches (failed=%s)",
    async (fail) => {
      const network = fakeTool("network_fixture", "Read a network fixture");
      network.resultContentSource = "network";
      network.execute = async () => ({
        content: [{ type: "text", text: "received" }],
        details: "received",
        terminate: true,
      });
      const runtime = createAgentHarnessToolSurfaceRuntimeCore({
        config: { tools: { codeMode: true } },
        model,
        modelToolsEnabled: true,
        sessionId,
        executeTool: async ({ toolCallId, input }) => network.execute(toolCallId, input),
      });
      try {
        const [exec, wait] = runtime.compactTools([network]).tools;
        const first = await exec!.execute("network", {
          code: `await network_fixture({}); text('<s>'.repeat(20000)); await yield_control(); ${fail ? 'throw new Error("network diagnostic".repeat(5000));' : 'return "é".repeat(20000);'}`,
        });
        expect(first.terminate).not.toBe(true);
        const final = await wait!.execute("network-wait", { runId: resultDetails(first).runId });
        expect(final.terminate).toBe(true);
        for (const result of [first, final]) {
          const rendered = text(result);
          expect(rendered).toContain("SECURITY NOTICE");
          expect(rendered).not.toContain("\n[truncated]");
          const body = rendered
            .split("\n---\n")[1]
            ?.split("\n<<<END_EXTERNAL_UNTRUSTED_CONTENT")[0];
          expect(() => JSON.parse(body!)).not.toThrow();
          expect(body!.length).toBeLessThanOrEqual(20_000);
          expect(JSON.parse(body!)).toMatchObject({ status: resultDetails(result).status });
          expect(text(toolResult(await dispatch([message(result, "exec")]), 0))).toBe(rendered);
        }
      } finally {
        runtime.cleanup();
      }
    },
  );

  it("preserves conventional plain text and mixed MCP content without inferring JSON", async () => {
    const plain = message(
      {
        content: [{ type: "text", text: '{"unfinished": shell output' }],
        details: { kind: "text" },
      },
      "shell",
    );
    const mcp = message(
      projectMcpCallToolResult({
        structuredContent: { ok: false },
        isError: true,
        content: [
          { type: "text", text: "Retry with a narrower query." },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        ],
      }),
      "mcp",
    );
    const sent = await dispatch([plain, mcp]);
    expect(toolResult(sent, 0).content).toEqual(plain.content);
    expect(toolResult(sent, 1).content).toEqual(mcp.content);
    expect(text(mcp)).toContain("structuredContent:\n");
    expect(text(mcp)).toContain("Retry with a narrower query.");
  });

  it("allows explicitly lossy aggregate reduction and smaller-context replay", () => {
    const original = message(
      {
        content: [
          {
            type: "text",
            text: JSON.stringify({ status: "completed", value: "x".repeat(20_000) }),
          },
        ],
        details: {},
      },
      "exec",
    );
    const aggregate = truncateOversizedToolResultsInMessages(
      [original, { ...original, toolCallId: "second" }],
      128_000,
      32_000,
      32_000,
    );
    expect(aggregate.aggregateTruncatedCount).toBe(1);
    expect(text(toolResult(aggregate.messages, 0))).not.toBe(text(original));
    const smaller = truncateOversizedToolResultsInMessages([original], 8000);
    expect(() => JSON.parse(text(toolResult(smaller.messages, 0)))).toThrow();
    expect(() => JSON.parse(text(original))).not.toThrow();
  });

  it("refuses a whole skill that fits the byte cap but exceeds the model text budget", async () => {
    const locator = "node://fixture/skills/whole/SKILL.md";
    const base = fakeTool("read", "Read a file");
    const read = wrapReadToolWithSkillContent(
      base,
      [{ filePath: locator, readContent: "INSTRUCTIONS" + "中".repeat(9000) }],
      { modelContextWindowTokens: model.contextWindow },
    );
    const result = await read.execute("skill", { path: locator, offset: 2, limit: 1 });
    expect(text(result)).toContain("cannot be partially served");
    expect(text(result)).not.toContain("INSTRUCTIONS");
  });
});
