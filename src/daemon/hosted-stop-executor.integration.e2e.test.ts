import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareHostedStopExecutor } from "./hosted-stop-executor.js";

// Requires an isolated systemd VM with permission to create transient scopes.
describe.runIf(
  process.platform === "linux" && process.getuid?.() === 0 && existsSync("/run/systemd/system"),
)("hosted stop executor native systemd scope", () => {
  const dirs = useAutoCleanupTempDirTracker(afterEach);
  it("retains literal shell arguments across scope placement and exec", async () => {
    const output = path.join(dirs.make("hosted-stop-scope-"), "argv");
    const unit = `openclaw-stop-test-${randomUUID()}.scope`;
    const args = ["$@", "$$", "$HOME", "two words", "'\"; echo bad"];
    const executor = await prepareHostedStopExecutor({
      command: [
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))",
        output,
        ...args,
      ],
      scopeArgs: [
        "--system",
        "--scope",
        "--quiet",
        "--collect",
        "--no-ask-password",
        `--unit=${unit}`,
      ],
      env: process.env,
      signal: new AbortController().signal,
      assertCurrent: () => {},
      verifyPlacement: async (pid) => {
        expect(await fs.readFile(`/proc/${pid}/cgroup`, "utf8")).toContain(`/${unit}\n`);
      },
    });
    try {
      await expect(executor.execute(() => {})).resolves.toMatchObject({ disposition: "accepted" });
      expect(JSON.parse(await fs.readFile(output, "utf8"))).toEqual(args);
    } finally {
      await executor.dispose();
    }
  });
});
