import { describe, expect, it, vi } from "vitest";
import { FaceTimeCallInstance, FaceTimeCallRegistry } from "../src/call-lifecycle.js";

describe("FaceTime call lifecycle", () => {
  it("resolves every retained UUID alias to exactly the current generation", () => {
    const registry = new FaceTimeCallRegistry<FaceTimeCallInstance>();
    const current = new FaceTimeCallInstance("stable-uuid", "active");
    registry.create(current);
    registry.retainAlias(current, "provisional-uuid");

    expect(registry.resolve("PROVISIONAL-UUID")).toBe(current);
    registry.close(current);
    expect(registry.resolve("provisional-uuid")).toBeUndefined();

    const successor = new FaceTimeCallInstance("successor-uuid", "active");
    registry.create(successor);
    expect(registry.resolve("provisional-uuid")).toBeUndefined();
    expect(registry.resolve("successor-uuid")).toBe(successor);
  });

  it("rejects a carrier command that settles after closing advances generation", async () => {
    const call = new FaceTimeCallInstance("call-1", "active");
    let settle = (_value: string) => {};
    const nativeAction = vi.fn(
      async () =>
        await new Promise<string>((resolve) => {
          settle = resolve;
        }),
    );
    const generation = call.captureGeneration();
    const command = call.runCarrierCommand({ generation, action: nativeAction });
    await vi.waitFor(() => expect(nativeAction).toHaveBeenCalledOnce());
    call.beginClosing();
    settle("unmuted");

    await expect(command).rejects.toThrow("lifecycle changed");
    expect(call.carrierMode).toBe("closing");
  });
});
