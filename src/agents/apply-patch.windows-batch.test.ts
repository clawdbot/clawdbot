import { describe, expect, it } from "vitest";
import { applyPatch, createMemoryPatchSandbox } from "./apply-patch.test-support.js";

describe("applyPatch Windows batch creation", () => {
  it("writes new Windows batch files with CRLF line endings", async () => {
    const memory = createMemoryPatchSandbox();
    await applyPatch(
      "*** Begin Patch\n*** Add File: launch.cmd\n+@echo off\n+echo ready\n*** End Patch",
      memory.options,
    );
    expect(memory.files.get("/sandbox/launch.cmd")).toBe("@echo off\r\necho ready\r\n");
  });

  it("normalizes moved Windows batch files to CRLF", async () => {
    const memory = createMemoryPatchSandbox({
      "source.txt": "@echo off\necho hello\n",
    });
    const patch = `*** Begin Patch
*** Update File: source.txt
*** Move to: launch.cmd
@@
 @echo off
 echo hello
*** End Patch`;

    await applyPatch(patch, memory.options);

    expect(memory.files.get("/sandbox/launch.cmd")).toBe("@echo off\r\necho hello\r\n");
    expect(memory.files.has("/sandbox/source.txt")).toBe(false);
  });
});
