import { MOCK_OPENAI_FIXTURES_CORE } from "./mock-fixtures-core.js";
import { MOCK_OPENAI_FIXTURES_DELIVERY } from "./mock-fixtures-delivery.js";
import { MOCK_OPENAI_FIXTURES_STATEFUL } from "./mock-fixtures-stateful.js";
import { MOCK_OPENAI_FIXTURES_WORKFLOWS } from "./mock-fixtures-workflows.js";
// Ordered scenario fixtures for the QA Lab mock Responses provider.
import * as contract from "./mock-openai-contracts.js";
import {
  extractExactMarkerDirective,
  extractExactReplyDirective,
  extractSlackProgressCommentaryDirectives,
  hasDeclaredTool,
  hasToolDefinition,
  QA_SLACK_PROGRESS_COMMENTARY_MARKER_RE,
} from "./mock-openai-directives.js";
import {
  extractAllRequestTexts,
  extractAllUserTexts,
  extractCurrentImageRequest,
  extractLastMatchingUserTurn,
  extractLastUserText,
  extractLatestToolOutput,
  extractToolOutput,
  hasToolOutput,
  parseToolOutputJson,
} from "./mock-openai-input.js";
type MaybePromise<T> = T | Promise<T>;
type ProviderVariant = "openai" | "anthropic" | "unknown";

export type MockFixtureStream = {
  id: string;
  text: string;
  streamDeltas?: string[];
  phase?: "commentary" | "final_answer";
};

export type MockFixturePlan =
  | { kind: "reply"; text: string }
  | { kind: "tool"; name: string; args: Record<string, unknown>; raw?: boolean }
  | { kind: "stream"; message: MockFixtureStream }
  | {
      kind: "assistant-tool";
      message: MockFixtureStream;
      tool: { name: string; args: Record<string, unknown> };
    }
  | { kind: "reasoning"; id: string; text: string }
  | { kind: "reasoning-reply"; reasoningId: string; answerText: string }
  | { kind: "custom"; render: () => MaybePromise<contract.StreamEvent[]> }
  | {
      kind: "fault";
      status: number;
      type: string;
      code?: string;
      message: string;
    };

export type MockCodeModeControl =
  | { status: "waiting"; cellId: string }
  | { status: "waiting"; runId: string }
  | { status: "completed"; value: unknown }
  | null;

export type MockFixtureContextParams = {
  body: Record<string, unknown>;
  input: contract.ResponsesInputItem[];
  scenarioState: contract.MockScenarioState;
  requestKind: contract.MockOpenAiRequestKind;
  compactionSummaryFaultMode: contract.MockCompactionSummaryFaultMode;
  toolDeclarationBody: Record<string, unknown>;
  toolOutput: string;
  completedToolName?: string;
  codeModeControlJson: MockCodeModeControl;
  hasCallableCodeMode: boolean;
  providerVariant: ProviderVariant;
  childSessionKey?: string;
  waitForTerminalRequesterSettled?: (caseName: string, childSessionKey: string) => Promise<void>;
  buildPromptToolEvents: (prompt: string) => contract.StreamEvent[];
};

export type MockFixtureContext = ReturnType<typeof createMockFixtureContext>;

export type MockFixture = {
  id: string;
  match: (context: MockFixtureContext) => boolean;
  respond: (context: MockFixtureContext) => MaybePromise<MockFixturePlan | undefined>;
};

function latestScenarioFamilyPrompt(texts: string[]) {
  let envelope = "";
  for (const text of texts.toReversed()) {
    const trimmed = text.trim();
    if (contract.QA_STREAMING_TOOL_PROGRESS_FAMILY_PROMPT_RE.test(text)) {
      envelope = text;
      break;
    }
    if (
      !contract.QA_STREAMING_TOOL_PROGRESS_CONTINUATION_RE.test(trimmed) &&
      !trimmed.startsWith(contract.QA_SETTLED_TOOL_TERMINAL_CONTINUATION_NEEDLE)
    ) {
      return "";
    }
  }
  if (!envelope) {
    return "";
  }
  const pattern = new RegExp(
    contract.QA_STREAMING_TOOL_PROGRESS_FAMILY_PROMPT_RE.source,
    `${contract.QA_STREAMING_TOOL_PROGRESS_FAMILY_PROMPT_RE.flags}g`,
  );
  let latestIndex = -1;
  for (const match of envelope.matchAll(pattern)) {
    latestIndex = match.index;
  }
  return latestIndex < 0 ? "" : envelope.slice(latestIndex);
}

function findNamedToolDefinition(
  value: unknown,
  name: string,
  depth = 0,
): Record<string, unknown> | null {
  if (depth > 6 || !value || typeof value !== "object") {
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findNamedToolDefinition(item, name, depth + 1);
      if (match) {
        return match;
      }
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.name === name || record.tool === name || record.functionName === name) {
    return record;
  }
  for (const item of Object.values(record)) {
    const match = findNamedToolDefinition(item, name, depth + 1);
    if (match) {
      return match;
    }
  }
  return null;
}

