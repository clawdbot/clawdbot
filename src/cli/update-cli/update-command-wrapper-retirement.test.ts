import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { retireStandaloneGitWrapper } from "./update-command-git.js";

describe("retireStandaloneGitWrapper", () => {
  it("removes only the installer wrapper for the previous checkout", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wrapper-retire-"));
    const oldRoot = path.join(home, "old checkout");
    const unrelatedWrapper = path.join(home, "earlier", "openclaw");
    const wrapper = path.join(home, ".local", "bin", "openclaw");
    const secondWrapper = path.join(home, "legacy", "bin", "openclaw");
    const oldWrapperContents = `#!/usr/bin/env bash\nset -euo pipefail\nexec /usr/bin/node ${oldRoot.replaceAll(" ", "\\ ")}/dist/entry.js "$@"\n`;
    await Promise.all([
      fs.mkdir(path.dirname(unrelatedWrapper), { recursive: true }),
      fs.mkdir(path.dirname(wrapper), { recursive: true }),
      fs.mkdir(path.dirname(secondWrapper), { recursive: true }),
    ]);
    await fs.writeFile(unrelatedWrapper, "#!/usr/bin/env bash\necho unrelated\n", { mode: 0o755 });
    await Promise.all([
      fs.writeFile(wrapper, oldWrapperContents, { mode: 0o755 }),
      fs.writeFile(secondWrapper, oldWrapperContents, { mode: 0o755 }),
    ]);
    try {
      await expect(
        retireStandaloneGitWrapper({
          previousRoot: oldRoot,
          platform: "linux",
          searchDirs: [
            path.dirname(unrelatedWrapper),
            path.dirname(wrapper),
            path.dirname(secondWrapper),
          ],
        }),
      ).resolves.toEqual({});
      await expect(fs.readFile(unrelatedWrapper, "utf8")).resolves.toContain("unrelated");
      await expect(fs.stat(wrapper)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(secondWrapper)).rejects.toMatchObject({ code: "ENOENT" });

      await fs.writeFile(
        wrapper,
        "#!/usr/bin/env node\nimport '../lib/node_modules/openclaw/openclaw.mjs';\n",
        { mode: 0o755 },
      );
      await expect(
        retireStandaloneGitWrapper({
          previousRoot: oldRoot,
          platform: "linux",
          searchDirs: [path.dirname(wrapper)],
        }),
      ).resolves.toEqual({});
      await expect(fs.stat(wrapper)).resolves.toBeDefined();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("removes only the exact PowerShell installer wrapper on Windows", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wrapper-retire-win-"));
    const oldRoot = "C:\\Users\\operator\\openclaw";
    const wrapper = path.join(home, ".local", "bin", "openclaw.cmd");
    await fs.mkdir(path.dirname(wrapper), { recursive: true });
    await fs.writeFile(
      wrapper,
      `@echo off\r\nnode "${path.win32.join(oldRoot, "dist", "entry.js")}" %*\r\n`,
    );
    try {
      await expect(
        retireStandaloneGitWrapper({
          previousRoot: oldRoot,
          platform: "win32",
          searchDirs: [path.dirname(wrapper)],
        }),
      ).resolves.toEqual({});
      await expect(fs.stat(wrapper)).rejects.toMatchObject({ code: "ENOENT" });

      await fs.writeFile(wrapper, "@echo off\r\necho unrelated\r\n");
      await expect(
        retireStandaloneGitWrapper({
          previousRoot: oldRoot,
          platform: "win32",
          searchDirs: [path.dirname(wrapper)],
        }),
      ).resolves.toEqual({});
      await expect(fs.readFile(wrapper, "utf8")).resolves.toContain("unrelated");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
