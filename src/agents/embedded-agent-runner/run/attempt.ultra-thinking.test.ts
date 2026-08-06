// Coverage for keeping Ultra logical until the embedded runtime/provider boundary.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt.spawn-workspace.test-support.js";

const hoisted = getHoisted();
const tempPaths: string[] = [];

beforeAll(async () => {
  await preloadRunEmbeddedAttemptForTests();
});

beforeEach(() => {
  resetEmbeddedAttemptHarness();
});

afterEach(async () => {
  await cleanupTempPaths(tempPaths);
  vi.restoreAllMocks();
});

describe("runEmbeddedAttempt Ultra thinking", () => {
  it("enables proactive prompting while giving agent-core max effort", async () => {
    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: "agent:main:main",
      tempPaths,
      attemptOverrides: {
        disableTools: false,
        thinkLevel: "ultra",
      },
    });

    const promptInput = hoisted.embeddedSystemPromptInputs.at(-1) as {
      defaultThinkLevel?: string;
      proactiveSubagentOrchestration?: boolean;
    };
    const sessionOptions = hoisted.createAgentSessionMock.mock.calls.at(-1)?.[0] as {
      thinkingLevel?: string;
    };
    const providerThinkingLevel = hoisted.applyExtraParamsToAgentMock.mock.calls.at(-1)?.[5];

    expect(promptInput.defaultThinkLevel).toBe("ultra");
    expect(promptInput.proactiveSubagentOrchestration).toBe(true);
    expect(sessionOptions.thinkingLevel).toBe("max");
    expect(providerThinkingLevel).toBe("max");
  });

  it("keeps explicit max at max without enabling proactive prompting", async () => {
    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: "agent:main:main",
      tempPaths,
      attemptOverrides: {
        disableTools: false,
        thinkLevel: "max",
      },
    });

    const promptInput = hoisted.embeddedSystemPromptInputs.at(-1) as {
      defaultThinkLevel?: string;
      proactiveSubagentOrchestration?: boolean;
    };
    const sessionOptions = hoisted.createAgentSessionMock.mock.calls.at(-1)?.[0] as {
      thinkingLevel?: string;
    };
    const providerThinkingLevel = hoisted.applyExtraParamsToAgentMock.mock.calls.at(-1)?.[5];

    expect(promptInput.defaultThinkLevel).toBe("max");
    expect(promptInput.proactiveSubagentOrchestration).toBe(false);
    expect(sessionOptions.thinkingLevel).toBe("max");
    expect(providerThinkingLevel).toBe("max");
  });
});
