import type { MockFixture, MockFixturePlan } from "./mock-fixtures.js";

function fixture(
  id: string,
  match: MockFixture["match"],
  respond: MockFixture["respond"],
): MockFixture {
  return { id, match, respond };
}
// Ordered scenario fixtures for the QA Lab mock Responses provider.
import {
  buildAssistantText,
  isCanonicalCompactionRetryWriteResult,
  QA_COMPACTION_RETRY_FINAL_MARKER,
} from "./mock-openai-assistant-text.js";
import * as contract from "./mock-openai-contracts.js";
import { isHeartbeatPrompt, isQaToolSearchFixture } from "./mock-openai-directives.js";
import { buildQaLongFinalText, splitMockStreamingText } from "./mock-openai-events.js";
import {
  buildWhatsAppBatchedReply,
  buildWhatsAppBroadcastReply,
  buildWhatsAppGroupDispatchReply,
  buildWhatsAppPendingHistoryReply,
  extractAllRequestTexts,
  parseToolOutputJson,
} from "./mock-openai-input.js";
import {
  buildQaToolSearchArgs,
  extractToolSearchTarget,
  QA_TOOL_SEARCH_SECONDARY_TARGET,
  toolSearchOutputHasCandidate,
} from "./mock-openai-tooling.js";

const reply = (text: string): MockFixturePlan => ({ kind: "reply", text });
const tool = (name: string, args: Record<string, unknown>, raw = false): MockFixturePlan => ({
  kind: "tool",
  name,
  args,
  ...(raw ? { raw: true } : {}),
});
const stream = (
  id: string,
  text: string,
  streamText = text,
  phase: "commentary" | "final_answer" = "final_answer",
): MockFixturePlan => ({
  kind: "stream",
  message: { id, phase, streamDeltas: splitMockStreamingText(streamText), text },
});

function compactionRecoverySummary(allInputText: string) {
  const faultMarker =
    contract.QA_COMPACTION_EMPTY_OUTPUT_ONCE_MARKER_RE.exec(allInputText)?.[0] ??
    contract.QA_COMPACTION_REASONING_ONLY_OUTPUT_ONCE_MARKER_RE.exec(allInputText)?.[0];
  const recoveryMarker = faultMarker?.startsWith("QA-COMPACTION-EMPTY-")
    ? contract.QA_COMPACTION_EMPTY_RECOVERY_SUMMARY_MARKER
    : faultMarker
      ? contract.QA_COMPACTION_REASONING_RECOVERY_SUMMARY_MARKER
      : undefined;
  return recoveryMarker && faultMarker
    ? `${contract.QA_COMPACTION_OUTPUT_RECOVERY_SUMMARY}\n- ${recoveryMarker}\n- ${faultMarker}`
    : contract.QA_GENERIC_COMPACTION_SUMMARY;
}

