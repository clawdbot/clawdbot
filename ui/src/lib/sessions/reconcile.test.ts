// @vitest-environment node
import { describe, expect, it, test } from "vitest";
import { contextBudgetStatusFixture } from "../../../../src/config/sessions/context-budget.test-support.js";
import type { SessionsListResult } from "../../api/types.ts";
import { resolveChatThinkingSelectState } from "../chat/thinking.ts";
import {
  preserveRosterPresentationMetadata,
  reconcileSessionChanged,
  reconcileSessionHistory,
} from "./reconcile.ts";

function buildResult(sessions: SessionsListResult["sessions"]): SessionsListResult {
  return {
    ts: 1,
    path: "store",
    count: sessions.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
  };
}

describe("preserveRosterPresentationMetadata", () => {
  it("does not preserve presentation metadata without a known matching session identity", () => {
    const key = "agent:main:dashboard:replacement";

    expect(
      preserveRosterPresentationMetadata(
        { key, kind: "direct", sessionId: "replacement-session", updatedAt: 20 },
        {
          key,
          kind: "direct",
          updatedAt: 10,
          derivedTitle: "Previous session title",
          lastMessagePreview: "Previous session preview",
        },
      ),
    ).toEqual({
      key,
      kind: "direct",
      sessionId: "replacement-session",
      updatedAt: 20,
    });
  });

  it("does not infer archive state from row timestamps", () => {
    const key = "agent:main:dashboard:archived";

    expect(
      preserveRosterPresentationMetadata(
        { key, kind: "direct", sessionId: "s1", updatedAt: 10, archived: false },
        {
          key,
          kind: "direct",
          sessionId: "s1",
          updatedAt: 20,
          archived: true,
          archivedAt: 20,
        },
      ),
    ).toEqual({ key, kind: "direct", sessionId: "s1", updatedAt: 10, archived: false });
  });
});

test("sessions.changed removes a label when the event carries null", () => {
  const result: SessionsListResult = {
    ts: 1,
    path: "",
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [
      {
        key: "agent:main:main",
        kind: "global",
        updatedAt: 1,
        label: "Named session",
        displayName: "Named session",
      },
    ],
  };

  const reconciled = reconcileSessionChanged(result, {
    sessionKey: "agent:main:main",
    reason: "patch",
    updatedAt: 2,
    label: null,
    displayName: null,
  });

  expect(reconciled.applied).toBe(true);
  expect(reconciled.result?.sessions[0]?.label).toBeUndefined();
  expect(reconciled.result?.sessions[0]?.displayName).toBeUndefined();
});

test("reconciling the same sessions.changed twice keeps result identity on the second pass", () => {
  const result: SessionsListResult = {
    ts: 1,
    path: "",
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [{ key: "agent:main:main", kind: "direct", updatedAt: 1 }],
  };
  const payload = {
    sessionKey: "agent:main:main",
    reason: "patch",
    ts: 2,
    updatedAt: 2,
    label: "Renamed",
  };

  const first = reconcileSessionChanged(result, payload);
  expect(first.applied).toBe(true);
  expect(first.result).not.toBe(result);
  expect(first.result?.sessions[0]?.label).toBe("Renamed");
  expect(first.result?.ts).toBe(2);

  // The capability handler and the chat page both drive the same event; the
  // second reconcile must return the identical result object so downstream
  // result === state.result publish gates skip the duplicate re-render.
  const second = reconcileSessionChanged(first.result ?? null, payload);
  expect(second.result).toBe(first.result);
});

