import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { removeGatewayTempHome, setupGatewayTempHome } from "./gateway.test-support.js";

describe.each([undefined, "1"])("setupGatewayTempHome with prior minimal mode %s", (prior) => {
  it.each([undefined, false, true])(
    "restores minimal mode after minimalGateway=%s",
    async (minimalGateway) => {
      await withEnvAsync({ OPENCLAW_TEST_MINIMAL_GATEWAY: prior }, async () => {
        const { envSnapshot, tempHome } = await setupGatewayTempHome({
          prefix: "openclaw-gateway-env-",
          minimalGateway,
        });
        try {
          envSnapshot.restore();
          // Assert the fixture's boundary before withEnvAsync or global cleanup can restore it.
          expect(process.env.OPENCLAW_TEST_MINIMAL_GATEWAY).toBe(prior);
        } finally {
          await removeGatewayTempHome(tempHome);
        }
      });
    },
  );
});
