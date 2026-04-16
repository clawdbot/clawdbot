import { describe, expect, it } from "vitest";
import { resolveQaNodeExecPath } from "./node-exec.js";

describe("resolveQaNodeExecPath", () => {
  it("reuses the current exec path when already running under Node", async () => {
    await expect(
      resolveQaNodeExecPath({
        execPath: "/opt/homebrew/bin/node",
        platform: "darwin",
        versions: { ...process.versions, bun: undefined },
      }),
    ).resolves.toBe("/opt/homebrew/bin/node");
  });

  it("reuses nodejs as a valid current Node executable", async () => {
    await expect(
      resolveQaNodeExecPath({
        execPath: "/usr/bin/nodejs",
        platform: "linux",
        versions: { ...process.versions, bun: undefined },
        execFileImpl: async () => {
          throw new Error("should not search PATH");
        },
      }),
    ).resolves.toBe("/usr/bin/nodejs");
  });

  it("resolves node from PATH when the parent runtime is bun", async () => {
    await expect(
      resolveQaNodeExecPath({
        execPath: "/opt/homebrew/bin/bun",
        platform: "darwin",
        versions: { ...process.versions, bun: "1.2.3" },
        execFileImpl: async () => ({
          stdout: "/usr/local/bin/node\n",
          stderr: "",
        }),
      }),
    ).resolves.toBe("/usr/local/bin/node");
  });

  it("throws a clear error when node is unavailable", async () => {
    await expect(
      resolveQaNodeExecPath({
        execPath: "/opt/homebrew/bin/bun",
        platform: "darwin",
        versions: { ...process.versions, bun: "1.2.3" },
        execFileImpl: async () => {
          throw new Error("missing");
        },
      }),
    ).rejects.toThrow("Node not found in PATH");
  });
});
