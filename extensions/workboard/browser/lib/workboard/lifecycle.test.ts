import "../../test/host.setup.ts";
import { expect, it } from "vitest";
import { getWorkboardLifecycle } from "./lifecycle.ts";
import { createGatewaySession, createWorkboardCard } from "./test/index-helpers.ts";

const localKey = "subagent:workboard-default-card-1";

it.each([
  { status: "running", hasActiveRun: true, state: "running", targetStatus: "running" },
  { status: "done", hasActiveRun: false, state: "succeeded", targetStatus: "review" },
  { status: "failed", hasActiveRun: false, state: "failed", targetStatus: "blocked" },
] as const)("resolves $status from the accepted agent-prefixed session", (expected) => {
  const card = createWorkboardCard({ sessionKey: localKey });
  const session = createGatewaySession({
    key: `agent:main:${localKey}`,
    status: expected.status,
    hasActiveRun: expected.hasActiveRun,
  });

  expect(
    getWorkboardLifecycle(card, [], undefined, { key: localKey, status: "resolved", session }),
  ).toMatchObject({
    session,
    state: expected.state,
    targetStatus: expected.targetStatus,
  });
});

it.each([
  {
    name: "an explicit link to a different agent",
    linkedKey: `agent:worker:${localKey}`,
    sessionKeys: [`agent:other:${localKey}`],
  },
  {
    name: "an ambiguous agentless link",
    linkedKey: localKey,
    sessionKeys: [`agent:worker:${localKey}`, `agent:other:${localKey}`],
  },
  {
    name: "one provisional match in a filtered roster",
    linkedKey: localKey,
    sessionKeys: [`agent:worker:${localKey}`],
  },
])("keeps $name unresolved", ({ linkedKey, sessionKeys }) => {
  const card = createWorkboardCard({ sessionKey: linkedKey });
  const sessions = sessionKeys.map((key) => createGatewaySession({ key }));
  expect(getWorkboardLifecycle(card, sessions)).toEqual({ session: null, state: "unknown" });
});

it("uses only the current session for lifecycle even when a historical attempt is still loaded", () => {
  const previous = createGatewaySession({ key: "agent:main:previous", status: "failed" });
  const current = createGatewaySession({
    key: `agent:main:${localKey}`,
    status: "done",
    hasActiveRun: false,
  });
  const card = createWorkboardCard({
    sessionKey: localKey,
    metadata: {
      attempts: [{ id: "previous", status: "failed", startedAt: 1, sessionKey: previous.key }],
    },
  });
  expect(getWorkboardLifecycle(card, [previous])).toEqual({ session: null, state: "unknown" });
  expect(
    getWorkboardLifecycle(card, [previous], undefined, {
      key: localKey,
      status: "resolved",
      session: current,
    }),
  ).toMatchObject({
    session: current,
    state: "succeeded",
    targetStatus: "review",
  });
});
