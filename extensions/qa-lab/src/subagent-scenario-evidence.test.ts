import { describe, expect, it } from "vitest";
import {
  evaluateForkedSubagentEvidence,
  evaluateSubagentHandoffEvidence,
} from "./subagent-scenario-evaluator.js";

const requesterSessionKey = "agent:qa:subagent-handoff:current";
const childSessionKey = "agent:qa:subagent:current";
const expectedChildLabel = "qa-sidecar";
const childFinalText = "The sidecar verified the workspace.";
const parentFinalText = [
  "Delegated task: bounded QA inspection",
  `Result: ${childFinalText}`,
  "Evidence: the delegated child completed and delivered its result",
].join("\n");

function validChain(requester: string, child: string, label: string) {
  return {
    requesterSessionKey: requester,
    expectedChildLabel: label,
    sessionStore: {
      [child]: { spawnedBy: requester, label },
    },
    tasksPayload: {
      tasks: [
        {
          taskId: "task-current",
          requesterSessionKey: requester,
          childSessionKey: child,
          label,
          task: "Report the visible code",
          status: "succeeded",
          deliveryStatus: "delivered",
        },
      ],
    },
  };
}

function validInputs() {
  return {
    ...validChain(requesterSessionKey, childSessionKey, expectedChildLabel),
    childFinalText,
    parentFinalText,
  };
}

function validForkInputs() {
  const requester = "agent:qa:fork:current";
  const child = "agent:qa:fork-child";
  return {
    ...validChain(requester, child, "qa-fork-context"),
    contextNeedle: "FORKED-CONTEXT-ALPHA",
    childTranscripts: [{ sessionKey: child, finalText: "FORKED-CONTEXT-ALPHA" }],
  };
}

describe("subagent scenario evidence", () => {
  it("accepts one owned child, matching delivered task, and attributed child result", () => {
    expect(evaluateSubagentHandoffEvidence(validInputs())).toBe(true);
  });

  it.each([
    [
      "wrong child owner",
      { sessionStore: { [childSessionKey]: { spawnedBy: "stale", label: expectedChildLabel } } },
    ],
    [
      "wrong child label",
      { sessionStore: { [childSessionKey]: { spawnedBy: requesterSessionKey, label: "stale" } } },
    ],
    [
      "duplicate children",
      {
        sessionStore: {
          [childSessionKey]: { spawnedBy: requesterSessionKey, label: expectedChildLabel },
          "agent:qa:subagent:duplicate": {
            spawnedBy: requesterSessionKey,
            label: expectedChildLabel,
          },
        },
      },
    ],
    [
      "wrong task owner",
      {
        tasksPayload: {
          tasks: [{ ...validInputs().tasksPayload.tasks[0], requesterSessionKey: "stale" }],
        },
      },
    ],
    ["empty child", { childFinalText: "<prompt-data></prompt-data>" }],
    ["accepted-only child", { childFinalText: '{"status":"accepted"}' }],
    [
      "fabricated result",
      { parentFinalText: "Delegated task: x\nResult: fabricated\nEvidence: child completed" },
    ],
    [
      "unattributed evidence",
      { parentFinalText: `Delegated task: x\nResult: ${childFinalText}\nEvidence: done` },
    ],
    ["duplicate section", { parentFinalText: `${parentFinalText}\nResult: duplicate` }],
  ])("rejects %s", (_name, overrides) => {
    expect(evaluateSubagentHandoffEvidence({ ...validInputs(), ...overrides })).toBeUndefined();
  });

  it("accepts only the owned fork child transcript containing the fork needle", () => {
    expect(evaluateForkedSubagentEvidence(validForkInputs())).toBe(true);
  });

  it.each([
    ["no matching task", { tasks: [] }],
    [
      "a pending task",
      { tasks: [{ ...validForkInputs().tasksPayload.tasks[0], status: "running" }] },
    ],
    [
      "a failed task",
      { tasks: [{ ...validForkInputs().tasksPayload.tasks[0], status: "failed" }] },
    ],
    [
      "an undelivered task",
      { tasks: [{ ...validForkInputs().tasksPayload.tasks[0], deliveryStatus: "pending" }] },
    ],
    [
      "a task containing the context marker",
      {
        tasks: [
          {
            ...validForkInputs().tasksPayload.tasks[0],
            task: `Report ${validForkInputs().contextNeedle}`,
          },
        ],
      },
    ],
  ])("rejects fork evidence with %s", (_name, tasksPayload) => {
    expect(evaluateForkedSubagentEvidence({ ...validForkInputs(), tasksPayload })).toBeUndefined();
  });
});
