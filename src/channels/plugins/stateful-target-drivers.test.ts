// Stateful target driver tests cover process-wide registry identity.
import { describe, expect, it } from "vitest";
import type { StatefulBindingTargetDriver } from "./stateful-target-drivers.js";

const moduleUrl = new URL("./stateful-target-drivers.ts", import.meta.url).href;

describe("stateful target driver registry", () => {
  it("shares registrations across duplicate module instances", async () => {
    const first = (await import(
      `${moduleUrl}?instance=first-${Date.now()}`
    )) as typeof import("./stateful-target-drivers.js");
    const second = (await import(
      `${moduleUrl}?instance=second-${Date.now()}`
    )) as typeof import("./stateful-target-drivers.js");
    const driver: StatefulBindingTargetDriver = {
      id: "duplicate-module-test",
      ensureReady: async () => ({ ok: true }),
      ensureSession: async () => ({ ok: true, sessionKey: "agent:test:shared" }),
    };

    const unregister = first.registerStatefulBindingTargetDriver(driver);
    try {
      expect(second.getStatefulBindingTargetDriver(driver.id)).toMatchObject({ id: driver.id });
    } finally {
      unregister();
    }
  });
});