test("sessions.changed deletes every nested null tombstone, not a hand-kept list", () => {
  // The gateway tombstones more fields than the old per-field cascade knew
  // about; these five leaked literal null into rows typed optional-not-null.
  const result: SessionsListResult = {
    ts: 1,
    path: "",
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [
      {
        key: "agent:main:main",
        kind: "direct",
        updatedAt: 1,
        toolOverrides: { profile: "coding" },
        contextBudgetStatus: contextBudgetStatusFixture(),
        agentStatus: { state: "needs_attention", message: "Reply requested" },
        observerDigest: {
          agentId: "main",
          runId: "run-stale",
          headline: "Waiting",
          health: "needs_attention",
          updatedAt: 1,
          revision: 1,
        },
        controlOwnerSessionKey: "agent:main:owner",
        restartRecoveryStatus: "pending",
        goal: "ship it",
        modelOverrideSource: "user",
      } as never,
    ],
  };

  const reconciled = reconcileSessionChanged(result, {
    sessionKey: "agent:main:main",
    reason: "patch",
    session: {
      key: "agent:main:main",
      kind: "direct",
      updatedAt: 2,
      toolOverrides: null,
      contextBudgetStatus: null,
      agentStatus: null,
      observerDigest: null,
      controlOwnerSessionKey: null,
      restartRecoveryStatus: null,
      goal: null,
      modelOverrideSource: null,
    },
  } as never);

  expect(reconciled.applied).toBe(true);
  const row = reconciled.result?.sessions[0] as Record<string, unknown> | undefined;
  for (const field of [
    "toolOverrides",
    "contextBudgetStatus",
    "agentStatus",
    "observerDigest",
    "controlOwnerSessionKey",
    "restartRecoveryStatus",
    "goal",
  ]) {
    expect(row?.[field], field).toBeUndefined();
  }
  // updatedAt stays legitimately nullable and must not be deleted by the loop.
  expect(row?.updatedAt).toBe(2);
  // Clearing a pin means the gateway confirmed inheritance. Deleting that null would
  // make the row indistinguishable from a gateway too old to report provenance, and
  // the picker would keep showing the cleared pin.
  expect(row?.modelOverrideSource).toBeNull();
});

test("sessions.changed clears exact run ids only for an explicit tombstone", () => {
  const key = "agent:main:main";
  const result = buildResult([
    {
      key,
      kind: "direct",
      updatedAt: 1,
      hasActiveRun: true,
      activeRunIds: ["run-exact"],
    },
  ]);

  const omitted = reconcileSessionChanged(result, {
    sessionKey: key,
    reason: "run-progress",
    updatedAt: 2,
    hasActiveRun: true,
  });
  expect(omitted.row?.activeRunIds).toEqual(["run-exact"]);

  const tombstoned = reconcileSessionChanged(omitted.result, {
    sessionKey: key,
    reason: "run-progress",
    updatedAt: 3,
    hasActiveRun: true,
    activeRunIds: null,
  });
  expect(tombstoned.row?.activeRunIds).toBeUndefined();
});

test("authoritative snapshot omission clears cached exact run ids", () => {
  const key = "agent:main:main";
  const result = buildResult([
    {
      key,
      kind: "direct",
      sessionId: "session-main",
      updatedAt: 1,
      hasActiveRun: true,
      activeRunIds: ["run-stale"],
    },
  ]);

  const reconciled = reconcileSessionHistory(
    result,
    {
      key,
      kind: "direct",
      sessionId: "session-main",
      updatedAt: 2,
      hasActiveRun: true,
    },
    undefined,
  );

  expect(reconciled?.sessions[0]?.activeRunIds).toBeUndefined();
});

test("sessions.changed invalidates the complete owner facet until canonical refresh", () => {
  const key = "agent:main:main";
  const result = buildResult([
    {
      key,
      kind: "global",
      updatedAt: 1,
      createdActor: { type: "human", id: "profile-ada", label: "Ada" },
      owner: { actor: { type: "human", id: "profile-ada", label: "Ada" } },
    },
  ]);
  result.owners = [{ type: "human", id: "profile-ada", label: "Ada" }];

  const reconciled = reconcileSessionChanged(result, {
    sessionKey: key,
    reason: "reset",
    updatedAt: 2,
    createdActor: { type: "human", id: "profile-bob", label: "Bob" },
    owner: { actor: { type: "human", id: "profile-bob", label: "Bob" } },
  });

  expect(reconciled.result?.sessions[0]?.createdActor?.id).toBe("profile-bob");
  expect(reconciled.result?.owners).toBeUndefined();
});

