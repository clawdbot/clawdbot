import { describe, expect, it } from "vitest";
import { resolveCliCommandPathPolicy } from "./command-path-policy.js";

describe("command-path-policy", () => {
  it("resolves status policy with shared startup semantics", () => {
    expect(resolveCliCommandPathPolicy(["status"])).toEqual({
      bypassConfigGuard: false,
      routeConfigGuard: "when-suppressed",
      loadPlugins: "never",
      hideBanner: false,
      ensureCliPath: false,
    });
  });

  it("applies exact overrides after broader channel plugin rules", () => {
    expect(resolveCliCommandPathPolicy(["channels", "send"])).toEqual({
      bypassConfigGuard: false,
      routeConfigGuard: "never",
      loadPlugins: "always",
      hideBanner: false,
      ensureCliPath: true,
    });
    expect(resolveCliCommandPathPolicy(["channels", "add"])).toEqual({
      bypassConfigGuard: false,
      routeConfigGuard: "never",
      loadPlugins: "never",
      hideBanner: false,
      ensureCliPath: true,
    });
    expect(resolveCliCommandPathPolicy(["channels", "status"])).toEqual({
      bypassConfigGuard: false,
      routeConfigGuard: "never",
      loadPlugins: "never",
      hideBanner: false,
      ensureCliPath: true,
    });
    expect(resolveCliCommandPathPolicy(["channels", "list"])).toEqual({
      bypassConfigGuard: false,
      routeConfigGuard: "never",
      loadPlugins: "never",
      hideBanner: false,
      ensureCliPath: true,
    });
  });

  it("resolves mixed startup-only rules", () => {
    expect(resolveCliCommandPathPolicy(["configure"])).toEqual({
      bypassConfigGuard: true,
      routeConfigGuard: "never",
      loadPlugins: "never",
      hideBanner: false,
      ensureCliPath: true,
    });
    expect(resolveCliCommandPathPolicy(["config", "validate"])).toEqual({
      bypassConfigGuard: true,
      routeConfigGuard: "never",
      loadPlugins: "never",
      hideBanner: false,
      ensureCliPath: true,
    });
    expect(resolveCliCommandPathPolicy(["gateway", "status"])).toEqual({
      bypassConfigGuard: false,
      routeConfigGuard: "always",
      loadPlugins: "never",
      hideBanner: false,
      ensureCliPath: true,
    });
    expect(resolveCliCommandPathPolicy(["plugins", "update"])).toEqual({
      bypassConfigGuard: false,
      routeConfigGuard: "never",
      loadPlugins: "never",
      hideBanner: true,
      ensureCliPath: true,
    });
    expect(resolveCliCommandPathPolicy(["cron", "list"])).toEqual({
      bypassConfigGuard: true,
      routeConfigGuard: "never",
      loadPlugins: "never",
      hideBanner: false,
      ensureCliPath: true,
    });
  });
});
