import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runNodeScript } from "./run-node-script.js";
import { useAutoCleanupTempDirTracker } from "./temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("captures inherited output written after the script exits", async () => {
  const script = join(tempDirs.make("openclaw-node-script-output-"), "parent.mjs");
  writeFileSync(
    script,
    `import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["-e", \`
process.on("disconnect", () => {
  process.stdout.write("drained stdout\\\\n");
  process.stderr.write("drained stderr\\\\n");
});
process.send("ready");
\`], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
child.once("message", () => process.exit(17));
`,
  );

  const result = await runNodeScript(script, process.env, 5_000);
  expect(result).toEqual({
    error: undefined,
    status: 17,
    stdout: "drained stdout\n",
    stderr: "drained stderr\n",
  });
});
