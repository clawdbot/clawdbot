// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostPolicyCapability } from "./host-policy.ts";

describe("createHostPolicyCapability", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to unrestricted local Control UI behavior", () => {
    const policy = createHostPolicyCapability();

    expect(policy.snapshot.host).toMatchObject({ id: "openclaw", mode: "local" });
    expect(policy.isRouteEnabled("config")).toBe(true);
    expect(policy.isSettingEditable(["agents", "defaults", "model"])).toBe(true);
    expect(policy.preflightAction("sessions.delete")).toEqual({ ok: true });
  });

  it("normalizes routes, coarse settings, and actions from a host policy wrapper", () => {
    const policy = createHostPolicyCapability({
      hostControlPolicy: {
        version: 1,
        host: { id: "lobster", mode: "hosted", displayName: "Lobster" },
        gateway: {
          path: "/v1/openclaw-gateway?client_family=hosted-control-ui",
          scopes: ["operator.read", "operator.write"],
        },
        defaults: { route: "enabled", setting: "editable", action: "enabled" },
        routes: {
          debug: { state: "disabled", reason: "host diagnostics only" },
          logs: "readOnly",
        },
        settings: {
          "*": { state: "readOnly", reason: "deployment owned" },
          "agents.list.0.model": "editable",
        },
        actions: {
          "sessions.delete": { state: "disabled", reason: "retention policy" },
          "config.save": "brokered",
        },
      },
    });

    expect(policy.snapshot.host).toMatchObject({ id: "lobster", mode: "hosted" });
    expect(policy.isRouteEnabled("debug")).toBe(false);
    expect(policy.routeState("logs")).toBe("readOnly");
    expect(policy.settingState(["agents", "list", "0", "model"])).toBe("readOnly");
    expect(policy.settingState(["agents", "defaults", "model"])).toBe("readOnly");
    expect(policy.canInvokeAction("sessions.delete")).toBe(false);
    expect(policy.preflightAction("config.save")).toMatchObject({
      ok: false,
      code: "HOST_POLICY_BLOCKED",
      details: { action: "config.save", state: "brokered" },
    });
  });

  it("refreshes from the mounted control-ui config endpoint", async () => {
    const policy = createHostPolicyCapability();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        hostControlPolicy: {
          version: 1,
          host: { id: "lobster", mode: "hosted" },
          gateway: { path: "/v1/openclaw-gateway", scopes: ["operator.read"] },
          defaults: { route: "enabled", setting: "editable", action: "enabled" },
          routes: { channels: "disabled" },
          settings: { "*": "locked" },
          actions: {},
        },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await policy.refresh("/openclaw");

    expect(fetchMock).toHaveBeenCalledWith("/openclaw/control-ui-config.json", {
      cache: "no-store",
      credentials: "same-origin",
    });
    expect(policy.isRouteEnabled("channels")).toBe(false);
    expect(policy.isSettingEditable("*")).toBe(false);
  });
});
