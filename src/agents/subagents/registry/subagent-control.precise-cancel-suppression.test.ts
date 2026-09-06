/**
 * Precise cancel entries must suppress the child's completion delivery.
 *
 * The bulk stop paths (`chat.abort`, `/stop`) already pass
 * `suppressTaskDelivery: true`; the cancel-by-task-id and HTTP admin kill entries
 * reach `killSubagentRunAdmin` and previously could not express it at all, so a
 * completion that raced the cancel could still be delivered after reconciliation.
 */
import { expect, it } from "vitest";
import { getRuntimeConfig } from "../../../config/config.js";
import { killSubagentRunAdmin } from "./subagent-control.js";
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { registerSubagentRun } from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";

const fixture = useSubagentControlFixture();

const CHILD_SESSION_KEY = "agent:main:subagent:precise-cancel";
const REQUESTER_SESSION_KEY = "agent:main:main";

async function registerCancellableChild(runId: string) {
  await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    sessionKey: CHILD_SESSION_KEY,
    agentId: "main",
    defaultSessionId: "sess-precise-cancel",
  });
  registerSubagentRun({
    runId,
    childSessionKey: CHILD_SESSION_KEY,
    requesterSessionKey: REQUESTER_SESSION_KEY,
    requesterAgentId: "main",
    requesterDisplayKey: "main",
    task: "work that races its own cancellation",
    cleanup: "keep",
    expectsCompletionMessage: true,
  });
  return subagentRuns.get(runId);
}

it.each([
  {
    name: "an operator cancel that asks for suppression",
    suppressTaskDelivery: true,
    expectedSuppression: true,
  },
  {
    name: "a caller that does not ask for suppression",
    suppressTaskDelivery: undefined,
    expectedSuppression: false,
  },
])(
  "carries $name through killSubagentRunAdmin into the kill reconciliation window",
  async ({ suppressTaskDelivery, expectedSuppression }) => {
    const runId = "precise-cancel-run";
    const entry = await registerCancellableChild(runId);
    expect(entry).toBeDefined();

    await killSubagentRunAdmin({
      cfg: getRuntimeConfig(),
      sessionKey: CHILD_SESSION_KEY,
      agentId: "main",
      ...(suppressTaskDelivery === undefined ? {} : { suppressTaskDelivery }),
    });

    const cancelled = subagentRuns.get(runId);
    // The suppression request has to survive as durable cancellation ownership,
    // otherwise a completion racing the cancel reconciles and delivers anyway.
    const carrier = cancelled?.killIntent ?? cancelled?.killReconciliation;
    expect(carrier).toBeDefined();
    expect(carrier?.suppressTaskDelivery ?? false).toBe(expectedSuppression);
  },
);
