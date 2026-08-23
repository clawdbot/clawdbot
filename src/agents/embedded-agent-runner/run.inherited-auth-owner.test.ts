import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { listAgentIds } from "../agent-scope-config.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedAcquireAgentRunPreparedModelRuntime,
  mockedBuildEmbeddedRunPayloads,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
} from "./run.overflow-compaction.harness.js";

function projectSetupExecutionConfig(source: OpenClawConfig): OpenClawConfig {
  return {
    ...source,
    agents: {
      ...source.agents,
      entries: {
        ...(source.agents?.entries ?? { main: {} }),
        openclaw: {},
      },
    },
  };
}

describe("embedded setup inference inherited auth owner", () => {
  it.each([
    { name: "a pre-roster config", source: {} },
    { name: "a sole-agent config", source: { agents: { entries: { main: {} } } } },
  ] satisfies Array<{ name: string; source: OpenClawConfig }>)(
    "prepares the explicit main agent from $name",
    async ({ name, source }) => {
      const config = projectSetupExecutionConfig(source);
      expect(listAgentIds(config)).toEqual(["main", "openclaw"]);

      const { runEmbeddedAgent } = await loadRunOverflowCompactionHarness();
      mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "OK" }]);
      mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ assistantTexts: ["OK"] }));

      await runEmbeddedAgent({
        ...overflowBaseRunParams,
        agentId: "main",
        config,
        runId: `run-setup-inference-owner-${name}`,
      });

      const preparedInput = mockedAcquireAgentRunPreparedModelRuntime.mock.calls[0]?.[0];
      expect(preparedInput).toMatchObject({ agentId: "main", config });
      expect(String(preparedInput?.inheritedAuthDir)).toSatisfy((value: string) =>
        value.endsWith(path.join("agents", "main", "agent")),
      );
      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
    },
  );
});
