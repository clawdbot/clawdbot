/**
 * Gateway Control UI auth pairing tests.
 */
import { describe } from "vitest";
import { registerControlUiBootstrapLifecycleSuite } from "./server.auth.control-ui.bootstrap-lifecycle.suite.js";
import { registerControlUiDeviceTokenSuite } from "./server.auth.control-ui.device-token.suite.js";
import { registerControlUiMobileBootstrapSuite } from "./server.auth.control-ui.mobile-bootstrap.suite.js";
import { registerControlUiOwnerBootstrapSuite } from "./server.auth.control-ui.owner-bootstrap.suite.js";
import { registerControlUiPairingSuite } from "./server.auth.control-ui.pairing.suite.js";
import { registerControlUiTrustedProxySuite } from "./server.auth.control-ui.trusted-proxy.suite.js";
import { installGatewayTestHooks } from "./server.auth.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

await Promise.all([
  import("./server.js"),
  import("../infra/device-bootstrap.js"),
  import("../infra/device-identity.js"),
  import("../infra/device-pairing.js"),
]);

describe("gateway server auth/connect", () => {
  registerControlUiTrustedProxySuite();
  registerControlUiDeviceTokenSuite();
  registerControlUiPairingSuite();
  registerControlUiMobileBootstrapSuite();
  registerControlUiBootstrapLifecycleSuite();
  registerControlUiOwnerBootstrapSuite();
});
