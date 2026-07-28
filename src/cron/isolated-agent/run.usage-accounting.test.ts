import { describe, expect, it } from "vitest";
import { makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  deriveSessionTotalTokensMock,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  mockRunCronFallbackPassthrough,
  resolveCronSessionMock,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn usage accounting", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("uses final-call usage for the stored session token snapshot", async () => {
    const cronSession = makeCronSession();
    resolveCronSessionMock.mockReturnValue(cronSession);
    mockRunCronFallbackPassthrough();
    deriveSessionTotalTokensMock.mockReturnValueOnce(56000);
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "done" }],
      meta: {
        agentMeta: {
          usage: {
            input: 75000,
            output: 2000,
            total: 56000,
            cacheRead: 5000,
            cacheWrite: 0,
          },
          lastCallUsage: {
            input: 55000,
            output: 1000,
            cacheRead: 1000,
            cacheWrite: 0,
          },
        },
      },
    });

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

    expect(result.status).toBe("ok");
    expect(cronSession.sessionEntry.inputTokens).toBe(75000);
    expect(cronSession.sessionEntry.outputTokens).toBe(2000);
    expect(cronSession.sessionEntry.totalTokens).toBe(56000);
    expect(cronSession.sessionEntry.totalTokensFresh).toBe(true);
    expect(result.usage).toMatchObject({
      input_tokens: 75000,
      output_tokens: 2000,
      total_tokens: 82000,
    });
    expect(deriveSessionTotalTokensMock).toHaveBeenCalledWith({
      usage: {
        input: 55000,
        output: 1000,
        cacheRead: 1000,
        cacheWrite: 0,
      },
      contextTokens: 128000,
      promptTokens: undefined,
    });
  });

  it("does not use aggregate usage when final-call usage is empty", async () => {
    const cronSession = makeCronSession();
    resolveCronSessionMock.mockReturnValue(cronSession);
    mockRunCronFallbackPassthrough();
    deriveSessionTotalTokensMock.mockReturnValueOnce(undefined);
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "done" }],
      meta: {
        agentMeta: {
          usage: {
            input: 75000,
            output: 2000,
            cacheRead: 5000,
            cacheWrite: 0,
          },
          lastCallUsage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
      },
    });

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

    expect(result.status).toBe("ok");
    expect(cronSession.sessionEntry.totalTokens).toBeUndefined();
    expect(cronSession.sessionEntry.totalTokensFresh).toBe(false);
    expect(deriveSessionTotalTokensMock).toHaveBeenCalledWith({
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextTokens: 128000,
      promptTokens: undefined,
    });
    expect(deriveSessionTotalTokensMock).toHaveBeenCalledTimes(1);
  });

  it("does not use aggregate usage when final-call usage is output-only", async () => {
    const cronSession = makeCronSession();
    resolveCronSessionMock.mockReturnValue(cronSession);
    mockRunCronFallbackPassthrough();
    deriveSessionTotalTokensMock.mockReturnValueOnce(undefined);
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "done" }],
      meta: {
        agentMeta: {
          usage: { input: 75000, output: 2000 },
          lastCallUsage: { output: 125 },
        },
      },
    });

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

    expect(result.status).toBe("ok");
    expect(cronSession.sessionEntry.totalTokens).toBeUndefined();
    expect(cronSession.sessionEntry.totalTokensFresh).toBe(false);
    expect(deriveSessionTotalTokensMock).toHaveBeenCalledWith({
      usage: { output: 125 },
      contextTokens: 128000,
      promptTokens: undefined,
    });
    expect(deriveSessionTotalTokensMock).toHaveBeenCalledTimes(1);
  });

  it("does not fall back to aggregate billing when final-call context is unavailable", async () => {
    const cronSession = makeCronSession();
    resolveCronSessionMock.mockReturnValue(cronSession);
    mockRunCronFallbackPassthrough();
    deriveSessionTotalTokensMock.mockReturnValueOnce(undefined);
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "done" }],
      meta: {
        agentMeta: {
          usage: {
            input: 12,
            output: 15_104,
            cacheRead: 819_661,
            cacheWrite: 93_130,
            total: 927_907,
          },
          lastCallUsage: {
            input: 12,
            output: 15_104,
            cacheRead: 819_661,
            cacheWrite: 93_130,
            contextUsage: { state: "unavailable" },
            total: 927_907,
          },
        },
      },
    });

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

    expect(result.status).toBe("ok");
    expect(cronSession.sessionEntry.totalTokens).toBeUndefined();
    expect(cronSession.sessionEntry.totalTokensFresh).toBe(false);
    expect(deriveSessionTotalTokensMock).toHaveBeenCalledTimes(1);
  });
});
