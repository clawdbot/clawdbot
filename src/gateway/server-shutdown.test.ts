import { describe, expect, it, vi } from "vitest";
import { runGatewayShutdownSteps } from "./server-shutdown.js";

describe("gateway shutdown steps", () => {
  it("names an unavailable module step and continues the remaining shutdown", async () => {
    const missingModule = Object.assign(new Error("Cannot find module 'rotated-chunk.js'"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    const loadStopModule = vi.fn(async () => {
      throw missingModule;
    });
    const closeGateway = vi.fn(async () => {});
    const messages: string[] = [];

    await runGatewayShutdownSteps({
      steps: [
        { name: "gateway lifetime sidecars", run: loadStopModule },
        { name: "gateway close", run: closeGateway },
      ],
      onError: (message) => messages.push(message),
    });

    expect(closeGateway).toHaveBeenCalledOnce();
    expect(messages).toEqual([
      "shutdown step failed (gateway lifetime sidecars): Cannot find module 'rotated-chunk.js'",
    ]);
    expect(messages.join("\n")).not.toContain("shutdown error");
  });
});
