import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "@lydell/node-pty";
import { afterEach, describe, expect, it } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";

const homes = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...homes].map(async (home) => {
      homes.delete(home);
      await fs.rm(home, { recursive: true, force: true });
    }),
  );
});

describe("classic onboarding process", () => {
  it("exits through wizard cancellation when Ctrl-D ends stdin at the first prompt", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-onboard-eof-"));
    homes.add(home);
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.resolve("test/fixtures/clack-prompter-eof.mjs")],
      {
        cwd: process.cwd(),
        cols: 100,
        rows: 30,
        name: "xterm-256color",
        env: {
          ...process.env,
          HOME: home,
          NODE_DISABLE_COMPILE_CACHE: "1",
          NODE_ENV: undefined,
          NODE_OPTIONS: undefined,
          OPENCLAW_NO_RESPAWN: "1",
          OPENCLAW_STATE_DIR: path.join(home, ".openclaw"),
          NO_COLOR: "1",
          TERM: "xterm-256color",
          VITEST: undefined,
        },
      },
    );
    let output = "";
    let sentEof = false;

    const exit = new Promise<{ exitCode: number; signal?: number }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`onboarding did not exit after Ctrl-D:\n${stripAnsi(output)}`));
      }, 60_000);
      child.onData((data) => {
        output += data;
        if (!sentEof && output.includes("Continue?")) {
          sentEof = true;
          child.write("\x04");
        }
      });
      child.onExit((event) => {
        clearTimeout(timeout);
        resolve(event);
      });
    });

    await expect(exit).resolves.toMatchObject({ exitCode: 1 });
    expect(sentEof, stripAnsi(output)).toBe(true);
    expect(stripAnsi(output)).not.toContain("unsettled top-level await");
  }, 70_000);
});