test("sessions.changed preserves the owner facet when ownership is unchanged", () => {
  const key = "agent:main:main";
  const createdActor = { type: "human" as const, id: "profile-ada", label: "Ada" };
  const result = buildResult([
    { key, kind: "global", updatedAt: 1, createdActor, owner: { actor: createdActor } },
  ]);
  result.owners = [{ type: createdActor.type, id: createdActor.id, label: createdActor.label }];

  const reconciled = reconcileSessionChanged(result, {
    sessionKey: key,
    reason: "send",
    updatedAt: 2,
    createdActor,
    owner: { actor: createdActor },
  });

  expect(reconciled.result?.owners).toEqual([
    { type: createdActor.type, id: createdActor.id, label: createdActor.label },
  ]);
});

test("sessions.changed applies reassignment and invalidates the complete owner facet", () => {
  const key = "agent:main:main";
  const createdActor = { type: "human" as const, id: "profile-ada", label: "Ada" };
  const result = buildResult([
    { key, kind: "global", updatedAt: 1, createdActor, owner: { actor: createdActor } },
  ]);
  result.owners = [{ type: createdActor.type, id: createdActor.id, label: createdActor.label }];

  const reconciled = reconcileSessionChanged(result, {
    sessionKey: key,
    reason: "owner",
    updatedAt: 1,
    owner: {
      actor: { type: "agent", id: "research", label: "Research" },
      assignedBy: createdActor,
      assignedAt: 2,
    },
  });

  expect(reconciled.result?.sessions[0]?.owner).toMatchObject({
    actor: { id: "research" },
    assignedAt: 2,
  });
  expect(reconciled.result?.owners).toBeUndefined();
});

test("ownerless raw-global events invalidate without contaminating the selected agent row", () => {
  const researchOwner = { type: "agent" as const, id: "research", label: "Research" };
  const result = buildResult([
    {
      key: "global",
      kind: "global",
      updatedAt: 1,
      owner: { actor: researchOwner },
      model: "research-model",
      status: "done",
      hasActiveRun: false,
      activeRunIds: [],
    },
  ]);
  const payload = {
    sessionKey: "global",
    reason: "updated",
    updatedAt: 2,
    owner: { actor: { type: "agent", id: "ops", label: "Ops" } },
    model: "ops-model",
    status: "running",
    hasActiveRun: true,
    activeRunIds: ["ops-run"],
    inputTokens: 42,
  };

  const invalidated = reconcileSessionChanged(result, payload, {
    resultAgentId: "research",
    selectedGlobalAgentId: "research",
  });

  expect(invalidated.applied).toBe(false);
  expect(invalidated.result).toBe(result);
  expect(invalidated.row).toBeUndefined();

  const mainResult = buildResult([{ key: "main", kind: "direct", updatedAt: 1, status: "done" }]);
  const invalidatedMain = reconcileSessionChanged(
    mainResult,
    { sessionKey: "main", reason: "delete", ts: 2 },
    { resultAgentId: "main", selectedGlobalAgentId: "main" },
  );
  expect(invalidatedMain.applied).toBe(false);
  expect(invalidatedMain.result).toBe(mainResult);

  const ownerlessMain = reconcileSessionChanged(
    mainResult,
    {
      sessionKey: "main",
      activeRunIds: ["main-run"],
      hasActiveRun: true,
      status: "running",
      updatedAt: 2,
    },
    { resultAgentId: "main", selectedGlobalAgentId: "main" },
  );
  expect(ownerlessMain.applied).toBe(true);
  expect(ownerlessMain.row).toMatchObject({
    key: "main",
    activeRunIds: ["main-run"],
    hasActiveRun: true,
    status: "running",
  });
  expect(ownerlessMain.row).not.toHaveProperty("agentId");

  const explicit = reconcileSessionChanged(
    result,
    { ...payload, agentId: "research" },
    {
      resultAgentId: "research",
      selectedGlobalAgentId: "research",
    },
  );
  expect(explicit.applied).toBe(true);
  expect(explicit.row).toMatchObject({
    owner: { actor: { id: "ops" } },
    model: "ops-model",
    status: "running",
    activeRunIds: ["ops-run"],
  });
});

