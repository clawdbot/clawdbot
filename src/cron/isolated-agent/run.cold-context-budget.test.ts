// Cold-path coverage for isolated cron finalization: a bundled-catalog model
// run without runtime context metadata must persist the bundled catalog
// budget instead of the generic 200k default (#127239).
import { describe, expect, it } from "vitest";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  mockRunCronFallbackPassthrough,
  resolveAllowedModelRefMock,
  resolveConfiguredModelRefMock,
  resolveContextTokenBudgetForModelMock,
  resolveCronSessionMock,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn — cold context budget finalization", () => {
  setupRunCronIsolatedAgentTurnSuite({ fast: true });

  it("persists the bundled catalog budget when the run reports no runtime context tokens", async () => {
    mockRunCronFallbackPassthrough();
    const cronSession = makeCronSession();
    resolveCronSessionMock.mockReturnValue(cronSession);
    runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "cron output" }],
      meta: {
        agentMeta: {
          sessionId: cronSession.sessionEntry.sessionId,
          provider: "deepseek",
          model: "deepseek-v4-flash",
        },
      },
    });
    resolveContextTokenBudgetForModelMock.mockResolvedValue({
      contextTokens: 1_000_000,
      source: "model",
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          payload: { kind: "agentTurn", message: "Run the nightly task." },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(resolveContextTokenBudgetForModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "deepseek",
        model: "deepseek-v4-flash",
        allowAsyncLoad: false,
      }),
    );
    expect(cronSession.sessionEntry.contextTokens).toBe(1_000_000);
    expect(cronSession.sessionEntry.contextTokensSource).toBe("resolved-v1");
  });

  it("preserves an exact persisted resolution when current model resolution is unavailable", async () => {
    mockRunCronFallbackPassthrough();
    const selection = { provider: "deepseek", model: "deepseek-v4-flash" };
    resolveConfiguredModelRefMock.mockReturnValue(selection);
    resolveAllowedModelRefMock.mockReturnValue({ ref: selection });
    const cronSession = makeCronSession();
    cronSession.sessionEntry.modelProvider = "deepseek";
    cronSession.sessionEntry.model = "deepseek-v4-flash";
    cronSession.sessionEntry.agentHarnessId = "openclaw";
    cronSession.sessionEntry.contextTokens = 654_321;
    cronSession.sessionEntry.contextTokensSource = "resolved-v1";
    resolveCronSessionMock.mockReturnValue(cronSession);
    runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "cron output" }],
      meta: {
        agentMeta: {
          sessionId: cronSession.sessionEntry.sessionId,
          provider: "deepseek",
          model: "deepseek-v4-flash",
          agentHarnessId: "openclaw",
        },
      },
    });
    resolveContextTokenBudgetForModelMock.mockResolvedValue(undefined);

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          payload: { kind: "agentTurn", message: "Run the nightly task." },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(cronSession.sessionEntry.contextTokens).toBe(654_321);
    expect(cronSession.sessionEntry.contextTokensSource).toBe("resolved-v1");
    expect(resolveContextTokenBudgetForModelMock).toHaveBeenCalledWith(
      expect.objectContaining({ allowUnscopedModelLookup: false }),
    );
  });

  it("keeps the generic default when neither the catalog nor config resolve the model", async () => {
    mockRunCronFallbackPassthrough();
    const cronSession = makeCronSession();
    resolveCronSessionMock.mockReturnValue(cronSession);
    runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "cron output" }],
      meta: {
        agentMeta: {
          sessionId: cronSession.sessionEntry.sessionId,
          provider: "custom-host",
          model: "unknown-model",
        },
      },
    });
    resolveContextTokenBudgetForModelMock.mockResolvedValue(undefined);

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          payload: { kind: "agentTurn", message: "Run the nightly task." },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    // This suite mocks DEFAULT_CONTEXT_TOKENS to 128000; the unresolved model
    // keeps that generic default instead of any bundled catalog row.
    expect(cronSession.sessionEntry.contextTokens).toBe(128_000);
  });
});
