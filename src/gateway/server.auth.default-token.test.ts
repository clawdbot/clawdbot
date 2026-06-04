/**
 * Gateway default auth-token tests.
 */
import { describe } from "vitest";
import { registerDefaultAuthTokenSuite } from "./server.auth.default-token.suite.js";
import { installGatewayTestHooks } from "./server.auth.shared.js";

installGatewayTestHooks({ scope: "suite" });

describe("gateway server auth/connect", () => {
  registerDefaultAuthTokenSuite();
});