describe("reconcileSessionChanged", () => {
  it.each([
    { name: "inherited Medium", thinkingDefault: "medium", thinkingLevel: undefined },
    { name: "configured Off", thinkingDefault: "off", thinkingLevel: undefined },
    { name: "explicit Off", thinkingDefault: "medium", thinkingLevel: "off" },
  ])(
    "preserves $name when history omits prepared thinking metadata",
    ({ thinkingDefault, thinkingLevel }) => {
      const identity = {
        modelProvider: "test-provider",
        model: "reasoning-model",
        agentRuntime: { id: "openclaw", source: "model" as const },
      };
      const row = {
        ...identity,
        key: "agent:main:main",
        kind: "direct" as const,
        sessionId: "s1",
        updatedAt: 1,
        thinkingLevel,
      };
      const metadata = {
        thinkingDefault,
        thinkingLevels: [
          { id: "off", label: "off" },
          { id: "medium", label: "medium" },
        ],
        thinkingOptions: ["off", "medium"],
      };
      const current = {
        ...buildResult([{ ...row, ...metadata }]),
        defaults: { ...identity, ...metadata, contextTokens: null },
      };
      const next = reconcileSessionHistory(
        current,
        { ...row, updatedAt: 2 },
        { ...identity, contextTokens: null },
      );

      expect(next?.sessions[0]).toMatchObject(metadata);
      expect(next?.defaults).toMatchObject(metadata);
      expect(next?.sessions[0]?.thinkingLevel).toBe(thinkingLevel);
      expect(
        resolveChatThinkingSelectState({
          catalog: [],
          sessionKey: row.key,
          sessionsResult: next,
        }).selection,
      ).toMatchObject({
        source: thinkingLevel === undefined ? "default" : "override",
        value: thinkingLevel ?? thinkingDefault,
      });
    },
  );

  it("drops a cleared category from the merged row", () => {
    const key = "agent:main:discord:channel:1";
    const result = buildResult([
      { key, kind: "group", updatedAt: 1, sessionId: "s1", category: "Research" },
    ]);
    const next = reconcileSessionChanged(result, {
      sessionKey: key,
      key,
      kind: "group",
      updatedAt: 2,
      sessionId: "s1",
      category: null,
    });
    expect(next.applied).toBe(true);
    expect(next.row?.category).toBeUndefined();
  });

  it("applies an updated category to the merged row", () => {
    const key = "agent:main:discord:channel:1";
    const result = buildResult([{ key, kind: "group", updatedAt: 1, sessionId: "s1" }]);
    const next = reconcileSessionChanged(result, {
      sessionKey: key,
      key,
      kind: "group",
      updatedAt: 2,
      sessionId: "s1",
      category: "Research",
    });
    expect(next.applied).toBe(true);
    expect(next.row?.category).toBe("Research");
  });

  it("replaces thinking metadata when the same model changes runtime", () => {
    const key = "agent:main:main";
    const result = buildResult([
      {
        key,
        kind: "global",
        updatedAt: 1,
        sessionId: "s1",
        modelProvider: "openai",
        model: "gpt-5.6-luna",
        agentRuntime: { id: "openclaw", source: "model" },
        thinkingLevels: [
          { id: "max", label: "max" },
          { id: "ultra", label: "ultra" },
        ],
        thinkingOptions: ["max", "ultra"],
      },
    ]);
    const next = reconcileSessionChanged(result, {
      sessionKey: key,
      key,
      kind: "global",
      updatedAt: 2,
      sessionId: "s1",
      modelProvider: "openai",
      model: "gpt-5.6-luna",
      agentRuntime: { id: "codex", source: "session-key" },
      thinkingLevels: [{ id: "max", label: "max" }],
      thinkingOptions: ["max"],
    });

    expect(next.row?.agentRuntime?.id).toBe("codex");
    expect(next.row?.thinkingLevels).toEqual([{ id: "max", label: "max" }]);
    expect(next.row?.thinkingOptions).toEqual(["max"]);
  });

  it("drops stale picker metadata when a runtime-change event omits catalog fields", () => {
    const key = "agent:main:main";
    const result = buildResult([
      {
        key,
        kind: "global",
        updatedAt: 1,
        sessionId: "s1",
        modelProvider: "openai",
        model: "gpt-5.6-luna",
        agentRuntime: { id: "openclaw", source: "model" },
        thinkingLevels: [
          { id: "max", label: "max" },
          { id: "ultra", label: "ultra" },
        ],
        thinkingOptions: ["max", "ultra"],
        thinkingDefault: "medium",
      },
    ]);

    const next = reconcileSessionChanged(result, {
      sessionKey: key,
      key,
      kind: "global",
      updatedAt: 2,
      sessionId: "s1",
      modelProvider: "openai",
      model: "gpt-5.6-luna",
      agentRuntime: { id: "codex", source: "session-key" },
    });

    expect(next.row?.agentRuntime?.id).toBe("codex");
    expect(next.row?.thinkingLevels).toBeUndefined();
    expect(next.row?.thinkingOptions).toBeUndefined();
    expect(next.row?.thinkingDefault).toBeUndefined();
  });

  it("does not let stale chat history overwrite a newer runtime switch", () => {
    const key = "agent:main:main";
    const current = buildResult([
      {
        key,
        kind: "global",
        updatedAt: 3,
        sessionId: "s1",
        modelProvider: "openai",
        model: "gpt-5.6-luna",
        agentRuntime: { id: "codex", source: "session-key" },
        thinkingLevels: [{ id: "max", label: "max" }],
      },
    ]);

    const next = reconcileSessionHistory(
      current,
      {
        key,
        kind: "global",
        updatedAt: 2,
        sessionId: "s1",
        modelProvider: "openai",
        model: "gpt-5.6-luna",
        agentRuntime: { id: "openclaw", source: "session-key" },
        thinkingLevels: [
          { id: "max", label: "max" },
          { id: "ultra", label: "ultra" },
        ],
      },
      undefined,
    );

    expect(next).toBe(current);
  });

  it("replaces same-model defaults when their runtime changes", () => {
    const key = "agent:main:main";
    const result: SessionsListResult = {
      ...buildResult([{ key, kind: "global", updatedAt: 1, sessionId: "s1" }]),
      defaults: {
        modelProvider: "openai",
        model: "gpt-5.6-luna",
        contextTokens: null,
        agentRuntime: { id: "openclaw", source: "model" },
        thinkingLevels: [
          { id: "max", label: "max" },
          { id: "ultra", label: "ultra" },
        ],
      },
    };

    const next = reconcileSessionHistory(
      result,
      { key, kind: "global", updatedAt: 1, sessionId: "s1" },
      {
        modelProvider: "openai",
        model: "gpt-5.6-luna",
        contextTokens: null,
        agentRuntime: { id: "codex", source: "model" },
        thinkingLevels: [{ id: "max", label: "max" }],
      },
    );

    expect(next?.defaults.agentRuntime?.id).toBe("codex");
    expect(next?.defaults.thinkingLevels).toEqual([{ id: "max", label: "max" }]);
  });

  it("preserves catalog-backed options when an event omits picker metadata", () => {
    const key = "agent:main:main";
    const thinkingLevels = [
      { id: "max", label: "max" },
      { id: "ultra", label: "ultra" },
    ];
    const result = buildResult([
      {
        key,
        kind: "global",
        updatedAt: 1,
        sessionId: "s1",
        modelProvider: "openai",
        model: "gpt-5.6-sol",
        agentRuntime: { id: "codex", source: "model" },
        thinkingLevels,
        thinkingOptions: ["max", "ultra"],
      },
    ]);
    const next = reconcileSessionChanged(result, {
      sessionKey: key,
      key,
      kind: "global",
      updatedAt: 2,
      sessionId: "s1",
      thinkingLevel: "ultra",
      agentRuntime: { id: "codex", source: "model" },
    });

    expect(next.row?.thinkingLevel).toBe("ultra");
    expect(next.row?.thinkingLevels).toEqual(thinkingLevels);
    expect(next.row?.thinkingOptions).toEqual(["max", "ultra"]);
  });

  it("clears a thinking override when the event carries null", () => {
    const key = "agent:main:main";
    const result = buildResult([
      {
        key,
        kind: "global",
        updatedAt: 1,
        sessionId: "s1",
        thinkingLevel: "ultra",
      },
    ]);
    const next = reconcileSessionChanged(result, {
      sessionKey: key,
      key,
      kind: "global",
      updatedAt: 2,
      sessionId: "s1",
      thinkingLevel: null,
    });

    expect(next.row?.thinkingLevel).toBeUndefined();
  });

  it("keeps archive-state changes in an all-status result", () => {
    const key = "agent:main:thread";
    const result = buildResult([{ key, kind: "direct", updatedAt: 1, sessionId: "s1" }]);

    const next = reconcileSessionHistory(
      result,
      { key, kind: "direct", updatedAt: 2, sessionId: "s1", archived: true },
      undefined,
      { archivedFilter: "all" },
    );

    expect(next?.sessions).toEqual([
      expect.objectContaining({ key, archived: true, updatedAt: 2 }),
    ]);
  });

  it("clears archive attribution when an unarchive event arrives", () => {
    const key = "agent:main:thread";
    const result = buildResult([
      {
        key,
        kind: "direct",
        updatedAt: 1,
        sessionId: "s1",
        archived: true,
        archivedAt: 1,
        archivedBy: { type: "human", id: "profile-ada", label: "Ada" },
        archiveReason: "manual",
      },
    ]);

    const next = reconcileSessionChanged(
      result,
      {
        sessionKey: key,
        key,
        kind: "direct",
        updatedAt: 2,
        sessionId: "s1",
        archived: false,
        archivedAt: null,
        archivedBy: null,
        archiveReason: null,
      },
      { archivedFilter: "all" },
    );

    expect(next.row?.archivedBy).toBeUndefined();
    expect(next.row?.archiveReason).toBeUndefined();
    expect(next.result?.sessions[0]?.archivedBy).toBeUndefined();
    expect(next.result?.sessions[0]?.archiveReason).toBeUndefined();
  });
});