export function createMockFixtureContext(params: MockFixtureContextParams) {
  const { body, input, toolDeclarationBody } = params;
  const prompt = extractLastUserText(input);
  const allInputText = extractAllRequestTexts(input, body);
  const hasCompletedToolOutput = hasToolOutput(input);
  const scenarioToolOutput =
    params.toolOutput ||
    (contract.QA_THREAD_MEMORY_PROMPT_RE.test(allInputText) ||
    contract.QA_SESSION_MEMORY_RANKING_PROMPT_RE.test(allInputText) ||
    contract.QA_MEMORY_TOOLS_PROMPT_RE.test(allInputText) ||
    contract.QA_REPO_CONTRACT_FOLLOWTHROUGH_PROMPT_RE.test(allInputText)
      ? extractLatestToolOutput(input)
      : "");
  const toolJson = parseToolOutputJson(scenarioToolOutput);
  const allUserTexts = extractAllUserTexts(input);
  const allUserText = allUserTexts.join("\n");
  const scenarioFamilyPrompt = latestScenarioFamilyPrompt(allUserTexts) || prompt;
  const promptExactReplyDirective = extractExactReplyDirective(prompt);
  const promptExactMarkerDirective = extractExactMarkerDirective(prompt);
  const scenarioFamilyReplyDirective =
    extractExactReplyDirective(scenarioFamilyPrompt) ??
    extractExactMarkerDirective(scenarioFamilyPrompt) ??
    extractExactReplyDirective(scenarioToolOutput) ??
    extractExactMarkerDirective(scenarioToolOutput);
  const exactReplyDirective = promptExactReplyDirective ?? extractExactReplyDirective(allInputText);
  const exactMarkerDirective =
    promptExactMarkerDirective ?? extractExactMarkerDirective(allInputText);
  const toolProgressTurn = extractLastMatchingUserTurn(
    input,
    contract.QA_TOOL_PROGRESS_FAMILY_PROMPT_RE,
  );
  const toolProgressToolOutput = toolProgressTurn
    ? extractToolOutput(input.slice(toolProgressTurn.index))
    : "";
  const slackProgressTurn = extractLastMatchingUserTurn(
    input,
    QA_SLACK_PROGRESS_COMMENTARY_MARKER_RE,
  );
  const terminalCompletionCase = extractLastMatchingUserTurn(
    input,
    contract.QA_SUBAGENT_TERMINAL_MATRIX_PROMPT_RE,
  )
    ?.text.match(contract.QA_SUBAGENT_TERMINAL_MATRIX_PROMPT_RE)?.[1]
    ?.toLowerCase();
  const terminalWorkerCase = Array.from(
    allInputText.matchAll(
      new RegExp(
        contract.QA_SUBAGENT_TERMINAL_MATRIX_WORKER_RE.source,
        `${contract.QA_SUBAGENT_TERMINAL_MATRIX_WORKER_RE.flags.replaceAll("g", "")}g`,
      ),
    ),
  )
    .at(-1)?.[1]
    ?.toLowerCase();
  return {
    ...params,
    prompt,
    allInputText,
    hasCompletedToolOutput,
    scenarioToolOutput,
    toolJson,
    scenarioFamilyPrompt,
    scenarioFamilyReplyDirective,
    promptExactReplyDirective,
    promptExactMarkerDirective,
    userExactReplyDirective: promptExactReplyDirective ?? extractExactReplyDirective(allUserText),
    userExactMarkerDirective:
      promptExactMarkerDirective ?? extractExactMarkerDirective(allUserText),
    exactReplyDirective,
    exactMarkerDirective,
    currentImageRequest: extractCurrentImageRequest(input, body),
    blockStreamingPrompt: scenarioFamilyPrompt || prompt || allInputText,
    toolProgressToolOutput,
    toolProgressToolJson: parseToolOutputJson(toolProgressToolOutput),
    slackProgressDirectives: slackProgressTurn
      ? extractSlackProgressCommentaryDirectives(slackProgressTurn.text)
      : null,
    hasSlackProgressToolOutput: slackProgressTurn
      ? hasToolOutput(input.slice(slackProgressTurn.index))
      : false,
    terminalCompletionCase,
    terminalWorkerCase,
    hasDeclaredTool: (name: string) => hasDeclaredTool(body, name),
    hasCurrentTool: (name: string) => hasToolDefinition(toolDeclarationBody, name),
    findCurrentTool: (name: string) => findNamedToolDefinition(toolDeclarationBody, name),
    canCallSessionsSpawn:
      hasToolDefinition(toolDeclarationBody, "sessions_spawn") || params.hasCallableCodeMode,
    canCallSessionsYield:
      hasToolDefinition(toolDeclarationBody, "sessions_yield") || params.hasCallableCodeMode,
  };
}

export const MOCK_OPENAI_FIXTURES: readonly MockFixture[] = [
  ...MOCK_OPENAI_FIXTURES_CORE,
  ...MOCK_OPENAI_FIXTURES_DELIVERY,
  ...MOCK_OPENAI_FIXTURES_WORKFLOWS,
  ...MOCK_OPENAI_FIXTURES_STATEFUL,
];

export async function findMockFixturePlan(context: MockFixtureContext) {
  for (const fixture of MOCK_OPENAI_FIXTURES) {
    const { match, respond } = fixture;
    if (!match(context)) {
      continue;
    }
    const plan = await respond(context);
    if (plan) {
      return plan;
    }
  }
  return undefined;
}
