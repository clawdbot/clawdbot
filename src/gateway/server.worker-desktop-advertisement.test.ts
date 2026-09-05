// Gateway startup advertisement tests for the cloud-worker Desktop Labs gate.
import { describe, expect, it } from "vitest";
import { writeConfigFile } from "../config/config.js";
import { connectOk, installGatewayTestHooks, startServerWithClient } from "./test-helpers.js";

installGatewayTestHooks();

describe("cloud worker desktop method advertisement", () => {
  it.each([
    { desktop: undefined, advertised: false },
    { desktop: true, advertised: true },
  ])("advertises node observe and gates worker methods when Labs is $desktop", async (testCase) => {
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
      expect(methods).toContain("desktop.observe");
      expect(methods.includes("desktop.launch")).toBe(testCase.advertised);
      expect(methods.includes("worker.desktop.observe")).toBe(testCase.advertised);
      expect(methods.includes("worker.desktop.launch")).toBe(testCase.advertised);
    } finally {
      ws.close();
      await server.close();
    }
  });

  it("advertises host observe without worker-only desktop methods", async () => {
    process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
    await writeConfigFile({ desktop: { host: { enabled: true } } });
    const { server, ws } = await startServerWithClient(undefined, { auth: { mode: "none" } });
    try {
      const hello = await connectOk(ws);
      const methods = (hello as { features?: { methods?: string[] } }).features?.methods ?? [];
      expect(methods).toContain("desktop.observe");
      expect(methods).not.toContain("desktop.launch");
      expect(methods).not.toContain("worker.desktop.observe");
      expect(methods).not.toContain("worker.desktop.launch");
    } finally {
      ws.close();
      await server.close();
    }
  });
});
