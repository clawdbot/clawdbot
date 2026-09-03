// QA Lab mock provider tool planning and memory fixtures.
import { createHash } from "node:crypto";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { QA_LAB_WEB_SEARCH_DENIED_INPUT_QUERY } from "../../qa-web-search-provider.js";
import type { MockToolCallItem, StreamEvent } from "./mock-openai-contracts.js";
import { MockResponseStream } from "./mock-openai-stream.js";

let mockFunctionCallSequence = 0;

export const QA_TOOL_SEARCH_SECONDARY_TARGET = "fake_plugin_tool_01";

function normalizePromptPathCandidate(candidate: string) {
  const trimmed = candidate.trim().replace(/^`+|`+$/g, "");
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.replace(/^\.\//, "");
  if (
    normalized.includes("/") ||
    /\.(?:md|json|ts|tsx|js|mjs|cjs|txt|yaml|yml)$/i.test(normalized)
  ) {
    return normalized;
  }
  return null;
}

export function readTargetFromPrompt(prompt: string) {
  const backtickedMatches = Array.from(prompt.matchAll(/`([^`]+)`/g))
    .map((match) => normalizePromptPathCandidate(match[1] ?? ""))
    .filter((value): value is string => Boolean(value));
  if (backtickedMatches.length > 0) {
    return backtickedMatches[0];
  }

  const quotedMatches = Array.from(prompt.matchAll(/"([^"]+)"/g))
    .map((match) => normalizePromptPathCandidate(match[1] ?? ""))
    .filter((value): value is string => Boolean(value));
  if (quotedMatches.length > 0) {
    return quotedMatches[0];
  }

  const repoScoped = /\b(?:repo\/[^\s`",)]+|QA_[A-Z_]+\.md)\b/.exec(prompt)?.[0]?.trim();
  if (repoScoped) {
    return repoScoped;
  }

  const loosePath =
    /\b[A-Za-z0-9_][A-Za-z0-9._@!:-]*\.(?:md|json|ts|tsx|js|mjs|cjs|txt|yaml|yml)\b/i
      .exec(prompt)?.[0]
      ?.trim();
  if (loosePath) {
    return loosePath;
  }

  if (/\bdocs?\b/i.test(prompt)) {
    return "repo/docs/help/testing.md";
  }
  if (/\bscenario|kickoff|qa\b/i.test(prompt)) {
    return "QA_KICKOFF_TASK.md";
  }
  return "repo/package.json";
}

export function execCommandFromToolProgressPrompt(prompt: string) {
  return (
    /call the exec tool exactly once with this exact command before answering:\s*`([^`]+)`/i
      .exec(prompt)?.[1]
      ?.trim() || null
  );
}

export function buildMockFunctionCall(
  name: string,
  args: Record<string, unknown>,
  namespace?: string,
) {
  const serialized = JSON.stringify(args);
  const callSuffix = createHash("sha256")
    .update(name)
    .update("\0")
    .update(serialized)
    .digest("hex")
    .slice(0, 10);
  const sequence = ++mockFunctionCallSequence;
  const uniqueSuffix = `${callSuffix}_${sequence}`;
  const item: MockToolCallItem = {
    type: "function_call",
    id: `fc_mock_${name}_${uniqueSuffix}`,
    call_id: `call_mock_${name}_${uniqueSuffix}`,
    name,
    ...(namespace ? { namespace } : {}),
    arguments: serialized,
  };
  return {
    item,
    responseId: `resp_mock_${name}_${uniqueSuffix}`,
  };
}

export function buildToolCallEventsWithArgs(
  name: string,
  args: Record<string, unknown>,
  namespace?: string,
): StreamEvent[] {
  const call = buildMockFunctionCall(name, args, namespace);
  const stream = new MockResponseStream(call.responseId);
  stream.tool(call.item);
  return stream.complete(16);
}

export function buildCustomToolCallEventsWithInput(
  name: string,
  input: string,
  namespace?: string,
): StreamEvent[] {
  const call = buildMockFunctionCall(name, { input }, namespace);
  const stream = new MockResponseStream(call.responseId);
  stream.tool({
    type: "custom_tool_call",
    id: call.item.id.replace(/^fc_/, "ctc_"),
    call_id: call.item.call_id,
    name,
    ...(namespace ? { namespace } : {}),
    input,
    status: "completed",
  });
  return stream.complete(16);
}

export function extractRememberedFact(userTexts: string[]) {
  for (const text of userTexts) {
    const qaCanaryMatch = /\bqa canary code is\s+([A-Za-z0-9-]+)/i.exec(text);
    if (qaCanaryMatch?.[1]) {
      return qaCanaryMatch[1];
    }
  }
  for (const text of userTexts) {
    const match = /remember(?: this fact for later)?:\s*([A-Za-z0-9-]+)/i.exec(text);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

export function extractOrbitCode(text: string) {
  return /\bORBIT-\d+\b/i.exec(text)?.[0]?.toUpperCase() ?? null;
}

function decodeXmlEntities(text: string) {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

export function extractActiveMemorySummary(text: string) {
  const match = /<active_memory_plugin>\s*([\s\S]*?)\s*<\/active_memory_plugin>/i.exec(text);
  return match?.[1] ? decodeXmlEntities(match[1]).trim() : null;
}

export function extractToolSearchTarget(text: string): string | null {
  const match = /\btarget=([A-Za-z0-9_.:-]+)\b/.exec(text);
  return match?.[1]?.trim() || null;
}

export function toolSearchOutputHasCandidate(output: unknown, targetTool: string): boolean {
  if (!isRecord(output) || !Array.isArray(output.results)) {
    return false;
  }
  return output.results.some(
    (result) =>
      isRecord(result) &&
      Array.isArray(result.candidates) &&
      result.candidates.some(
        (candidate) =>
          isRecord(candidate) && (candidate.name === targetTool || candidate.id === targetTool),
      ),
  );
}

export function buildQaToolSearchArgs(
  targetTool: string,
  failureMode: boolean,
  prompt = "",
): Record<string, unknown> {
  if (failureMode && targetTool === "web_search") {
    return { query: QA_LAB_WEB_SEARCH_DENIED_INPUT_QUERY };
  }
  if (failureMode && targetTool === "apply_patch") {
    return {
      input: [
        "*** Begin Patch",
        "*** Update File: ../runtime-tool-fixture-denied.txt",
        "@@",
        "-runtime-tool-fixture-denied-original",
        "+runtime patch outside the workspace",
        "*** End Patch",
        "",
      ].join("\n"),
    };
  }
  if (failureMode) {
    return { __qaFailureMode: "denied-input" };
  }
  if (targetTool === "exec") {
    return { command: "echo runtime-tool-fixture", timeout: 5 };
  }
  if (targetTool === "read") {
    return { path: "QA_KICKOFF_TASK.md" };
  }
  if (targetTool === "write") {
    return { path: "runtime-tool-fixture-write.txt", content: "runtime tool fixture\n" };
  }
  if (targetTool === "edit") {
    return {
      path: "runtime-tool-fixture-edit.txt",
      edits: [{ oldText: "before edit\n", newText: "after edit\n" }],
    };
  }
  if (targetTool === "apply_patch") {
    return {
      input: [
        "*** Begin Patch",
        "*** Add File: runtime-tool-fixture-patch.txt",
        "+runtime patch",
        "*** End Patch",
        "",
      ].join("\n"),
    };
  }
  if (targetTool === "web_search") {
    return { query: "OpenClaw runtime parity fixed query", count: 1 };
  }
  if (targetTool === "web_fetch") {
    return { url: "https://example.com/", maxChars: 500 };
  }
  if (targetTool === "image_generate") {
    return { prompt: "QA lighthouse runtime parity fixture", filename: "runtime-tool-fixture" };
  }
  if (targetTool === "tts") {
    return { text: "Runtime parity voice fixture." };
  }
  if (targetTool === "message") {
    return { action: "send", message: "runtime parity message fixture" };
  }
  if (targetTool === "openclaw") {
    return {
      message: "Reply exactly QA-SYSTEM-AGENT-DELEGATE-INFERENCE-OK. Do not call tools.",
    };
  }
  if (targetTool === "ask_user") {
    if (/\bask_user_fixture=single\b/i.test(prompt)) {
      return {
        questions: [
          {
            id: "deploy_target",
            header: "Deploy",
            question: "Where should this deploy?",
            options: [
              { label: "Staging (Recommended)", description: "Safer default" },
              { label: "Production 🚀", description: "Ship to users" },
            ],
          },
        ],
        timeoutSeconds: 60,
      };
    }
    if (/\bask_user_fixture=multi\b/i.test(prompt)) {
      return {
        questions: [
          {
            id: "checks",
            header: "Checks",
            question: "Which checks should run?",
            options: [
              { label: "Unit (Recommended)", description: "Fast focused coverage" },
              { label: "E2E", description: "Full user-path coverage" },
              { label: "Lint", description: "Static checks" },
            ],
            multiSelect: true,
          },
        ],
        timeoutSeconds: 60,
      };
    }
    return {
      questions: [
        {
          id: "deploy_target",
          header: "Deploy",
          question: "Where should this deploy?",
          options: [
            { label: "Staging (Recommended)", description: "Safer default" },
            { label: "Production", description: "Ship to users" },
          ],
        },
        {
          id: "checks",
          header: "Checks",
          question: "Which checks should run?",
          options: [
            { label: "Unit (Recommended)", description: "Fast focused coverage" },
            { label: "E2E", description: "Full user-path coverage" },
            { label: "Lint", description: "Static checks" },
          ],
          multiSelect: true,
        },
        {
          id: "release_note",
          header: "Note",
          question: "Which release note label should be used?",
          options: [
            { label: "Routine (Recommended)", description: "Standard release note" },
            { label: "Urgent", description: "Highlight prominently" },
          ],
        },
      ],
      timeoutSeconds: 60,
    };
  }
  if (targetTool === "llm-task") {
    return {
      prompt: 'Remember this fact and reply exactly `{"status":"ok"}`.',
      input: { secret: "qa-plugin-usage-secret-sentinel" },
      schema: {
        type: "object",
        required: ["status"],
        properties: { status: { const: "ok" } },
      },
    };
  }
  if (targetTool === "session_status") {
    return { sessionKey: "current" };
  }
  if (targetTool === "sessions_spawn") {
    return {
      task: "Runtime tool fixture subagent: reply exactly RUNTIME-TOOL-FIXTURE.",
      label: "runtime-tool-fixture",
      mode: "run",
      thread: false,
    };
  }
  if (targetTool === "memory_recall") {
    return { query: "runtime parity memory fixture" };
  }
  return { marker: "normal" };
}

export function isActiveMemorySubagentPrompt(text: string) {
  return text.includes("You are a memory search agent.");
}

export function isSnackRecallPrompt(text: string) {
  return (
    /silent snack recall check/i.test(text) || /remember across conversations qa check/i.test(text)
  );
}

export function extractSnackPreference(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  const match =
    /(lemon pepper wings(?:\s+with\s+blue cheese)?|blue cheese(?:\s+with\s+lemon pepper wings)?)/i.exec(
      normalized,
    );
  return match?.[0]?.trim() ?? null;
}
