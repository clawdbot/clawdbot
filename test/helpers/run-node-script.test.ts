import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createFixtureLifetime } from "./fixture-lifetime.js";
import { waitForDead, waitForPidFile } from "./process-wait.js";
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

it.for(["at limit", "stdout overflow", "stderr overflow"])(
  "preserves independent 2 MiB output failure boundaries: %s",
  async (mode) => {
    const directory = tempDirs.make("openclaw-node-script-buffer-");
    const script = join(directory, "output.mjs");
    const pidFile = join(directory, "pid");
    const maxBuffer = 2 * 1024 * 1024;
    writeFileSync(
      script,
      `import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
const mode=${JSON.stringify(mode)}, bytes=${maxBuffer};
if(mode==='at limit') {
  process.stdout.write(Buffer.alloc(bytes,97));
  process.stderr.write(Buffer.alloc(bytes,98));
} else {
  process[mode.split(' ')[0]].write(Buffer.alloc(bytes+1,97));
  setTimeout(()=>process.exit(73),10000);
}
`,
    );
    const result = await runNodeScript(script, process.env, 5_000, { maxBuffer });
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    if (mode === "at limit") {
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("a".repeat(maxBuffer));
      expect(result.stderr).toBe("b".repeat(maxBuffer));
    } else {
      expect(result.error).toHaveProperty("code", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
      expect(result.status).toBeNull();
      expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(maxBuffer);
      expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(maxBuffer);
    }
  },
);

it.skipIf(process.platform === "win32")(
  "retains inputs when captured command output leaves cleanup uncertain",
  async ({ signal }) => {
    const fixture = createFixtureLifetime();
    const directory = fixture.createTempDir("openclaw-node-script-uncertain-");
    const script = join(directory, "parent.mjs");
    const pidFile = join(directory, "leaf.pid");
    const release = join(directory, "release");
    const input = join(directory, "input");
    const read = join(directory, "read");
    writeFileSync(input, "still owned");
    const leaf = `
const fs=require('node:fs');
const deadline=setTimeout(()=>process.exit(73),15000);
const poll=setInterval(()=>{
  if(!fs.existsSync(${JSON.stringify(release)})) return;
  fs.writeFileSync(${JSON.stringify(read)},fs.readFileSync(${JSON.stringify(input)}));
  clearInterval(poll);clearTimeout(deadline);
},5);
fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
process.send('ready');process.disconnect();
`;
    writeFileSync(
      script,
      `import {spawn} from 'node:child_process';
const child=spawn(process.execPath,['--eval',${JSON.stringify(leaf)}],{detached:true,stdio:['ignore','inherit','inherit','ipc']});
child.once('message',()=>process.exit(0));
`,
    );
    const command = fixture.track(
      runNodeScript(script, process.env, undefined, { signal, requireProcessTreeExit: true }),
    );
    try {
      const result = await command;
      expect(result.error).toMatchObject({
        code: "EPROCESSGROUP_CLEANUP_FAILED",
        processTreeState: "indeterminate",
      });
      await expect(fixture.cleanup()).rejects.toThrow("Fixture cleanup unverified");
      expect(existsSync(directory)).toBe(true);
      writeFileSync(release, "release");
      await waitForDead(await waitForPidFile(pidFile, 2_000), 2_000);
      expect(readFileSync(read, "utf8")).toBe("still owned");
    } finally {
      await command;
      // Rescue only this bounded escaped leaf, and certify its exit before
      // manually disposing roots the lifetime owner deliberately retained.
      if (existsSync(pidFile)) {
        writeFileSync(release, "release");
        await waitForDead(await waitForPidFile(pidFile, 2_000), 15_000);
      }
      await fixture.cleanup();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
