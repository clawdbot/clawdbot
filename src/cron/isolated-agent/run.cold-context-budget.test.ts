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
  resolveBundledStaticCatalogContextMock,
  resolveContextTokensForModelMock,
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
    resolveBundledStaticCatalogContextMock.mockResolvedValue({ modelContextWindow: 1_000_000 });
    // Mirror the real resolver for a catalog-only model: the injected bundled
    // window is the resolution result.
    resolveContextTokensForModelMock.mockImplementation(
      (params: { modelContextWindow?: number }) => params.modelContextWindow,
    );

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          payload: { kind: "agentTurn", message: "Run the nightly task." },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(resolveBundledStaticCatalogContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "deepseek",
        model: "deepseek-v4-flash",
      }),
    );
    expect(resolveContextTokensForModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "deepseek",
        model: "deepseek-v4-flash",
        modelContextWindow: 1_000_000,
        allowAsyncLoad: false,
      }),
    );
    expect(cronSession.sessionEntry.contextTokens).toBe(1_000_000);
    expect(cronSession.sessionEntry.contextTokensSource).toBe("resolved-v1");
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
    resolveBundledStaticCatalogContextMock.mockResolvedValue(undefined);
    resolveContextTokensForModelMock.mockReturnValue(undefined);

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
