// Browser tests cover agent.exec gating plugin behavior.
import { describe, expect, it } from "vitest";
import { registerBrowserAgentExecRoutes } from "./agent.exec.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

async function runExecRoute(execEnabled: boolean, evaluateEnabled: boolean) {
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserAgentExecRoutes(app, {
    state: () => ({ resolved: { execEnabled, evaluateEnabled } }),
  } as never);
  const handler = postHandlers.get("/exec");
  if (!handler) {
    throw new Error("expected /exec route handler");
  }
  const response = createBrowserRouteResponse();
  await handler({ body: { code: "return 7" }, query: {} } as never, response.res);
  return response;
}

describe("browser agent exec gating", () => {
  it("returns not found when exec is disabled even if evaluation is enabled", async () => {
    const response = await runExecRoute(false, true);
    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({ error: "Not Found" });
  });

  it("runs when exec is enabled even if evaluation is disabled", async () => {
    const response = await runExecRoute(true, false);
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ ok: true, value: 7, logs: [] });
  });
});
