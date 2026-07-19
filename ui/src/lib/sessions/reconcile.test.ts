import { describe, expect, it, test } from "vitest";
import type { SessionsListResult } from "../../api/types.ts";
import { reconcileSessionChanged, reconcileSessionHistory } from "./reconcile.ts";

function buildResult(sessions: SessionsListResult["sessions"]): SessionsListResult {
  return {
    ts: 1,
    path: "store",
    count: sessions.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
  };
}

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

describe("reconcileSessionChanged", () => {
  it("drops a cleared icon from the merged row", () => {
    const key = "agent:main:main";
    const result = buildResult([
      { key, kind: "global", updatedAt: 1, sessionId: "s1", icon: "name:spark" },
    ]);
    const next = reconcileSessionChanged(result, {
      sessionKey: key,
      key,
      kind: "global",
      updatedAt: 2,
      sessionId: "s1",
      icon: null,
    });
    expect(next.applied).toBe(true);
    expect(next.row?.icon).toBeUndefined();
  });

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
});
