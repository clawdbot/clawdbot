import fsSync from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { waitForDead } from "./process-wait.js";

afterEach(() => {
  vi.restoreAllMocks();
});

it("stops waiting when a Linux process is a zombie", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.spyOn(process, "kill").mockImplementation(() => true);
  vi.spyOn(fsSync, "readFileSync").mockImplementation((filePath) => {
    if (String(filePath) === "/proc/42/status") {
      return "Name:\tworker\nState:\tZ (zombie)\nPid:\t42\n";
    }
    throw new Error(`unexpected read: ${String(filePath)}`);
  });

  await expect(waitForDead(42, 20)).resolves.toBeUndefined();
});
