// QA Lab subagent evidence ties scenario claims to one current parent/child/task chain.
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  evaluateForkedSubagentEvidence,
  evaluateSubagentHandoffEvidence,
  readMatchingTasks,
  readOwnedChildren,
} from "./subagent-scenario-evaluator.js";
import {
  readRawQaSessionStore,
  readSessionTranscriptSummary,
  runQaCli,
} from "./suite-runtime-agent.js";

type CollectorParams = {
  env: Parameters<typeof runQaCli>[0];
  expectedChildLabel: string;
  requesterSessionKey: string;
  timeoutMs: number;
} & ({ kind: "handoff" } | { kind: "fork"; contextNeedle: string });

function summarizeSubagentEvidenceProbe(
  matchingChildCount: number,
  matchingTasks: unknown[],
  childFinalTexts: string[],
  evidence?: true,
) {
  const completedTaskCount = matchingTasks.filter(
    (task) => isRecord(task) && task.status === "succeeded" && task.deliveryStatus === "delivered",
  ).length;
  return [
    `children=${matchingChildCount}`,
    `tasks=${matchingTasks.length}`,
    `completed=${completedTaskCount}`,
    `childText=${childFinalTexts.some(Boolean) ? "present" : "absent"}`,
    `evidence=${evidence ? "valid" : "invalid"}`,
  ].join(" ");
}

export async function collectSubagentScenarioEvidence(params: CollectorParams) {
  try {
    const [sessionStore, tasksPayload] = await Promise.all([
      readRawQaSessionStore(params.env),
      runQaCli(params.env, ["tasks", "list", "--json", "--runtime", "subagent"], {
        timeoutMs: params.timeoutMs,
        json: true,
      }),
    ]);
    const childSessionKeys = readOwnedChildren({ ...params, sessionStore }).map(
      ([sessionKey]) => sessionKey,
    );
    const childTranscripts = await Promise.all(
      childSessionKeys.map(async (sessionKey) => ({
        sessionKey,
        finalText: (await readSessionTranscriptSummary(params.env, sessionKey)).finalText,
      })),
    );
    const evidence =
      params.kind === "handoff"
        ? evaluateSubagentHandoffEvidence({
            ...params,
            sessionStore,
            tasksPayload,
            childFinalText: childTranscripts[0]?.finalText,
            parentFinalText: (
              await readSessionTranscriptSummary(params.env, params.requesterSessionKey)
            ).finalText,
          })
        : evaluateForkedSubagentEvidence({
            ...params,
            sessionStore,
            tasksPayload,
            childTranscripts,
          });
    const matchingTasks = readMatchingTasks({ ...params, sessionStore, tasksPayload });
    return {
      evidence,
      summary: summarizeSubagentEvidenceProbe(
        childSessionKeys.length,
        matchingTasks,
        childTranscripts.map((transcript) => transcript.finalText),
        evidence,
      ),
    };
  } catch {
    return { evidence: undefined, summary: "collector=error evidence=invalid" };
  }
}
