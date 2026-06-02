import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendBoundedReproOutput,
  runZaiFallbackRepro,
  resolveZaiFallbackPnpmCommand,
} from "../../scripts/zai-fallback-repro.ts";

describe("zai fallback repro command resolution", () => {
  it("wraps Windows pnpm.cmd without Node shell argv", () => {
    expect(
      resolveZaiFallbackPnpmCommand(["openclaw", "agent", "--message", "hello world"], {
        comSpec: String.raw`C:\Windows\System32\cmd.exe`,
        npmExecPath: String.raw`C:\Program Files\nodejs\pnpm.cmd`,
        platform: "win32",
      }),
    ).toEqual({
      args: [
        "/d",
        "/s",
        "/c",
        String.raw`""C:\Program Files\nodejs\pnpm.cmd" openclaw agent --message "hello world""`,
      ],
      command: String.raw`C:\Windows\System32\cmd.exe`,
      shell: false,
      windowsVerbatimArguments: true,
    });
  });

  it("keeps only a bounded child output tail", () => {
    const first = appendBoundedReproOutput({ text: "", truncatedChars: 0 }, "abcdef", 5);
    const second = appendBoundedReproOutput(first, "ghij", 5);

    expect(first).toEqual({ text: "bcdef", truncatedChars: 1 });
    expect(second).toEqual({ text: "fghij", truncatedChars: 5 });
  });

  it("cleans temporary repro state after fallback proof", async () => {
    const tempRoots: string[] = [];
    const calls: string[] = [];

    const exitCode = await runZaiFallbackRepro({
      env: {
        ANTHROPIC_API_KEY: "anthropic-test-key",
        OPENCLAW_ZAI_FALLBACK_SESSION_ID: "session-test",
        PATH: process.env.PATH,
        ZAI_API_KEY: "zai-test-key",
      },
      error: () => {},
      log: () => {},
      mkdtemp: async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-zai-fallback-test-"));
        tempRoots.push(root);
        return root;
      },
      randomUUID: () => "uuid-test",
      runCommand: async (label, _args, env) => {
        calls.push(label);
        if (label === "run1") {
          const sessionFile = path.join(
            String(env.OPENCLAW_STATE_DIR),
            "agents",
            "main",
            "sessions",
            "session-test.jsonl",
          );
          await fs.mkdir(path.dirname(sessionFile), { recursive: true });
          await fs.writeFile(sessionFile, '{"toolResult":true}\n', "utf8");
        }
        return { code: 0, signal: null, stderr: "", stdout: "" };
      },
      warn: () => {},
    });

    expect(exitCode).toBe(0);
    expect(calls).toEqual(["run1", "run2"]);
    expect(tempRoots).toHaveLength(1);
    await expect(fs.stat(tempRoots[0])).rejects.toMatchObject({ code: "ENOENT" });
  });
});
