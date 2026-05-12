import { describe, expect, it, vi } from "vitest";
import { runGatewayHttpRequestStages } from "./server-http.js";

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
    const stageC = vi.fn(() => true);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const stages = [
      { name: "a", run: () => false },
      {
        name: "broken-facade",
        continueOnError: true,
        run: () => {
          throw stageError;
        },
      },
      { name: "c", run: stageC },
    ];

    const result = await runGatewayHttpRequestStages(stages);

    expect(result).toBe(true);
    expect(stageC).toHaveBeenCalled();
    expect(consoleSpy.mock.calls).toEqual([
      ['[gateway-http] stage "broken-facade" threw — skipping:', stageError],
    ]);

    consoleSpy.mockRestore();
  });

  it("skips a rejecting async stage marked continueOnError and continues", async () => {
    const stageError = new Error("ERR_MODULE_NOT_FOUND");
    const stageC = vi.fn(() => true);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const stages = [
      {
        name: "async-broken",
        continueOnError: true,
        run: async () => {
          throw stageError;
        },
      },
      { name: "c", run: stageC },
    ];

    const result = await runGatewayHttpRequestStages(stages);

    expect(result).toBe(true);
    expect(stageC).toHaveBeenCalled();
    expect(consoleSpy.mock.calls).toEqual([
      ['[gateway-http] stage "async-broken" threw — skipping:', stageError],
    ]);

    consoleSpy.mockRestore();
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
