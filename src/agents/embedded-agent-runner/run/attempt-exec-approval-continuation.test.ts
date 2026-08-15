import { describe, expect, it, vi } from "vitest";
import type { UserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.types.js";
import { buildExecApprovalContinuationPrompt } from "../../bash-tools.exec-approval-output.js";
import { prepareExecApprovalContinuationForAttempt } from "./attempt-exec-approval-continuation.js";

const OUTPUT_BEGIN = "<<<BEGIN_UNTRUSTED_EXEC_OUTPUT>>>";
const OUTPUT_END = "<<<END_UNTRUSTED_EXEC_OUTPUT>>>";

function extractOutput(prompt: string): string {
  const start = prompt.indexOf(OUTPUT_BEGIN) + OUTPUT_BEGIN.length + 1;
  const end = prompt.indexOf(`\n${OUTPUT_END}`, start);
  return prompt.slice(start, end);
}

function createRecorder(replaceTextBeforePersistence: (text: string) => void) {
  return { replaceTextBeforePersistence } as UserTurnTranscriptRecorder;
}

describe("prepareExecApprovalContinuationForAttempt", () => {
  it.each([
    {
      name: "uses the resolved 8k attempt budget for a 9.6k output cap",
      contextTokenBudget: 8_000,
      modelContextWindow: 20_000,
      expectedOutputLength: 9_600,
    },
    {
      name: "uses a 20k model context for a 16k output cap",
      contextTokenBudget: undefined,
      modelContextWindow: 20_000,
      expectedOutputLength: 16_000,
    },
  ])("$name and replaces the pending transcript text", (testCase) => {
    const prompt = buildExecApprovalContinuationPrompt("p".repeat(40_000));
    const transcript = buildExecApprovalContinuationPrompt("t".repeat(40_000));
    const replaceTextBeforePersistence = vi.fn();

    const prepared = prepareExecApprovalContinuationForAttempt({
      prompt: prompt.message,
      transcriptPrompt: transcript.message,
      promptRange: prompt.resultRange,
      transcriptPromptRange: transcript.resultRange,
      contextTokenBudget: testCase.contextTokenBudget,
      modelContextWindow: testCase.modelContextWindow,
      userTurnTranscriptRecorder: createRecorder(replaceTextBeforePersistence),
    });

    expect(extractOutput(prepared.prompt)).toHaveLength(testCase.expectedOutputLength);
    expect(extractOutput(prepared.transcriptPrompt ?? "")).toHaveLength(
      testCase.expectedOutputLength,
    );
    expect(extractOutput(prepared.prompt)).toMatch(/^p/);
    expect(extractOutput(prepared.transcriptPrompt ?? "")).toMatch(/^t/);
    expect(replaceTextBeforePersistence).toHaveBeenCalledOnce();
    expect(replaceTextBeforePersistence).toHaveBeenCalledWith(prepared.transcriptPrompt);
  });
});
