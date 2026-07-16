import { describe, expect, it, vi } from "vitest";

const runMatrixQaLive = vi.hoisted(() => vi.fn());

vi.mock("./runners/contract/runtime.js", () => ({
  runMatrixQaLive,
}));

import { runQaMatrixCommand } from "./cli.runtime.js";

describe("matrix qa cli runtime", () => {
  it("rejects non-env credential sources for the disposable Matrix lane", async () => {
    await expect(
      runQaMatrixCommand({
        credentialSource: "convex",
      }),
    ).rejects.toThrow("Matrix QA currently supports only --credential-source env");
  });

  it("passes through default env credential source options", async () => {
    runMatrixQaLive.mockResolvedValue({
      reportPath: "/tmp/matrix-report.md",
      summaryPath: "/tmp/matrix-summary.json",
      observedEventsPath: "/tmp/matrix-events.json",
    });

    await runQaMatrixCommand({
      repoRoot: "/tmp/openclaw",
      outputDir: ".artifacts/qa-e2e/matrix",
      providerMode: "mock-openai",
      credentialSource: "env",
    });

    expect(runMatrixQaLive).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: "/tmp/openclaw",
        outputDir: "/tmp/openclaw/.artifacts/qa-e2e/matrix",
        providerMode: "mock-openai",
        credentialSource: "env",
      }),
    );
  });
});
