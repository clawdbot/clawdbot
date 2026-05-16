import { describe, expect, it } from "vitest";
import type { CliDeps } from "../cli/deps.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withLocalGatewayRequestScope } from "./local-request-context.js";
import { dispatchGatewayMethodInProcessRaw } from "./server-plugins.js";

describe("local gateway request context", () => {
  it("lets embedded local runs dispatch gateway methods in-process", async () => {
    const cfg = {
      agents: {
        defaults: {},
      },
    } as OpenClawConfig;

    await withLocalGatewayRequestScope(
      {
        deps: {} as CliDeps,
        getRuntimeConfig: () => cfg,
      },
      async () => {
        const response = await dispatchGatewayMethodInProcessRaw("agent.identity.get", {
          agentId: "main",
        });

        expect(response.ok).toBe(true);
        expect(response.payload).toMatchObject({ agentId: "main" });
      },
    );
  });
});
