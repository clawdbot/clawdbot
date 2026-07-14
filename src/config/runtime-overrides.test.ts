// Covers runtime config overrides and precedence.
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyConfigOverrides,
  captureConfigOverrideApplier,
  getConfigOverrides,
  resetConfigOverrides,
  setConfigOverride,
  unsetConfigOverride,
} from "./runtime-overrides.js";
import type { OpenClawConfig } from "./types.js";

describe("runtime overrides", () => {
  beforeEach(() => {
    resetConfigOverrides();
  });

  it("sets and applies nested overrides", () => {
    const cfg = {
      messages: { responsePrefix: "[openclaw]" },
    } as OpenClawConfig;
    setConfigOverride("messages.responsePrefix", "[debug]");
    const next = applyConfigOverrides(cfg);
    expect(next.messages?.responsePrefix).toBe("[debug]");
  });

  it("captures an immutable override applier", () => {
    setConfigOverride("gateway.auth.token", "startup-token");
    const applyStartupOverrides = captureConfigOverrideApplier();
    setConfigOverride("gateway.auth.token", "later-token");

    expect(applyStartupOverrides({}).gateway?.auth?.token).toBe("startup-token");
    expect(applyConfigOverrides({}).gateway?.auth?.token).toBe("later-token");
  });

  it("merges object overrides without clobbering siblings", () => {
    const cfg = {
      channels: { whatsapp: { dmPolicy: "pairing", allowFrom: ["+1"] } },
    } as OpenClawConfig;
    setConfigOverride("channels.whatsapp.dmPolicy", "open");
    const next = applyConfigOverrides(cfg);
    expect(next.channels?.whatsapp?.dmPolicy).toBe("open");
    expect(next.channels?.whatsapp?.allowFrom).toEqual(["+1"]);
  });

  it("unsets overrides and prunes empty branches", () => {
    setConfigOverride("channels.whatsapp.dmPolicy", "open");
    const removed = unsetConfigOverride("channels.whatsapp.dmPolicy");
    expect(removed).toEqual({ ok: true, value: true });
    expect(Object.keys(getConfigOverrides()).length).toBe(0);
  });

  it("rejects prototype pollution paths", () => {
    const attempts = ["__proto__.polluted", "constructor.polluted", "prototype.polluted"];
    for (const path of attempts) {
      const result = setConfigOverride(path, true);
      expect(result.ok).toBe(false);
      expect(Object.keys(getConfigOverrides()).length).toBe(0);
    }
  });

  it("blocks __proto__ keys inside override object values", () => {
    const cfg = { commands: {} } as OpenClawConfig;
    setConfigOverride("commands", JSON.parse('{"__proto__":{"bash":true}}'));

    const next = applyConfigOverrides(cfg);
    expect(next.commands?.bash).toBeUndefined();
    expect(Object.hasOwn(next.commands ?? {}, "bash")).toBe(false);
  });

  it("blocks constructor/prototype keys inside override object values", () => {
    const cfg = { commands: {} } as OpenClawConfig;
    setConfigOverride("commands", JSON.parse('{"constructor":{"prototype":{"bash":true}}}'));

    const next = applyConfigOverrides(cfg);
    expect(next.commands?.bash).toBeUndefined();
    expect(Object.hasOwn(next.commands ?? {}, "bash")).toBe(false);
  });

  it("sanitizes blocked object keys when writing overrides", () => {
    setConfigOverride("commands", JSON.parse('{"__proto__":{"bash":true},"debug":true}'));

    expect(getConfigOverrides()).toEqual({
      commands: {
        debug: true,
      },
    });
  });
});
