import { describe, expect, it } from "vitest";
import { resolveConfigValueUncached } from "./resolve-config-value.js";
import { createBashTool } from "./tools/bash.js";

const isWindows = process.platform === "win32";

describe.runIf(isWindows)("Git Bash PATH integration", () => {
  it("exposes Git coreutils through the Bash tool", async () => {
    const tool = createBashTool(process.cwd());

    const result = await tool.execute("windows-git-bash-path", {
      command: "command -v cygpath",
    });

    expect(result.content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringMatching(/usr\/bin\/cygpath/i) }),
    ]);
  });

  it("exposes Git coreutils to !command config resolution", () => {
    expect(resolveConfigValueUncached("!command -v cygpath")).toMatch(/usr\/bin\/cygpath/i);
  });
});
