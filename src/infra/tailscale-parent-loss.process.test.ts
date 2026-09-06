import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const fixture = fileURLToPath(
  new URL("../../test/fixtures/tailscale-parent-loss-fixture.mjs", import.meta.url),
);

describe.runIf(process.platform !== "win32")("Tailscale parent loss", () => {
  it.each([false, true])(
    "releases and reacquires the route after SIGKILL (group=%s)",
    async (group) => {
      const marker = path.join(tempDirs.make("tailscale-parent-loss-"), "claim.json");
      const children: ChildProcess[] = [];
      const claims: Array<{ pid: number; ownerPid: number; port: number }> = [];
      const start = async (port = 0) => {
        const child = fork(fixture, ["gateway", new URL("./tailscale.ts", import.meta.url).href], {
          detached: true,
          execArgv: ["--import", "tsx"],
          stdio: ["ignore", "ignore", "pipe", "ipc"],
          env: {
            ...process.env,
            OPENCLAW_TEST_TAILSCALE_BINARY: fixture,
            OPENCLAW_TEST_ROUTE_MARKER: marker,
            OPENCLAW_TEST_ROUTE_PORT: String(port),
            VITEST: "true",
          },
        });
        children.push(child);
        let stderr = "";
        child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
        const ready = await Promise.race([
          once(child, "message"),
          once(child, "exit").then(([code]) => {
            throw new Error(`Gateway fixture exited (${code}): ${stderr}`);
          }),
        ]);
        expect(ready[0]).toEqual({ type: "ready" });
        const claim = JSON.parse(await readFile(marker, "utf8")) as (typeof claims)[number];
        claims.push(claim);
        return { child, claim };
      };
      try {
        const original = await start();
        const exit = once(original.child, "exit");
        process.kill(group ? -original.child.pid! : original.child.pid!, "SIGKILL");
        await exit;
        await vi.waitFor(() => expect(() => process.kill(original.claim.pid, 0)).toThrow(), {
          timeout: 5_000,
        });
        const replacement = await start(original.claim.port);
        expect(replacement.claim.port).toBe(original.claim.port);
        const stopped = once(replacement.child, "exit");
        replacement.child.send("stop");
        expect(await stopped).toEqual([0, null]);
      } finally {
        for (const child of children) {
          if (child.pid && child.exitCode === null && child.signalCode === null) {
            process.kill(-child.pid, "SIGKILL");
          }
        }
        for (const claim of claims) {
          for (const pid of [claim.pid, claim.ownerPid]) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {}
          }
        }
      }
    },
    20_000,
  );
});
