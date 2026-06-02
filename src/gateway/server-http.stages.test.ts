import { describe, expect, it, vi } from "vitest";
import { runGatewayHttpRequestStages } from "./server-http.js";

type TestGatewayHttpRequestStage = Parameters<typeof runGatewayHttpRequestStages>[0][number];

async function expectContinueOnErrorStageSkips(params: {
  stageName: string;
  stageError: Error;
  stageRun: TestGatewayHttpRequestStage["run"];
  prefixStages?: TestGatewayHttpRequestStage[];
}): Promise<void> {
  const stageC = vi.fn(() => true);
  const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const result = await runGatewayHttpRequestStages([
      ...(params.prefixStages ?? []),
      {
        name: params.stageName,
        continueOnError: true,
        run: params.stageRun,
      },
      { name: "c", run: stageC },
    ]);

    expect(result).toBe(true);
    expect(stageC).toHaveBeenCalled();
    expect(consoleSpy.mock.calls).toEqual([
      [`[gateway-http] stage "${params.stageName}" threw — skipping:`, params.stageError],
    ]);
  } finally {
    consoleSpy.mockRestore();
  }
}

describe("runGatewayHttpRequestStages", () => {
  it("returns true when a stage handles the request", async () => {
    const stages = [
      { name: "a", run: () => false },
      { name: "b", run: () => true },
      { name: "c", run: () => false },
    ];
    expect(await runGatewayHttpRequestStages(stages)).toBe(true);
  });

  it("returns false when no stage handles the request", async () => {
    const stages = [
      { name: "a", run: () => false },
      { name: "b", run: () => false },
    ];
    expect(await runGatewayHttpRequestStages(stages)).toBe(false);
  });

  it("skips a throwing stage marked continueOnError and continues to subsequent stages", async () => {
    const stageError = new Error("Cannot find module '@slack/bolt'");
    await expectContinueOnErrorStageSkips({
      stageName: "broken-facade",
      stageError,
      stageRun: () => {
        throw stageError;
      },
      prefixStages: [{ name: "a", run: () => false }],
    });
  });

  it("skips a rejecting async stage marked continueOnError and continues", async () => {
    const stageError = new Error("ERR_MODULE_NOT_FOUND");
    await expectContinueOnErrorStageSkips({
      stageName: "async-broken",
      stageError,
      stageRun: async () => {
        throw stageError;
      },
    });
  });

  it("rethrows when a stage throws without continueOnError", async () => {
    const stages = [
      {
        name: "broken",
        run: () => {
          throw new Error("load failed");
        },
      },
      { name: "unmatched", run: () => false },
    ];

    await expect(runGatewayHttpRequestStages(stages)).rejects.toThrow("load failed");
  });
});