export const MOCK_OPENAI_FIXTURES_CORE: readonly MockFixture[] = [
  fixture(
    "compaction-summary",
    (context) => context.requestKind === "compaction-summary",
    (context) => {
      if (context.compactionSummaryFaultMode === "empty-output-once") {
        return reply("");
      }
      if (context.compactionSummaryFaultMode === "reasoning-only-output-once") {
        return {
          kind: "reasoning",
          id: "reasoning_compaction_summary_fault",
          text: "Compaction summary reasoning completed without final summary text.",
        };
      }
      const durable = context.allInputText.includes(contract.QA_COMPACTION_RETRY_DURABLE_MARKER);
      return reply(
        durable
          ? contract.QA_COMPACTION_RETRY_SUMMARY
          : context.allInputText.includes(contract.QA_COMPACTION_RETRY_BULKY_MARKER) ||
              context.allInputText.includes(contract.QA_COMPACTION_RETRY_HISTORICAL_PHRASE)
            ? contract.QA_COMPACTION_RETRY_HISTORICAL_SUMMARY
            : compactionRecoverySummary(context.allInputText),
      );
    },
  ),
  fixture(
    "activate-compaction-retry",
    (context) =>
      contract.QA_COMPACTION_RETRY_PROMPT_RE.test(context.allInputText) ||
      /compaction-retry-summary\.txt/i.test(context.toolOutput),
    (context) => {
      context.scenarioState.compactionRetryActive = true;
      return undefined;
    },
  ),
  fixture(
    "code-mode-wait",
    (context) =>
      context.codeModeControlJson?.status === "waiting" && context.hasCurrentTool("wait"),
    (context) => {
      const control = context.codeModeControlJson;
      if (control?.status !== "waiting") {
        return undefined;
      }
      return "cellId" in control
        ? tool("wait", { cell_id: control.cellId }, true)
        : tool("wait", { runId: control.runId }, true);
    },
  ),
  fixture(
    "compaction-retry",
    (context) =>
      context.scenarioState.compactionRetryActive ||
      contract.QA_COMPACTION_RETRY_PROMPT_RE.test(context.allInputText) ||
      context.allInputText.includes(contract.QA_COMPACTION_RETRY_DURABLE_MARKER) ||
      context.allInputText.includes(contract.QA_COMPACTION_RETRY_BULKY_MARKER),
    (context) => {
      if (isCanonicalCompactionRetryWriteResult(context.toolOutput)) {
        return reply(QA_COMPACTION_RETRY_FINAL_MARKER);
      }
      return context.hasCompletedToolOutput
        ? reply("")
        : tool("write", {
            path: "compaction-retry-summary.txt",
            content: "Replay safety: unsafe after write.\n",
          });
    },
  ),
  fixture(
    "global-tool-loop-breaker",
    (context) => contract.QA_TOOL_LOOP_GLOBAL_BREAKER_PROMPT_RE.test(context.allInputText),
    (context) => {
      if (!context.hasCompletedToolOutput) {
        context.scenarioState.toolLoopReadAttempts = 0;
      }
      if (/do not repeat this exact tool action/i.test(context.toolOutput)) {
        return reply(context.exactReplyDirective ?? "GLOBAL-LOOP-BREAKER-OK");
      }
      context.scenarioState.toolLoopReadAttempts += 1;
      return context.scenarioState.toolLoopReadAttempts > 21
        ? reply("GLOBAL-LOOP-BREAKER-NOT-REACHED")
        : tool("read", { path: "LOOP_STEADY.txt" });
    },
  ),
  fixture(
    "tool-search",
    (context) =>
      contract.QA_TOOL_SEARCH_PROMPT_RE.test(context.allInputText) ||
      contract.QA_TOOL_SEARCH_FAILURE_PROMPT_RE.test(context.allInputText),
    (context) => {
      const targetTool = extractToolSearchTarget(context.allInputText);
      const args = targetTool
        ? buildQaToolSearchArgs(
            targetTool,
            contract.QA_TOOL_SEARCH_FAILURE_PROMPT_RE.test(context.allInputText),
          )
        : {};
      if (
        targetTool &&
        context.hasCompletedToolOutput &&
        context.completedToolName === "tool_search" &&
        !context.toolOutput.includes("FAKE_PLUGIN_OK") &&
        toolSearchOutputHasCandidate(parseToolOutputJson(context.toolOutput), targetTool) &&
        context.hasDeclaredTool("tool_call")
      ) {
        return tool("tool_call", { id: targetTool, args });
      }
      if (
        !context.hasCompletedToolOutput &&
        targetTool &&
        context.findCurrentTool(targetTool)?.type === "custom" &&
        typeof args.input === "string"
      ) {
        return tool(targetTool, args);
      }
      if (
        !context.hasCompletedToolOutput &&
        targetTool &&
        context.hasDeclaredTool("tool_search_code")
      ) {
        return tool("tool_search_code", {
          code: [
            `const hits = await openclaw.tools.search(${JSON.stringify(targetTool)}, { limit: 1 });`,
            `const match = hits.find((tool) => tool.name === ${JSON.stringify(targetTool)});`,
            "if (!match) throw new Error('target tool not found');",
            `return await openclaw.tools.call(match.id, ${JSON.stringify(args)});`,
          ].join("\n"),
        });
      }
      if (
        !context.hasCompletedToolOutput &&
        targetTool &&
        !context.hasDeclaredTool(targetTool) &&
        context.hasDeclaredTool("tool_search")
      ) {
        return tool("tool_search", {
          queries: [
            { query: targetTool, limit: 1 },
            { query: QA_TOOL_SEARCH_SECONDARY_TARGET, limit: 1 },
          ],
        });
      }
      return !context.hasCompletedToolOutput &&
        targetTool &&
        (context.hasDeclaredTool(targetTool) || isQaToolSearchFixture(context.allInputText))
        ? tool(targetTool, args)
        : undefined;
    },
  ),
  fixture(
    "restart-code-mode-wait",
    (context) => contract.QA_RESTART_CODE_MODE_WAIT_PROMPT_RE.test(context.allInputText),
    (context) => {
      if (contract.QA_RESTART_RECOVERY_PROMPT_RE.test(context.allInputText)) {
        if (context.toolOutput.includes("unsafe-probe-executed")) {
          return reply("RESTART-CODE-MODE-WAIT-FAIL");
        }
        return context.hasCurrentTool("qa_restart_unsafe_probe")
          ? tool("qa_restart_unsafe_probe", {})
          : reply(context.exactReplyDirective ?? "RESTART-CODE-MODE-WAIT-OK");
      }
      if (
        context.toolJson?.status === "completed" &&
        context.toolJson.value === "RESTART-CODE-MODE-WAIT-OK"
      ) {
        return reply(context.exactReplyDirective ?? "RESTART-CODE-MODE-WAIT-OK");
      }
      if (
        context.toolJson?.status === "waiting" &&
        typeof context.toolJson.runId === "string" &&
        context.hasDeclaredTool("wait")
      ) {
        return tool("wait", { runId: context.toolJson.runId });
      }
      return !context.hasCompletedToolOutput && context.hasDeclaredTool("exec")
        ? tool("exec", {
            language: "javascript",
            restartSafe: true,
            code: [
              'const matches = await tools.search("qa_restart_wait");',
              "await tools.call(matches[0].id, {});",
              'return "RESTART-CODE-MODE-WAIT-OK";',
            ].join("\n"),
          })
        : reply("RESTART-CODE-MODE-WAIT-FAIL");
    },
  ),
  fixture(
    "mcp-code-mode",
    (context) =>
      contract.QA_MCP_CODE_MODE_API_FILE_PROMPT_RE.test(context.allInputText) ||
      contract.QA_MCP_CODE_MODE_PROMPT_RE.test(context.allInputText),
    (context) => {
      if (!context.hasCompletedToolOutput && context.hasDeclaredTool("exec")) {
        const apiFiles = contract.QA_MCP_CODE_MODE_API_FILE_PROMPT_RE.test(context.allInputText);
        return tool("exec", {
          language: "javascript",
          code: apiFiles
            ? [
                'const files = await API.list("mcp");',
                'const root = await API.read("mcp/index.d.ts");',
                'const api = await API.read("mcp/fixture.d.ts");',
                'const result = await MCP.fixture.lookupNote({ id: "alpha" });',
                "return {",
                '  marker: "MCP_CODE_MODE_FILE_TOOL_RESULT",',
                "  files: files.files.map((file) => file.path),",
                "  rootHasFixture: root.content.includes('fixture'),",
                "  headerHasLookup: api.content.includes('function lookupNote'),",
                "  resultText: result.content?.[0]?.text,",
                "  allHasMcp: ALL_TOOLS.some((tool) => tool.source === 'mcp'),",
                "};",
              ].join("\n")
            : [
                "const rootApi = await MCP.$api();",
                'const api = await MCP.fixture.$api("lookupNote", { schema: true });',
                'const result = await MCP.fixture.lookupNote({ id: "alpha" });',
                "return {",
                '  marker: "MCP_CODE_MODE_TOOL_RESULT",',
                "  rootServers: rootApi.servers,",
                "  headerHasLookup: api.header.includes('function lookupNote'),",
                "  schemaKeys: Object.keys(api.schemas),",
                "  resultText: result.content?.[0]?.text,",
                "  allHasMcp: ALL_TOOLS.some((tool) => tool.source === 'mcp'),",
                "};",
              ].join("\n"),
        });
      }
      if (
        context.toolJson?.status === "waiting" &&
        typeof context.toolJson.runId === "string" &&
        context.hasDeclaredTool("wait")
      ) {
        return tool("wait", { runId: context.toolJson.runId });
      }
      if (context.toolOutput.includes("MCP_CODE_MODE_FILE_TOOL_RESULT")) {
        return reply(
          context.toolOutput.includes("fixture-note-alpha")
            ? "MCP_CODE_MODE_FILE_OK note=fixture-note-alpha unclear=none improvement=virtual-api-files-were-clear-and-needed-one-exec"
            : "MCP_CODE_MODE_FILE_FAIL unclear=code-mode-exec-did-not-return-fixture-note",
        );
      }
      return /MCP_CODE_MODE_TOOL_RESULT|fixture-note-alpha/.test(context.toolOutput)
        ? reply(
            "MCP_CODE_MODE_OK unclear=none improvement=virtual-header-files-would-avoid-the-first-api-call",
          )
        : undefined;
    },
  ),
  fixture(
    "direct-fallback-worker",
    (context) => contract.QA_SUBAGENT_DIRECT_FALLBACK_WORKER_RE.test(context.prompt),
    () => reply(contract.QA_SUBAGENT_DIRECT_FALLBACK_MARKER),
  ),
  fixture(
    "terminal-completion-event",
    (context) =>
      Boolean(context.terminalCompletionCase) &&
      contract.QA_SUBAGENT_INTERNAL_COMPLETION_RE.test(context.allInputText),
    (context) => {
      if (context.terminalCompletionCase !== "empty") {
        return reply("NO_REPLY");
      }
      if (context.completedToolName === "message") {
        return reply("");
      }
      if (context.hasCurrentTool("message") || context.hasCallableCodeMode) {
        const instructions = extractAllRequestTexts(
          context.input.filter((item) => item.role === "system" || item.role === "developer"),
          context.body,
        );
        const final =
          /visible source replies are not automatically delivered for this run\.[\s\S]*set `?final=true`?/i.test(
            instructions,
          );
        return tool("message", {
          action: "send",
          message: contract.QA_SUBAGENT_TERMINAL_MARKERS.empty,
          ...(final ? { final: true } : {}),
        });
      }
      return reply(contract.QA_SUBAGENT_TERMINAL_MARKERS.empty);
    },
  ),
  fixture(
    "terminal-worker",
    (context) => Boolean(context.terminalWorkerCase),
    async (context) => {
      const workerCase = context.terminalWorkerCase;
      if (!workerCase) {
        return undefined;
      }
      if (context.waitForTerminalRequesterSettled && context.childSessionKey) {
        await context.waitForTerminalRequesterSettled(workerCase, context.childSessionKey);
      }
      if (workerCase === "silent") {
        return reply("NO_REPLY");
      }
      if (workerCase === "empty") {
        return !context.hasCompletedToolOutput && context.hasDeclaredTool("write")
          ? tool("write", {
              path: "qa-terminal-empty-side-effect.txt",
              content: "empty terminal QA side effect completed\n",
            })
          : reply(
              [
                contract.INTERNAL_RUNTIME_CONTEXT_BEGIN,
                contract.QA_SUBAGENT_TERMINAL_METADATA_SENTINEL,
                contract.INTERNAL_RUNTIME_CONTEXT_END,
              ].join("\n"),
            );
      }
      if (workerCase === "fallback") {
        return reply(
          [
            contract.QA_SUBAGENT_TERMINAL_MARKERS.fallback,
            contract.INTERNAL_RUNTIME_CONTEXT_BEGIN,
            contract.QA_SUBAGENT_TERMINAL_METADATA_SENTINEL,
            contract.INTERNAL_RUNTIME_CONTEXT_END,
          ].join("\n"),
        );
      }
      return workerCase === "visible" || workerCase === "restart"
        ? reply(contract.QA_SUBAGENT_TERMINAL_MARKERS[workerCase])
        : undefined;
    },
  ),
  fixture(
    "terminal-requester",
    (context) => Boolean(context.terminalCompletionCase),
    (context) => {
      if (!context.hasCompletedToolOutput && context.canCallSessionsSpawn) {
        return tool("sessions_spawn", {
          task: `Subagent terminal reply QA worker: ${context.terminalCompletionCase}.`,
          label: `qa-terminal-${context.terminalCompletionCase}`,
          thread: false,
          mode: "run",
        });
      }
      return context.hasCompletedToolOutput ? reply("NO_REPLY") : undefined;
    },
  ),
  fixture(
    "direct-fallback-completed",
    (context) =>
      context.allInputText.includes(contract.QA_SUBAGENT_DIRECT_FALLBACK_MARKER) &&
      contract.QA_SUBAGENT_INTERNAL_COMPLETION_RE.test(context.allInputText),
    () => reply(""),
  ),
  fixture(
    "direct-fallback",
    (context) => contract.QA_SUBAGENT_DIRECT_FALLBACK_PROMPT_RE.test(context.allInputText),
    (context) => {
      if (!context.hasCompletedToolOutput && context.canCallSessionsSpawn) {
        return tool("sessions_spawn", {
          task: `Subagent direct fallback worker: finish with exactly ${contract.QA_SUBAGENT_DIRECT_FALLBACK_MARKER}.`,
          label: "qa-direct-fallback-worker",
          thread: false,
          mode: "run",
        });
      }
      return context.hasCompletedToolOutput &&
        context.canCallSessionsYield &&
        !/\byielded\b/i.test(context.toolOutput)
        ? tool("sessions_yield", {
            message: `Waiting for ${contract.QA_SUBAGENT_DIRECT_FALLBACK_MARKER}.`,
          })
        : undefined;
    },
  ),
  fixture(
    "remember-fact",
    (context) => contract.QA_REMEMBER_FACT_PROMPT_RE.test(context.prompt),
    (context) => reply(buildAssistantText(context.input, context.body)),
  ),
  fixture(
    "empty-response-side-effect-recovery",
    (context) =>
      contract.QA_EMPTY_RESPONSE_SIDE_EFFECT_RECOVERY_PROMPT_RE.test(context.prompt) ||
      (context.prompt.includes(contract.QA_SETTLED_TOOL_TERMINAL_CONTINUATION_NEEDLE) &&
        contract.QA_EMPTY_RESPONSE_SIDE_EFFECT_RECOVERY_PROMPT_RE.test(context.allInputText)),
    (context) => {
      if (context.allInputText.includes(contract.QA_SETTLED_TOOL_TERMINAL_CONTINUATION_NEEDLE)) {
        return reply(
          context.exactMarkerDirective ??
            context.exactReplyDirective ??
            "TELEGRAM-EMPTY-WRITE-RECOVERED-OK",
        );
      }
      return context.hasCompletedToolOutput
        ? reply("")
        : tool("write", {
            path: "qa-empty-response-side-effect.txt",
            content: "side effect completed once\n",
          });
    },
  ),
  fixture(
    "failed-tool-terminal-recovery",
    (context) =>
      contract.QA_FAILED_TOOL_TERMINAL_RECOVERY_PROMPT_RE.test(context.prompt) ||
      (context.prompt.includes(contract.QA_SETTLED_TOOL_TERMINAL_CONTINUATION_NEEDLE) &&
        contract.QA_FAILED_TOOL_TERMINAL_RECOVERY_PROMPT_RE.test(context.allInputText)),
    (context) => {
      if (context.allInputText.includes(contract.QA_SETTLED_TOOL_TERMINAL_CONTINUATION_NEEDLE)) {
        if (
          !context.allInputText.includes("state that failure plainly and do not claim it succeeded")
        ) {
          return reply("FAILED-TOOL-HONESTY-INSTRUCTION-MISSING");
        }
        const marker =
          context.exactMarkerDirective ??
          context.exactReplyDirective ??
          "QA-FAILED-TOOL-FINALIZED-OK";
        return reply(`The requested file could not be read: ENOENT. ${marker}`);
      }
      return context.hasCompletedToolOutput
        ? reply("FAILED-TOOL-TERMINAL-WAS-REPLAYED")
        : tool("read", { path: "qa-failed-terminal-missing-file.txt" });
    },
  ),
  fixture(
    "heartbeat",
    (context) => isHeartbeatPrompt(context.prompt),
    () => reply("HEARTBEAT_OK"),
  ),
  fixture(
    "fanout-worker-alpha",
    (context) => contract.QA_FANOUT_WORKER_ALPHA_PROMPT_RE.test(context.prompt),
    () => reply("ALPHA-OK"),
  ),
  fixture(
    "fanout-worker-beta",
    (context) => contract.QA_FANOUT_WORKER_BETA_PROMPT_RE.test(context.prompt),
    () => reply("BETA-OK"),
  ),
  fixture(
    "roundtrip-image",
    (context) =>
      contract.QA_ROUNDTRIP_IMAGE_INSPECTION_PROMPT_RE.test(context.currentImageRequest.text) &&
      context.currentImageRequest.imageInputCount > 0,
    () =>
      reply(
        "Protocol note: the generated attachment shows the same QA lighthouse scene from the previous step.",
      ),
  ),
  fixture(
    "image-understanding",
    (context) =>
      contract.QA_IMAGE_UNDERSTANDING_PROMPT_RE.test(context.currentImageRequest.text) &&
      context.currentImageRequest.imageInputCount > 0,
    () =>
      reply(
        "Protocol note: the attached image is split horizontally, with red on top and blue on the bottom.",
      ),
  ),
  fixture(
    "reasoning-only-recovery",
    (context) => contract.QA_REASONING_ONLY_RECOVERY_PROMPT_RE.test(context.allInputText),
    (context) => {
      if (!context.scenarioToolOutput) {
        return tool("read", { path: "QA_KICKOFF_TASK.md" });
      }
      return context.allInputText.includes(contract.QA_REASONING_ONLY_RETRY_NEEDLE)
        ? reply("REASONING-RECOVERED-OK")
        : {
            kind: "reasoning",
            id: "rs_mock_reasoning_recovery",
            text: "Need visible answer after reading the QA kickoff task.",
          };
    },
  ),
  fixture(
    "reasoning-only-side-effect",
    (context) => contract.QA_REASONING_ONLY_SIDE_EFFECT_PROMPT_RE.test(context.allInputText),
    (context) => {
      if (!context.scenarioToolOutput) {
        return tool("write", {
          path: "reasoning-only-side-effect.txt",
          content: "side effects already happened\n",
        });
      }
      return context.allInputText.includes(contract.QA_REASONING_ONLY_RETRY_NEEDLE)
        ? reply("BUG-SHOULD-NOT-AUTO-RETRY")
        : {
            kind: "reasoning",
            id: "rs_mock_reasoning_side_effect",
            text: "Need visible answer after the write, but the write already happened.",
          };
    },
  ),
  fixture(
    "thinking-visibility-max",
    (context) => contract.QA_THINKING_VISIBILITY_MAX_PROMPT_RE.test(context.prompt),
    () => ({
      kind: "reasoning-reply",
      reasoningId: "rs_mock_thinking_visibility_max",
      answerText: "THINKING-MAX-OK",
    }),
  ),
  fixture(
    "thinking-visibility-off",
    (context) => contract.QA_THINKING_VISIBILITY_OFF_PROMPT_RE.test(context.prompt),
    () => reply("THINKING-OFF-OK"),
  ),
  fixture(
    "empty-response-recovery",
    (context) => contract.QA_EMPTY_RESPONSE_RECOVERY_PROMPT_RE.test(context.allInputText),
    (context) =>
      !context.hasCompletedToolOutput
        ? tool("read", { path: "QA_KICKOFF_TASK.md" })
        : context.allInputText.includes(contract.QA_EMPTY_RESPONSE_RETRY_NEEDLE) ||
            context.allInputText.includes(contract.QA_SETTLED_TOOL_TERMINAL_CONTINUATION_NEEDLE)
          ? reply("EMPTY-RECOVERED-OK")
          : reply(""),
  ),
  fixture(
    "empty-response-exhaustion",
    (context) => contract.QA_EMPTY_RESPONSE_EXHAUSTION_PROMPT_RE.test(context.allInputText),
    (context) =>
      context.hasCompletedToolOutput ? reply("") : tool("read", { path: "QA_KICKOFF_TASK.md" }),
  ),
  fixture(
    "telegram-long-final-three-chunk",
    (context) => contract.QA_TELEGRAM_LONG_FINAL_THREE_CHUNK_PROMPT_RE.test(context.allInputText),
    () => {
      const text = buildQaLongFinalText({
        endMarker: "TELEGRAM-LONG-FINAL-3CHUNK-END",
        segmentCount: 96,
        startMarker: "TELEGRAM-LONG-FINAL-3CHUNK-BEGIN",
      });
      return stream("msg_mock_telegram_long_final_three_chunk", text);
    },
  ),
  fixture(
    "telegram-long-final",
    (context) => contract.QA_TELEGRAM_LONG_FINAL_PROMPT_RE.test(context.allInputText),
    () => {
      const text = buildQaLongFinalText();
      return stream("msg_mock_telegram_long_final", text);
    },
  ),
  fixture(
    "whatsapp-long-final",
    (context) => contract.QA_WHATSAPP_LONG_FINAL_PROMPT_RE.test(context.allInputText),
    () => {
      const text = buildQaLongFinalText({
        endMarker: "WHATSAPP-LONG-FINAL-END",
        segmentPrefix: "whatsapp-long-final-segment",
        segmentCount: 64,
        startMarker: "WHATSAPP-LONG-FINAL-BEGIN",
      });
      return stream("msg_mock_whatsapp_long_final", text);
    },
  ),
  fixture(
    "whatsapp-pending-history",
    (context) => Boolean(buildWhatsAppPendingHistoryReply(context.prompt, context.input)),
    (context) => reply(buildWhatsAppPendingHistoryReply(context.prompt, context.input) ?? ""),
  ),
  fixture(
    "whatsapp-broadcast",
    (context) => Boolean(buildWhatsAppBroadcastReply(context.allInputText)),
    (context) => reply(buildWhatsAppBroadcastReply(context.allInputText) ?? ""),
  ),
  fixture(
    "whatsapp-group-dispatch",
    (context) => Boolean(buildWhatsAppGroupDispatchReply(context.allInputText)),
    (context) => reply(buildWhatsAppGroupDispatchReply(context.allInputText) ?? ""),
  ),
  fixture(
    "whatsapp-batched",
    (context) => Boolean(buildWhatsAppBatchedReply(context.allInputText)),
    (context) => reply(buildWhatsAppBatchedReply(context.allInputText) ?? ""),
  ),
] as const;
