import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareHostedStopExecutor } from "./hosted-stop-executor.js";

describe.skipIf(process.platform === "win32")("hosted native executor handshake", () => {
  const dirs = useAutoCleanupTempDirTracker(afterEach);
  it.each([
    { code: 0, disposition: "accepted" },
    { code: 7, disposition: "refused" },
  ] as const)(
    "waits for authorization and reports native exit $code as $disposition",
    async ({ code, disposition }) => {
      const effect = path.join(dirs.make("hosted-stop-executor-"), "native-effect");
      const executor = await prepareHostedStopExecutor({
        command: [
          process.execPath,
          "-e",
          "require('node:fs').writeFileSync(process.argv[1], 'stop'); process.exit(Number(process.argv[2]));",
          effect,
          String(code),
        ],
        env: process.env,
        signal: new AbortController().signal,
        assertCurrent: () => {},
      });
      try {
        await expect(fs.access(effect)).rejects.toThrow();
        await expect(executor.execute(() => {})).resolves.toMatchObject({ disposition });
        expect(await fs.readFile(effect, "utf8")).toBe("stop");
        expect(() => executor.execute(() => {})).toThrow("no longer available");
      } finally {
        await executor.dispose();
      }
    },
  );

  it("cancels a prepared executor without issuing native stop", async () => {
    const effect = path.join(dirs.make("hosted-stop-cancel-"), "native-effect");
    const abort = new AbortController();
    const executor = await prepareHostedStopExecutor({
      command: [
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], 'stop');",
        effect,
      ],
      env: process.env,
      signal: abort.signal,
      assertCurrent: () => {},
    });
    abort.abort();
    expect(() => executor.execute(() => {})).toThrow();
    await expect(fs.access(effect)).rejects.toThrow();
    await executor.dispose();
  });

  it("passes shell metacharacters as literal command arguments", async () => {
    const effect = path.join(dirs.make("hosted-stop-argv-"), "argv");
    const args = ["$@", "$$", "$HOME", "two words", "'\"; echo bad"];
    const executor = await prepareHostedStopExecutor({
      command: [
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))",
        effect,
        ...args,
      ],
      env: process.env,
      signal: new AbortController().signal,
      assertCurrent: () => {},
    });
    try {
      await expect(executor.execute(() => {})).resolves.toMatchObject({ disposition: "accepted" });
      expect(JSON.parse(await fs.readFile(effect, "utf8"))).toEqual(args);
    } finally {
      await executor.dispose();
    }
  });
});
