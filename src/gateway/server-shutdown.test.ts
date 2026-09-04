import { describe, expect, it, vi } from "vitest";
import { resolveGatewayShutdownNotice, runGatewayShutdownSteps } from "./server-shutdown.js";

describe("gateway shutdown notice", () => {
  it("omits invalid restart metadata and normalizes the reason", () => {
    expect(
      resolveGatewayShutdownNotice({ reason: "  upgrade  ", restartExpectedMs: Number.NaN }),
    ).toEqual({
      reason: "upgrade",
    });
    expect(resolveGatewayShutdownNotice({ restartExpectedMs: -2 })).toEqual({
      reason: "gateway stopping",
      restartExpectedMs: 0,
    });
  });
});

describe("gateway shutdown steps", () => {
  it.each([false, true])(
    "retains prior failures and respects a required join (failure: %s)",
    async (joinFails) => {
      const stopError = new Error("optional sidecar stop failed");
      const drainError = new Error("connection cleanup failed");
      const closeDependencies = vi.fn();
      const drain = vi.fn(async () => {
        if (joinFails) {
          throw drainError;
        }
      });
      const onError = vi.fn();
      await expect(
        runGatewayShutdownSteps({
          steps: [
            {
              name: "optional sidecars",
              run: () => {
                throw stopError;
              },
            },
            { name: "received connection work", run: drain, required: true },
            { name: "state dependencies", run: closeDependencies },
          ],
          onError,
        }),
      ).rejects.toMatchObject({
        errors: [
          {
            message: "shutdown step failed (optional sidecars): optional sidecar stop failed",
            cause: stopError,
          },
          ...(joinFails
            ? [
                {
                  message:
                    "shutdown step failed (received connection work): connection cleanup failed",
                  cause: drainError,
                },
              ]
            : []),
        ],
      });
      expect(drain).toHaveBeenCalledOnce();
      expect(closeDependencies).toHaveBeenCalledTimes(joinFails ? 0 : 1);
      expect(onError).toHaveBeenCalledTimes(joinFails ? 2 : 1);
    },
  );

  it("names an unavailable module step and continues the remaining shutdown", async () => {
    const missingModule = Object.assign(new Error("Cannot find module 'rotated-chunk.js'"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    const loadStopModule = vi.fn(async () => {
      throw missingModule;
    });
    const closeGateway = vi.fn(async () => {});
    const messages: string[] = [];

    await expect(
      runGatewayShutdownSteps({
        steps: [
          { name: "gateway lifetime sidecars", run: loadStopModule },
          { name: "gateway close", run: closeGateway },
        ],
        onError: (message) => messages.push(message),
      }),
    ).rejects.toMatchObject({
      message: "Gateway shutdown did not complete cleanly",
      errors: [expect.objectContaining({ cause: missingModule })],
    });

    expect(closeGateway).toHaveBeenCalledOnce();
    expect(messages).toEqual([
      "shutdown step failed (gateway lifetime sidecars): Cannot find module 'rotated-chunk.js'",
    ]);
    expect(messages.join("\n")).not.toContain("shutdown error");
  });
});
