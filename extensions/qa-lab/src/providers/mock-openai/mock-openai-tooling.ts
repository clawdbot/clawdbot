// QA Lab mock provider tool planning and memory fixtures.
import { createHash } from "node:crypto";
import { QA_LAB_WEB_SEARCH_DENIED_INPUT_QUERY } from "../../qa-web-search-provider.js";
import type { StreamEvent } from "./mock-openai-contracts.js";

let mockFunctionCallSequence = 0;

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

  const loosePath = /\b[A-Za-z0-9._-]+\.(?:md|json|ts|tsx|js|mjs|cjs|txt|yaml|yml)\b/i
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

export function buildMockFunctionCall(name: string, args: Record<string, unknown>) {
  const serialized = JSON.stringify(args);
  const callSuffix = createHash("sha256")
    .update(name)
    .update("\0")
    .update(serialized)
    .digest("hex")
    .slice(0, 10);
  const sequence = ++mockFunctionCallSequence;
  const uniqueSuffix = `${callSuffix}_${sequence}`;
  const callId = `call_mock_${name}_${uniqueSuffix}`;
  const itemId = `fc_mock_${name}_${uniqueSuffix}`;
  const item = {
    type: "function_call",
    id: itemId,
    call_id: callId,
    name,
    arguments: serialized,
  };
  return {
    callId,
    item,
    itemId,
    responseId: `resp_mock_${name}_${uniqueSuffix}`,
    serialized,
  };
}

export function buildToolCallEventsWithArgs(
  name: string,
  args: Record<string, unknown>,
): StreamEvent[] {
  const call = buildMockFunctionCall(name, args);
  return [
    {
      type: "response.output_item.added",
      item: {
        type: "function_call",
        id: call.itemId,
        call_id: call.callId,
        name,
        arguments: "",
      },
    },
    { type: "response.function_call_arguments.delta", delta: call.serialized },
    {
      type: "response.output_item.done",
      item: call.item,
    },
    {
      type: "response.completed",
      response: {
        id: call.responseId,
        status: "completed",
        output: [call.item],
        usage: { input_tokens: 64, output_tokens: 16, total_tokens: 80 },
      },
    },
  ];
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

export function buildQaToolSearchArgs(
  targetTool: string,
  failureMode: boolean,
): Record<string, unknown> {
  if (failureMode && targetTool === "web_search") {
    return { query: QA_LAB_WEB_SEARCH_DENIED_INPUT_QUERY };
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
  if (targetTool === "ask_user") {
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
