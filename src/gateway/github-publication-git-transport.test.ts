import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { assertGitHubPublicationTreeHasNoFilters } from "./github-publication-git-transport.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("rejects a filter from Git's default global attributes file", async () => {
  const cwd = tempDirs.make("openclaw-publication-attributes-");
  const globalAttributes = path.join(cwd, "global-attributes");
  await fs.writeFile(globalAttributes, "*.secret filter=redact\n");

  await expect(
    assertGitHubPublicationTreeHasNoFilters(cwd, "a".repeat(40), async (argv) => {
      const command = argv.join(" ");
      if (command === "git var GIT_ATTR_GLOBAL") {
        return { code: 0, stdout: Buffer.from(globalAttributes) };
      }
      if (command === "git var GIT_ATTR_SYSTEM") {
        return { code: 0, stdout: Buffer.from(path.join(cwd, "missing-system-attributes")) };
      }
      if (argv.includes("ls-tree")) {
        return { code: 0, stdout: Buffer.alloc(0) };
      }
      if (command === "git rev-parse --git-path info/attributes") {
        return { code: 0, stdout: Buffer.from(path.join(cwd, "missing-info-attributes")) };
      }
      throw new Error(`unexpected command: ${command}`);
    }),
  ).rejects.toThrow("unsupported Git clean filter");
});
