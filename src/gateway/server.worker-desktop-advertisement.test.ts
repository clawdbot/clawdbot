// Gateway startup advertisement tests for the cloud-worker Desktop Labs gate.
import { describe, expect, it } from "vitest";
import { writeConfigFile } from "../config/config.js";
import { connectOk, installGatewayTestHooks, startServerWithClient } from "./test-helpers.js";

installGatewayTestHooks();

describe("cloud worker desktop method advertisement", () => {
  it.each([
    { desktop: undefined, advertised: false },
    { desktop: true, advertised: true },
  ])("advertises desktop methods only when the Labs gate is $desktop", async (testCase) => {
    process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
    await writeConfigFile({
      cloudWorkers: {
        ...(testCase.desktop === undefined ? {} : { desktop: testCase.desktop }),
        profiles: {
          development: {
            provider: "test-worker-provider",
            settings: {},
          },
        },
      },
    });
    const { server, ws } = await startServerWithClient(undefined, { auth: { mode: "none" } });
    try {
      const hello = await connectOk(ws);
      const methods = (hello as { features?: { methods?: string[] } }).features?.methods ?? [];

      expect(methods).toContain("sessions.dispatch");
      expect(methods.includes("worker.desktop.observe")).toBe(testCase.advertised);
      expect(methods.includes("worker.desktop.launch")).toBe(testCase.advertised);
    } finally {
      ws.close();
      await server.close();
    }
  });
});
