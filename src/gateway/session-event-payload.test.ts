import { expect, it } from "vitest";
import {
  buildGatewaySessionEventFields,
  buildGatewaySessionSnapshot,
} from "./session-event-payload.js";

it("projects session actors and explicitly clears absent attribution", () => {
  expect(
    buildGatewaySessionEventFields({
      sessionRow: {
        key: "agent:main:owned",
        kind: "direct",
        updatedAt: 1,
        createdActor: { type: "human", id: "profile-ada", label: "Ada" },
        participants: [{ identity: { type: "profile", id: "profile-bob" }, label: "Bob" }],
        participantCount: 1,
      },
    }),
  ).toMatchObject({
    createdActor: { type: "human", id: "profile-ada", label: "Ada" },
    archivedBy: null,
    archiveReason: null,
    participants: [{ identity: { type: "profile", id: "profile-bob" }, label: "Bob" }],
    participantCount: 1,
  });

  expect(
    buildGatewaySessionEventFields({
      sessionRow: {
        key: "agent:main:archived",
        kind: "direct",
        updatedAt: 2,
        archivedBy: { type: "human", id: "profile-bob", label: "Bob" },
        archiveReason: "active-session-cap",
      },
    }),
  ).toMatchObject({
    createdActor: null,
    archivedBy: { type: "human", id: "profile-bob", label: "Bob" },
    archiveReason: "active-session-cap",
    participants: [],
    participantCount: 0,
  });
});

it("projects the prepared permission boundary only for an explicit mode", () => {
  const ordinary = buildGatewaySessionEventFields({
    sessionRow: {
      key: "agent:main:ordinary",
      kind: "direct",
      sessionRoot: "/workspace/private",
      updatedAt: 3,
    },
  });
  expect(ordinary).toMatchObject({ permissionMode: null });
  expect(ordinary).not.toHaveProperty("sessionRoot");

  expect(
    buildGatewaySessionEventFields({
      sessionRow: {
        key: "agent:main:workspace",
        kind: "direct",
        permissionMode: "workspace",
        sessionRoot: "/workspace/project",
        updatedAt: 4,
      },
    }),
  ).toMatchObject({ permissionMode: "workspace", sessionRoot: "/workspace/project" });
});

it("serializes merge tombstones without flattening row-only execution fields", () => {
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- verify the gateway JSON wire shape
  const snapshot = JSON.parse(
    JSON.stringify(
      buildGatewaySessionSnapshot({
        sessionRow: {
          key: "agent:main:project",
          kind: "direct",
          updatedAt: 5,
          traceLevel: "full",
          worktree: { id: "wt-1", branch: "feature", repoRoot: "/private/repo" },
          execNode: "private-node",
          execCwd: "/private/cwd",
        },
        includeSession: true,
      }),
    ),
  ) as Record<string, unknown>;

  expect(snapshot).toMatchObject({
    agentStatus: null,
    observerDigest: null,
    traceLevel: "full",
    session: {
      agentStatus: null,
      observerDigest: null,
      traceLevel: "full",
      worktree: { id: "wt-1", branch: "feature", repoRoot: "/private/repo" },
      execNode: "private-node",
      execCwd: "/private/cwd",
    },
  });
  for (const field of ["worktree", "execNode", "execCwd", "placement"]) {
    expect(snapshot, field).not.toHaveProperty(field);
  }
});

it("scopes the global goal to its resolved agent", () => {
  const sessionRow = {
    key: "global",
    kind: "global" as const,
    updatedAt: 6,
    goal: {
      schemaVersion: 1 as const,
      id: "goal-1",
      objective: "Scoped objective",
      status: "active" as const,
      createdAt: 1,
      updatedAt: 2,
      tokenStart: 0,
      tokensUsed: 3,
      continuationTurns: 0,
    },
  };

  const unscoped = buildGatewaySessionSnapshot({ sessionRow, includeSession: true });
  expect(unscoped).not.toHaveProperty("goal");
  expect(unscoped).not.toHaveProperty("session.goal");

  const scoped = buildGatewaySessionSnapshot({ sessionRow, agentId: "main", includeSession: true });
  expect(scoped).toMatchObject({ goal: sessionRow.goal, session: { goal: sessionRow.goal } });
});

it("preserves active run id ownership across omitted, liveness, and exact states", () => {
  const build = (activeRunState?: { active: boolean; runIds?: string[] }) =>
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- verify the gateway JSON wire shape
    JSON.parse(
      JSON.stringify(
        buildGatewaySessionSnapshot({
          sessionRow: { key: "agent:main:main", kind: "global", updatedAt: 7 },
          includeSession: true,
          activeRunState,
        }),
      ),
    ) as Record<string, unknown>;

  const omitted = build();
  expect(omitted).not.toHaveProperty("hasActiveRun");
  expect(omitted).not.toHaveProperty("activeRunIds");
  expect(omitted).not.toHaveProperty("session.hasActiveRun");
  expect(omitted).not.toHaveProperty("session.activeRunIds");
  expect(build({ active: true })).toMatchObject({
    hasActiveRun: true,
    activeRunIds: null,
    session: { hasActiveRun: true, activeRunIds: null },
  });
  expect(build({ active: false, runIds: [] })).toMatchObject({
    hasActiveRun: false,
    activeRunIds: [],
    session: { hasActiveRun: false, activeRunIds: [] },
  });
  expect(build({ active: true, runIds: ["run-1"] })).toMatchObject({
    hasActiveRun: true,
    activeRunIds: ["run-1"],
    session: { hasActiveRun: true, activeRunIds: ["run-1"] },
  });
});

it.each(["user", "auto", null] as const)(
  "carries model override source %s into session change events",
  (source) => {
    expect(
      buildGatewaySessionEventFields({
        sessionRow: {
          key: "agent:main:pinned",
          kind: "direct",
          updatedAt: 1,
          modelOverrideSource: source,
        },
      }).modelOverrideSource,
    ).toBe(source);
  },
);

it.each(["user", "auto", null] as const)(
  "does not mix lifecycle snapshots with model source %s",
  (modelOverrideSource) => {
    const snapshot = buildGatewaySessionSnapshot({
      sessionRow: {
        key: "agent:main:pinned",
        kind: "direct",
        updatedAt: 1,
        model: "model-a",
        modelProvider: "provider",
        modelOverrideSource,
      },
      lifecycle: true,
      includeSession: true,
    });
    expect(snapshot.modelOverrideSource).toBeUndefined();
    expect(snapshot.session).not.toHaveProperty("modelOverrideSource");
  },
);

it.each([
  { aborted: false, status: "done" },
  { aborted: true, status: "killed" },
])("keeps terminal $status ahead of retained active cleanup", ({ aborted, status }) => {
  expect(
    buildGatewaySessionSnapshot({
      sessionRow: {
        key: "agent:main:terminal",
        sessionId: "terminal-session",
        kind: "direct",
        updatedAt: 100,
        status: "running",
        startedAt: 100,
      },
      includeSession: true,
      lifecycle: true,
      lifecycleRunId: "terminal-run",
      activeRunState: { active: true, status: "queued" },
      event: {
        runId: "terminal-run",
        sessionId: "terminal-session",
        seq: 1,
        ts: 200,
        stream: "lifecycle",
        data: { phase: "end", startedAt: 100, endedAt: 200, aborted },
      },
    }),
  ).toMatchObject({ status, hasActiveRun: true, session: { status, hasActiveRun: true } });
});
