import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let resolveMachineModelIdentifier: typeof import("./machine-model.js").resolveMachineModelIdentifier;
type ModelDeps = NonNullable<Parameters<typeof resolveMachineModelIdentifier>[1]>;
const spawn = vi.fn<NonNullable<ModelDeps["spawnSync"]>>();
const read = vi.fn<NonNullable<ModelDeps["readFileSync"]>>();
const deps = { spawnSync: spawn, readFileSync: read };

describe("resolveMachineModelIdentifier", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ resolveMachineModelIdentifier } = await import("./machine-model.js"));
    spawn.mockReset();
    read.mockReset();
  });

  afterEach(() => vi.restoreAllMocks());

  it.each([
    { name: "success", stdout: " Mac16,1\n", expected: "Mac16,1" },
    { name: "empty", stdout: " \n", expected: undefined },
    { name: "timeout", stdout: "", expected: undefined },
  ])("resolves darwin $name with a bounded probe", ({ name, stdout, expected }) => {
    spawn.mockReturnValue({
      stdout,
      stderr: "",
      pid: 1,
      output: [],
      status: name === "timeout" ? null : 0,
      signal: name === "timeout" ? "SIGKILL" : null,
      ...(name === "timeout" ? { error: new Error("spawnSync sysctl ETIMEDOUT") } : {}),
    });

    expect(resolveMachineModelIdentifier("darwin", deps)).toBe(expected);
    expect(spawn).toHaveBeenCalledExactlyOnceWith("sysctl", ["-n", "hw.model"], {
      encoding: "utf-8",
      timeout: 5_000,
      killSignal: "SIGKILL",
    });
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    { name: "DMI", product: " Test Laptop \n", tree: "Other model", expected: "Test Laptop" },
    { name: "missing DMI", product: null, tree: " Test Board\0\0", expected: "Test Board" },
    { name: "empty DMI", product: " \n", tree: "Test Board\0\n", expected: "Test Board" },
    { name: "missing files", product: null, tree: null, expected: undefined },
    { name: "empty files", product: "\0", tree: " \0\0", expected: undefined },
    { name: "bounded DMI", product: "x".repeat(80), tree: null, expected: "x".repeat(64) },
    { name: "bounded tree", product: null, tree: "x".repeat(63) + "🚀", expected: "x".repeat(63) },
  ])("resolves linux $name", ({ product, tree, expected }) => {
    read.mockImplementation((file) => {
      const value =
        file === "/sys/devices/virtual/dmi/id/product_name"
          ? product
          : file === "/proc/device-tree/model"
            ? tree
            : null;
      if (value === null) {
        throw new Error("ENOENT");
      }
      return value;
    });

    expect(resolveMachineModelIdentifier("linux", deps)).toBe(expected);
    expect(read).toHaveBeenNthCalledWith(1, "/sys/devices/virtual/dmi/id/product_name", "utf-8");
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(["win32", "freebsd"] as const)("leaves %s unknown without probing", (platform) => {
    expect(resolveMachineModelIdentifier(platform, deps)).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["Test Laptop", ""])(
    "memoizes the first result, including missing models (%j)",
    (value) => {
      vi.spyOn(os, "platform").mockReturnValue("linux");
      read.mockReturnValue(value);
      const first = resolveMachineModelIdentifier(undefined, deps);
      const reads = read.mock.calls.length;
      read.mockReturnValue("Changed Laptop");

      expect(first).toBe(value || undefined);
      expect(resolveMachineModelIdentifier("linux", deps)).toBe(first);
      expect(read).toHaveBeenCalledTimes(reads);
    },
  );
});
