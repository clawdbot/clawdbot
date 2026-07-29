/**
 * Gateway auth mode matrix tests.
 */
import { describe } from "vitest";
import { registerAuthModesSuite } from "./server.auth.modes.suite.js";
import { installGatewayTestHooks } from "./server.auth.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

describe("gateway server auth/connect", () => {
  registerAuthModesSuite();
});
