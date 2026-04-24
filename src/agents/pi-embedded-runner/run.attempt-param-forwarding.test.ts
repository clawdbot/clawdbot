import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentInternalEvent } from "../internal-events.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedGetApiKeyForModel,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import type { RunEmbeddedPiAgentParams } from "./run/params.js";

type ForwardingCase = {
  runId: string;
  params: Partial<RunEmbeddedPiAgentParams>;
  expected: Record<string, unknown>;
};

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;
const internalEvents: AgentInternalEvent[] = [];
const forwardingCase = {
  runId: "forward-attempt-params",
  params: {
    toolsAllow: ["exec", "read"],
    bootstrapContextMode: "lightweight",
    bootstrapContextRunKind: "cron",
    disableMessageTool: true,
    forceMessageTool: true,
    requireExplicitMessageTarget: true,
    internalEvents,
  },
  expected: {
    toolsAllow: ["exec", "read"],
    bootstrapContextMode: "lightweight",
    bootstrapContextRunKind: "cron",
    disableMessageTool: true,
    forceMessageTool: true,
    requireExplicitMessageTarget: true,
    internalEvents,
  },
} satisfies ForwardingCase;

describe("runEmbeddedPiAgent forwards optional params to runEmbeddedAttempt", () => {
  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
  });

  it("forwards optional attempt params in one attempt call", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      ...forwardingCase.params,
      runId: forwardingCase.runId,
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining(forwardingCase.expected),
    );
  });

  it("lets plugin harnesses own auth before the attempt runs", async () => {
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const pluginRunAttempt = vi.fn(async () => makeAttemptResult({ assistantTexts: ["ok"] }));
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: (ctx) =>
        ctx.provider === "codex" ? { supported: true, priority: 100 } : { supported: false },
      runAttempt: pluginRunAttempt,
    });
    mockedGetApiKeyForModel.mockRejectedValueOnce(new Error("generic auth should be skipped"));

    try {
      await runEmbeddedPiAgent({
        ...overflowBaseRunParams,
        provider: "codex",
        model: "gpt-5.4",
        config: {
          agents: {
            defaults: {
              embeddedHarness: { runtime: "codex", fallback: "none" },
            },
          },
        },
        runId: "plugin-harness-skips-generic-auth",
      });
    } finally {
      clearAgentHarnesses();
    }

    expect(mockedGetApiKeyForModel).not.toHaveBeenCalled();
    expect(pluginRunAttempt).toHaveBeenCalledWith(expect.objectContaining({ provider: "codex" }));
  });
});
