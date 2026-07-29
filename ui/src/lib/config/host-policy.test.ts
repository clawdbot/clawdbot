// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createHostPolicyCapability } from "../../app/host-policy.ts";
import { createRuntimeConfigCapability } from "./index.ts";

function createGateway() {
  return {
    snapshot: {
      client: null,
      connected: false,
      sessionKey: "main",
    },
    subscribe: () => () => {},
  };
}

describe("runtime config host policy", () => {
  it("blocks edits to read-only setting paths", () => {
    const hostPolicy = createHostPolicyCapability({
      version: 1,
      host: { id: "lobster", mode: "hosted" },
      gateway: { path: "/v1/openclaw-gateway", scopes: ["operator.read"] },
      defaults: { route: "enabled", setting: "editable", action: "enabled" },
      routes: {},
      settings: {
        "*": { state: "readOnly", reason: "deployment owned" },
      },
      actions: {},
    });
    const runtimeConfig = createRuntimeConfigCapability(createGateway(), hostPolicy);
    runtimeConfig.state.configForm = { agents: { defaults: { model: "gpt-5" } } };

    runtimeConfig.patchForm(["agents", "defaults", "model"], "gpt-6");

    expect(runtimeConfig.state.configForm).toEqual({
      agents: { defaults: { model: "gpt-5" } },
    });
    expect(runtimeConfig.state.lastError).toBe("deployment owned");
  });

  it("ignores child editable overrides in the coarse V1 settings policy", () => {
    const hostPolicy = createHostPolicyCapability({
      version: 1,
      host: { id: "lobster", mode: "hosted" },
      gateway: { path: "/v1/openclaw-gateway", scopes: ["operator.read"] },
      defaults: { route: "enabled", setting: "editable", action: "enabled" },
      routes: {},
      settings: {
        "*": "readOnly",
        "agents.defaults.model": "editable",
      },
      actions: {},
    });
    const runtimeConfig = createRuntimeConfigCapability(createGateway(), hostPolicy);
    runtimeConfig.state.configForm = { agents: { defaults: { model: "gpt-5" } } };

    runtimeConfig.patchForm(["agents", "defaults", "model"], "gpt-6");

    expect(runtimeConfig.state.configForm).toEqual({
      agents: { defaults: { model: "gpt-5" } },
    });
    expect(runtimeConfig.state.lastError).toBe(
      "Setting 'agents.defaults.model' is locked/read-only by the host.",
    );
  });
});
