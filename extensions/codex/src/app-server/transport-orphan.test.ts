import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createCodexNativeTestState } from "./native-app-server.test-support.js";

type ProcessTree = { parent: number; child: number; descendant: number };
const fixture = fileURLToPath(new URL("./transport-orphan.test-helper.ts", import.meta.url));

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" })
      .trim()
      .startsWith("Z");
  } catch {
    return false;
  }
}

describe.skipIf(process.platform === "win32")("Codex stdio crash recovery", () => {
  it.for(["fixture", "native"])(
    "reaps the dead $0 owner before a fresh spawn and preserves live owners",
    { timeout: 60_000 },
    async (mode, ctx) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-orphan-"));
      const parents: ChildProcess[] = [];
      const trees: ProcessTree[] = [];
      ctx.onTestFinished(async () => {
        // Also capture children of a fixture that failed before reporting ready.
        const rows = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
          .trim()
          .split("\n")
          .map((line) => line.trim().split(/\s+/).map(Number));
        const owned = new Set(parents.flatMap((parent) => (parent.pid ? [parent.pid] : [])));
        for (const pid of owned) {
          for (const [child, parent] of rows) {
            if (parent === pid && child) {
              owned.add(child);
            }
          }
        }
        for (const pid of [...owned].toReversed()) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* Already exited. */
          }
        }
        for (const tree of trees) {
          for (const pid of [tree.descendant, tree.child, tree.parent]) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              // Test-owned processes may already have been reaped by the successor.
            }
          }
        }
        for (const parent of parents) {
          parent.kill("SIGKILL");
          parent.stdout?.destroy();
          parent.stderr?.destroy();
        }
        await fs.rm(root, { recursive: true, force: true });
      });
      const start = async (stateDir: string, searchPath = process.env.PATH) => {
        const native =
          mode === "native"
            ? await createCodexNativeTestState(path.join(root, `native-${parents.length}`))
            : undefined;
        if (native) {
          await fs.writeFile(
            path.join(native.codexHome, "config.toml"),
            'cli_auth_credentials_store="ephemeral"\n[features]\nrespect_system_proxy=false\nshell_snapshot=false\n[analytics]\nenabled=false\n[feedback]\nenabled=false\n',
          );
        }
        const args = [
          "--import",
          "tsx",
          fixture,
          mode,
          root,
          ...(native ? [native.command, native.cwd] : []),
        ];
        const parent = spawn(process.execPath, args, {
          env: {
            HOME: root,
            ...native?.env,
            PATH: searchPath,
            OPENCLAW_STATE_DIR: stateDir,
            NODE_ENV: "test",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        parents.push(parent);
        let stderr = "";
        parent.stderr?.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(-4_000);
        });
        const lines = createInterface({ input: parent.stdout! });
        const tree = await new Promise<ProcessTree>((resolve, reject) => {
          parent.once("error", reject);
          parent.once("exit", () => reject(new Error(`Fixture exited: ${stderr}`)));
          lines.once("line", (line) => resolve(JSON.parse(line) as ProcessTree));
        });
        lines.close();
        trees.push(tree);
        return { parent, tree };
      };
      const stateDir = path.join(root, "state");
      const old = await start(stateDir);
      const live = await start(stateDir);
      const other = await start(path.join(root, "other-state"));
      expect(isAlive(old.tree.child)).toBe(true);
      if (mode === "native") {
        // Freeze a real app-server mid-command so EOF cannot complete its cleanup.
        process.kill(old.tree.child, "SIGSTOP");
      }
      const exited = once(old.parent, "exit");
      old.parent.kill("SIGKILL");
      await exited;
      expect(isAlive(old.tree.child)).toBe(true);
      expect(isAlive(old.tree.descendant)).toBe(true);

      const fakeBin = path.join(root, "bin");
      await fs.mkdir(fakeBin);
      await fs.writeFile(path.join(fakeBin, "ps"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      await expect(
        start(stateDir, `${fakeBin}${path.delimiter}${process.env.PATH}`),
      ).rejects.toThrow("Cannot inspect registered Codex processes");
      expect(isAlive(old.tree.child)).toBe(true);

      const fresh = await start(stateDir);
      expect(isAlive(old.tree.child)).toBe(false);
      expect(isAlive(old.tree.descendant)).toBe(false);
      for (const tree of [live.tree, other.tree, fresh.tree]) {
        expect(isAlive(tree.child)).toBe(true);
        expect(isAlive(tree.descendant)).toBe(true);
      }
    },
  );
});
