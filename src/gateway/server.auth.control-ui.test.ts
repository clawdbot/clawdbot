/**
 * Gateway Control UI auth pairing tests.
 */
import { describe } from "vitest";
import { registerControlUiAndPairingSuite } from "./server.auth.control-ui.suite.js";
import { installGatewayTestHooks } from "./server.auth.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

await Promise.all([
  import("./server.js"),
  import("../infra/device-bootstrap.js"),
  import("../infra/device-identity.js"),
  import("../infra/device-pairing.js"),
]);

describe("gateway server auth/connect", () => {
  registerControlUiAndPairingSuite();
});
