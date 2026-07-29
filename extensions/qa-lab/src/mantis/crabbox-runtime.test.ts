// Qa Lab tests cover Crabbox runtime behavior.
import { describe, expect, it } from "vitest";
import { defaultCommandRunner } from "./crabbox-runtime.js";

describe("Crabbox command runner", () => {
  it("preserves UTF-8 split across child-process pipe chunks", async () => {
    const childScript = `
      process.stdout.write(Buffer.from([0xf0, 0x9f]));
      process.stderr.write(Buffer.from([0xe6]));
      setTimeout(() => {
        process.stdout.write(Buffer.from([0x98, 0x80]));
        process.stderr.write(Buffer.from([0xb5, 0x8b]));
      }, 25);
    `;

    await expect(defaultCommandRunner(process.execPath, ["-e", childScript], {})).resolves.toEqual({
      stdout: "😀",
      stderr: "测",
    });
  });
});
