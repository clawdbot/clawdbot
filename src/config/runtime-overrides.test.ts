import { beforeEach, describe, expect, it } from "vitest";
import {
  applyConfigOverrides,
  getConfigOverrides,
  resetConfigOverrides,
  setConfigOverride,
  unsetConfigOverride,
} from "./runtime-overrides.js";
import type { ClawdbotConfig } from "./types.js";

describe("runtime overrides", () => {
  beforeEach(() => {
    resetConfigOverrides();
  });

  it("sets and applies nested overrides", () => {
    const cfg = {
      messages: { responsePrefix: "[clawdbot]" },
    } as ClawdbotConfig;
    setConfigOverride("messages.responsePrefix", "[debug]");
    const next = applyConfigOverrides(cfg);
    expect(next.messages?.responsePrefix).toBe("[debug]");
  });

  it("merges object overrides without clobbering siblings", () => {
    const cfg = {
      whatsapp: { dmPolicy: "pairing", allowFrom: ["+1"] },
    } as ClawdbotConfig;
    setConfigOverride("whatsapp.dmPolicy", "open");
    const next = applyConfigOverrides(cfg);
    expect(next.whatsapp?.dmPolicy).toBe("open");
    expect(next.whatsapp?.allowFrom).toEqual(["+1"]);
  });

  it("unsets overrides and prunes empty branches", () => {
    setConfigOverride("whatsapp.dmPolicy", "open");
    const removed = unsetConfigOverride("whatsapp.dmPolicy");
    expect(removed.ok).toBe(true);
    expect(removed.removed).toBe(true);
    expect(Object.keys(getConfigOverrides()).length).toBe(0);
  });
});
