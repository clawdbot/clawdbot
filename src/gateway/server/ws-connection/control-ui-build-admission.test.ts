import { describe, expect, it } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../../../packages/gateway-protocol/src/client-info.js";
import { resolveControlUiBuildMismatch } from "./control-ui-build-admission.js";

const bundled = {
  clientId: GATEWAY_CLIENT_IDS.CONTROL_UI,
  gatewayBuildId: "gateway-build",
  requestHost: "claw.example",
  requestOrigin: "https://claw.example",
};

describe("resolveControlUiBuildMismatch", () => {
  it.each([
    ["exact bundled build", { ...bundled, clientBuildId: "gateway-build" }, null],
    [
      "stale bundled build",
      { ...bundled, clientBuildId: "older-build" },
      { gatewayBuildId: "gateway-build", clientBuildId: "older-build" },
    ],
    ["legacy bundled build", bundled, { gatewayBuildId: "gateway-build", clientBuildId: null }],
    ["configured root", { ...bundled, configuredControlUiRoot: "/srv/ui" }, null],
    ["separately hosted UI", { ...bundled, requestOrigin: "https://ui.example" }, null],
    ["local dev UI", { ...bundled, clientBuildId: "dev" }, null],
    ["absent Gateway build", { ...bundled, gatewayBuildId: null }, null],
    ["non-Control UI", { ...bundled, clientId: "test-client" }, null],
  ])("classifies $0", (_name, input, expected) => {
    expect(resolveControlUiBuildMismatch(input)).toEqual(expected);
  });
});
