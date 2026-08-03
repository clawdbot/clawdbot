import { describe, expect, it, vi } from "vitest";
import { createLazyRuntimeModule, createLazyRuntimeSurface } from "./lazy-runtime.js";

describe("lazy runtime helpers", () => {
  it("caches imported modules", async () => {
    const importer = vi.fn(async () => ({ value: "module" }));
    const load = createLazyRuntimeModule(importer);
    const first = load();

    expect(load()).toBe(first);
    expect(load.peek()).toBe(first);
    await expect(first).resolves.toEqual({ value: "module" });
    expect(importer).toHaveBeenCalledOnce();
  });

  it("can clear imported modules", async () => {
    const importer = vi.fn(async () => ({ value: "module" }));
    const load = createLazyRuntimeModule(importer);

    await load();
    load.clear();
    expect(load.peek()).toBeUndefined();
    await load();
    expect(importer).toHaveBeenCalledTimes(2);
  });

  it("preserves cached runtime import rejections", async () => {
    const importer = vi.fn(async () => {
      throw new Error("sticky");
    });
    const load = createLazyRuntimeSurface(importer, (module) => module);

    await expect(load()).rejects.toThrow("sticky");
    await expect(load()).rejects.toThrow("sticky");
    expect(importer).toHaveBeenCalledOnce();
  });
});