describe("reconcileSessionHistory", () => {
  it("preserves roster-derived presentation fields during targeted history hydration", () => {
    const key = "agent:main:dashboard:session-1";
    const result = buildResult([
      {
        key,
        kind: "direct",
        sessionId: "session-1",
        updatedAt: 1,
        derivedTitle: "Readable planning title",
        lastMessagePreview: "Latest visible reply",
      },
    ]);

    const reconciled = reconcileSessionHistory(
      result,
      {
        key,
        kind: "direct",
        sessionId: "session-1",
        updatedAt: 2,
        status: "running",
      },
      undefined,
    );

    expect(reconciled?.sessions[0]).toMatchObject({
      key,
      updatedAt: 2,
      status: "running",
      derivedTitle: "Readable planning title",
      lastMessagePreview: "Latest visible reply",
    });
  });

  it("does not preserve roster presentation fields across a session reset", () => {
    const key = "agent:main:dashboard:session";
    const result = buildResult([
      {
        key,
        kind: "direct",
        sessionId: "session-1",
        updatedAt: 1,
        derivedTitle: "Previous session title",
      },
    ]);

    const reconciled = reconcileSessionHistory(
      result,
      {
        key,
        kind: "direct",
        sessionId: "session-2",
        updatedAt: 2,
      },
      undefined,
    );

    expect(reconciled?.sessions[0]).toMatchObject({ sessionId: "session-2", updatedAt: 2 });
    expect(reconciled?.sessions[0]?.derivedTitle).toBeUndefined();
  });
});

test.each([undefined, "generation-a", "generation-b"])(
  "delete reconciliation removes only the event generation (%s)",
  (sessionId) => {
    const row = {
      key: "agent:main:recreated",
      sessionId: "generation-b",
      kind: "direct" as const,
      updatedAt: 2,
    };
    const result = {
      ts: 2,
      path: "",
      count: 1,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [row],
    };
    const reconciled = reconcileSessionChanged(result, {
      sessionKey: row.key,
      agentId: "main",
      reason: "delete",
      sessionId,
    });
    expect(reconciled.result?.sessions).toEqual(sessionId === row.sessionId ? [] : [row]);
    expect(reconciled.deletedKey).toBe(sessionId === row.sessionId ? row.key : undefined);
  },
);
