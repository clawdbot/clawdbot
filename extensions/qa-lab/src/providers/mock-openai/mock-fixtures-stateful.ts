// Ordered scenario fixtures for the QA Lab mock Responses provider.
import { setTimeout as sleep } from "node:timers/promises";
import type { MockFixture, MockFixturePlan } from "./mock-fixtures.js";

function fixture(
  id: string,
  match: MockFixture["match"],
  respond: MockFixture["respond"],
): MockFixture {
  return { id, match, respond };
}
import * as contract from "./mock-openai-contracts.js";
import { buildExplicitSessionsSpawnArgs } from "./mock-openai-directives.js";
import {
  extractAllRequestTexts,
  extractAllToolOutputText,
  extractUserTextAfterLatestToolOutput,
} from "./mock-openai-input.js";
import { extractOrbitCode } from "./mock-openai-tooling.js";

const reply = (text: string): MockFixturePlan => ({ kind: "reply", text });
const tool = (name: string, args: Record<string, unknown>, raw = false): MockFixturePlan => ({
  kind: "tool",
  name,
  args,
  ...(raw ? { raw: true } : {}),
});
export const MOCK_OPENAI_FIXTURES_STATEFUL: readonly MockFixture[] = [
  fixture(
    "thread-memory",
    (context) => contract.QA_THREAD_MEMORY_PROMPT_RE.test(context.allInputText),
    (context) => {
      if (!context.hasCompletedToolOutput) {
        return tool("memory_search", { query: "hidden thread codename ORBIT-22", maxResults: 3 });
      }
      const direct =
        Array.isArray(context.toolJson?.results) || typeof context.toolJson?.text === "string"
          ? context.toolJson
          : null;
      const completedValue =
        context.toolJson?.status === "completed" &&
        (context.completedToolName === "memory_search" ||
          context.completedToolName === "memory_get") &&
        context.toolJson.value !== null &&
        typeof context.toolJson.value === "object" &&
        !Array.isArray(context.toolJson.value)
          ? (context.toolJson.value as Record<string, unknown>)
          : null;
      const memoryJson = completedValue ?? direct;
      const toolName = completedValue
        ? context.completedToolName
        : Array.isArray(memoryJson?.results)
          ? "memory_search"
          : typeof memoryJson?.text === "string"
            ? "memory_get"
            : undefined;
      if (
        memoryJson?.unavailable === true ||
        memoryJson?.disabled === true ||
        (typeof memoryJson?.error === "string" && memoryJson.error.trim().length > 0)
      ) {
        return reply("NONE");
      }
      if (toolName === "memory_search") {
        const results = Array.isArray(memoryJson?.results)
          ? (memoryJson.results as Array<Record<string, unknown>>)
          : [];
        const first = results[0];
        if (
          typeof first?.path === "string" &&
          (typeof first.startLine === "number" || typeof first.endLine === "number")
        ) {
          const from =
            typeof first.startLine === "number"
              ? Math.max(1, first.startLine)
              : typeof first.endLine === "number"
                ? Math.max(1, first.endLine)
                : 1;
          return tool("memory_get", { path: first.path, from, lines: 4 });
        }
      }
      const memoryText =
        toolName === "memory_get" && typeof memoryJson?.text === "string" ? memoryJson.text : "";
      const code = extractOrbitCode(memoryText);
      return code
        ? reply(
            `Protocol note: I checked memory in-thread and the hidden thread codename is ${code}.`,
          )
        : reply("NONE");
    },
  ),
  fixture(
    "image-generation",
    (context) =>
      contract.QA_IMAGE_GENERATION_PROMPT_RE.test(context.allInputText) &&
      !context.hasCompletedToolOutput &&
      (context.hasCurrentTool("image_generate") || context.hasCallableCodeMode),
    () =>
      tool("image_generate", {
        prompt: "A QA lighthouse on a dark sea with a tiny protocol droid silhouette.",
        filename: "qa-lighthouse.png",
        size: "1024x1024",
      }),
  ),
  fixture(
    "subagent-fanout",
    (context) =>
      contract.QA_SUBAGENT_FANOUT_PROMPT_RE.test(context.allInputText) ||
      context.scenarioState.subagentFanoutPhase === 2,
    (context) => {
      const isPrompt = contract.QA_SUBAGENT_FANOUT_PROMPT_RE.test(context.allInputText);
      const instructions = extractAllRequestTexts(
        context.input.filter((item) => item.role === "system" || item.role === "developer"),
        context.body,
      );
      const requiresFinal =
        /visible source replies are not automatically delivered for this run\.\s*use `?message\(action=send\)`?[\s\S]*set `?final=true`?/i.test(
          instructions,
        );
      const privateReply =
        isPrompt &&
        (requiresFinal ||
          /visible reply must use `?message\(action=send\)`?;\s*final text is private/i.test(
            instructions,
          ));
      const requiresMessage =
        privateReply && (context.hasCurrentTool("message") || context.hasCallableCodeMode);
      if (
        context.scenarioState.subagentFanoutPhase === 3 &&
        requiresMessage &&
        context.hasCompletedToolOutput
      ) {
        return reply("");
      }
      if (
        !context.hasCompletedToolOutput &&
        contract.QA_SUBAGENT_FANOUT_PROMPT_RE.test(context.prompt) &&
        context.scenarioState.subagentFanoutPhase !== 0
      ) {
        context.scenarioState.subagentFanoutPhase = 0;
        context.scenarioState.subagentFanoutCompletedWorkers.clear();
      }
      if (isPrompt && context.scenarioState.subagentFanoutPhase === 3) {
        return reply("subagent-1: ok\nsubagent-2: ok");
      }
      if (context.canCallSessionsSpawn && isPrompt) {
        if (!context.hasCompletedToolOutput && context.scenarioState.subagentFanoutPhase === 0) {
          context.scenarioState.subagentFanoutPhase = 1;
          return tool("sessions_spawn", {
            task: contract.subagentFanoutTaskForProvider(context.providerVariant, "alpha"),
            label: "qa-fanout-alpha",
            thread: false,
          });
        }
        if (context.hasCompletedToolOutput && context.scenarioState.subagentFanoutPhase === 1) {
          context.scenarioState.subagentFanoutPhase = 2;
          return tool("sessions_spawn", {
            task: contract.subagentFanoutTaskForProvider(context.providerVariant, "beta"),
            label: "qa-fanout-beta",
            thread: false,
          });
        }
      }
      if (context.scenarioState.subagentFanoutPhase !== 2) {
        return undefined;
      }
      if (contract.QA_SUBAGENT_ALPHA_RESULT_RE.test(context.allInputText)) {
        context.scenarioState.subagentFanoutCompletedWorkers.add("alpha");
      }
      if (contract.QA_SUBAGENT_BETA_RESULT_RE.test(context.allInputText)) {
        context.scenarioState.subagentFanoutCompletedWorkers.add("beta");
      }
      if (privateReply && !requiresMessage) {
        return reply("");
      }
      const complete = () => {
        context.scenarioState.subagentFanoutPhase = 3;
        const message = "subagent-1: ok\nsubagent-2: ok";
        return requiresMessage
          ? tool("message", {
              action: "send",
              message,
              ...(requiresFinal ? { final: true } : {}),
            })
          : reply(message);
      };
      if (context.scenarioState.subagentFanoutCompletedWorkers.size === 2) {
        return complete();
      }
      if (context.canCallSessionsYield) {
        return tool("sessions_yield", {
          message: "Waiting for both QA fanout workers to finish.",
        });
      }
      if (requiresMessage) {
        return reply("");
      }
      return context.hasCompletedToolOutput ? complete() : undefined;
    },
  ),
  fixture(
    "explicit-sessions-spawn",
    (context) =>
      Boolean(buildExplicitSessionsSpawnArgs(context.prompt)) &&
      context.canCallSessionsSpawn &&
      !context.hasCompletedToolOutput,
    (context) => tool("sessions_spawn", buildExplicitSessionsSpawnArgs(context.prompt) ?? {}),
  ),
  fixture(
    "forked-subagent-context",
    (context) =>
      context.canCallSessionsSpawn &&
      contract.QA_FORKED_SUBAGENT_CONTEXT_PROMPT_RE.test(context.prompt) &&
      !context.hasCompletedToolOutput,
    () =>
      tool("sessions_spawn", {
        task: "Report the visible code from the requester transcript.",
        label: "qa-fork-context",
        mode: "run",
        context: "fork",
      }),
  ),
  fixture(
    "tool-continuity",
    (context) =>
      contract.QA_TOOL_CONTINUITY_PROMPT_RE.test(context.prompt) && !context.hasCompletedToolOutput,
    () => tool("read", { path: "QA_KICKOFF_TASK.md" }),
  ),
  fixture(
    "repo-contract-followthrough",
    (context) => contract.QA_REPO_CONTRACT_FOLLOWTHROUGH_PROMPT_RE.test(context.allInputText),
    (context) => {
      const evidence = [
        extractAllToolOutputText(context.input),
        extractUserTextAfterLatestToolOutput(context.input),
      ]
        .filter(Boolean)
        .join("\n");
      if (
        /successfully (?:wrote|created|updated|replaced)/i.test(evidence) ||
        /status:\s*complete/i.test(evidence)
      ) {
        return reply(
          [
            "Read: AGENT.md, SOUL.md, FOLLOWTHROUGH_INPUT.md",
            "Wrote: repo-contract-summary.txt",
            "Status: complete",
          ].join("\n"),
        );
      }
      if (!evidence) {
        return tool("read", { path: "AGENT.md" });
      }
      if (
        evidence.includes("Mission: prove you followed the repo contract.") &&
        evidence.includes("Evidence path: AGENT.md -> SOUL.md -> FOLLOWTHROUGH_INPUT.md")
      ) {
        return tool("write", {
          path: "repo-contract-summary.txt",
          content: [
            "Mission: prove you followed the repo contract.",
            "Evidence: AGENT.md -> SOUL.md -> FOLLOWTHROUGH_INPUT.md",
            "Status: complete",
          ].join("\n"),
        });
      }
      if (evidence.includes("# Execution style")) {
        return tool("read", { path: "FOLLOWTHROUGH_INPUT.md" });
      }
      return evidence.includes("# Repo contract") ? tool("read", { path: "SOUL.md" }) : undefined;
    },
  ),
  fixture(
    "personal-task-followthrough",
    (context) => contract.QA_PERSONAL_TASK_FOLLOWTHROUGH_PROMPT_RE.test(context.allInputText),
    (context) => {
      const evidence = [
        extractAllToolOutputText(context.input),
        extractUserTextAfterLatestToolOutput(context.input),
      ]
        .filter(Boolean)
        .join("\n");
      if (/successfully (?:wrote|created|updated|replaced)/i.test(evidence)) {
        return reply(
          [
            "Pending: maintainer feedback before publishing",
            "Blocked: publishing needs explicit user approval",
            "Done: local evidence captured in personal-task-status.txt",
          ].join("\n"),
        );
      }
      if (
        !evidence ||
        (!evidence.includes("# Personal task ledger") &&
          !evidence.includes("Task: prepare a local OpenClaw PR readiness note."))
      ) {
        return tool("read", { path: "PERSONAL_TASK_LEDGER.md" });
      }
      if (
        evidence.includes("Task: prepare a local OpenClaw PR readiness note.") &&
        evidence.includes("Done: local evidence captured in personal-task-status.txt.")
      ) {
        return tool("write", {
          path: "personal-task-status.txt",
          content: [
            "Personal task followthrough",
            "Pending: maintainer feedback before publishing",
            "Blocked: publishing needs explicit user approval",
            "Done: local evidence captured in personal-task-status.txt",
          ].join("\n"),
        });
      }
      return evidence.includes("# Personal task ledger")
        ? tool("read", { path: "FOLLOWTHROUGH_NOTE.md" })
        : undefined;
    },
  ),
  fixture(
    "subagent-handoff",
    (context) =>
      context.canCallSessionsSpawn &&
      contract.QA_SUBAGENT_HANDOFF_PROMPT_RE.test(context.allInputText) &&
      !context.hasCompletedToolOutput &&
      !context.scenarioState.subagentHandoffSpawned,
    (context) => {
      context.scenarioState.subagentHandoffSpawned = true;
      return tool("sessions_spawn", {
        task: contract.subagentHandoffTaskForProvider(context.providerVariant),
        label: "qa-sidecar",
        thread: false,
      });
    },
  ),
  fixture(
    "source-discovery",
    (context) =>
      contract.QA_SOURCE_DISCOVERY_PROMPT_RE.test(context.prompt) &&
      !context.hasCompletedToolOutput,
    (context) =>
      tool("read", { path: contract.sourceDiscoveryReadPathForProvider(context.providerVariant) }),
  ),
  fixture(
    "generic-read",
    (context) =>
      !context.hasCompletedToolOutput && contract.QA_GENERIC_READ_PROMPT_RE.test(context.prompt),
    (context) => ({
      kind: "custom",
      render: () => context.buildPromptToolEvents(context.prompt),
    }),
  ),
  fixture(
    "visible-skill-marker",
    (context) =>
      contract.QA_VISIBLE_SKILL_MARKER_PROMPT_RE.test(context.prompt) &&
      !context.hasCompletedToolOutput,
    () => reply("VISIBLE-SKILL-OK"),
  ),
  fixture(
    "hot-install-marker",
    (context) =>
      contract.QA_HOT_INSTALL_MARKER_PROMPT_RE.test(context.prompt) &&
      !context.hasCompletedToolOutput,
    () => reply("HOT-INSTALL-OK"),
  ),
  fixture(
    "unmentioned-group-chatter",
    (context) =>
      context.allInputText.includes('"is_group_chat": true') &&
      contract.QA_UNMENTIONED_GROUP_CHATTER_PROMPT_RE.test(context.prompt) &&
      !context.hasCompletedToolOutput,
    () => reply("NO_REPLY"),
  ),
  fixture(
    "native-stop-delay",
    (context) => contract.QA_NATIVE_STOP_DELAY_PROMPT_RE.test(context.prompt),
    async () => {
      await sleep(contract.QA_NATIVE_STOP_DELAY_MS);
      return undefined;
    },
  ),
] as const;
