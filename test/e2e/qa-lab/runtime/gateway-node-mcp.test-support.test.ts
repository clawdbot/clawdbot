import { once } from "node:events";
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import {
  createChildEnv,
  parseNodeMcpTextRecord,
  processIsAlive,
  startHttpFixture,
  stopChild,
  waitForMcpFixtureGate,
} from "./gateway-node-mcp.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("gateway node MCP fixture ownership", () => {
  it.each(["existing", "published"] as const)(
    "joins its watcher when the gate is %s",
    async (mode) => {
      const root = tempDirs.make("mcp-gate-publication-");
      const gate = path.join(root, "gate");
      if (mode === "existing") {
        await fs.writeFile(gate, "ready");
      }
      const watching = createDeferred<nodeFs.FSWatcher>();
      const watch = nodeFs.watch;
      const observeWatch = vi.fn((...args: Parameters<typeof watch>) => {
        const watcher = watch(...args);
        watching.resolve(watcher);
        return watcher;
      });
      vi.resetModules();
      vi.doMock("node:fs", () => ({ ...nodeFs, watch: observeWatch }));
      const { waitForMcpFixtureGate: waitForGate } =
        await import("./gateway-node-mcp.test-support.js");
      let watcher: nodeFs.FSWatcher | undefined;
      const waiting = waitForGate(gate);
      try {
        if (mode === "published") {
          watcher = await watching.promise;
          const closed = once(watcher, "close");
          await fs.writeFile(gate, "ready");
          await waiting;
          await closed;
        } else {
          await waiting;
          expect(observeWatch).not.toHaveBeenCalled();
        }
        expect(await fs.readFile(gate, "utf8")).toBe("ready");
      } finally {
        watcher?.close();
        await waiting;
        vi.doUnmock("node:fs");
        vi.resetModules();
      }
    },
  );

  it("releases its deadline when the real gate watcher cannot be constructed", async () => {
    const root = tempDirs.make("mcp-gate-watch-failure-");
    const timers = vi.spyOn(globalThis, "setTimeout");
    const cleared = vi.spyOn(globalThis, "clearTimeout");
    try {
      await expect(waitForMcpFixtureGate(path.join(root, "missing", "gate"))).rejects.toMatchObject(
        {
          code: "ENOENT",
          syscall: "watch",
        },
      );
      const allocated = timers.mock.results.flatMap((result, index) =>
        result.type === "return" && timers.mock.calls[index]?.[1] === 30_000 ? [result.value] : [],
      );
      expect(
        allocated.filter((timer) => !cleared.mock.calls.some(([value]) => value === timer)).length,
      ).toBe(0);
    } finally {
      for (const result of timers.mock.results) {
        if (result.type === "return") {
          clearTimeout(result.value);
        }
      }
      timers.mockRestore();
      cleared.mockRestore();
    }
  });

  it.each([
    ["direct", (payload: object) => payload],
    ["node.invoke", (payload: object) => ({ ok: true, payload })],
  ])("parses %s MCP text records", (_label, wrap) => {
    const fact = { label: "node-stdio", marker: "ready", pid: 42 };
    expect(
      parseNodeMcpTextRecord(wrap({ content: [{ type: "text", text: JSON.stringify(fact) }] })),
    ).toEqual(fact);
  });

  it("kills a spawned fixture when readiness validation fails", async () => {
    const root = tempDirs.make("mcp-fixture-startup-failure-");
    const fixturePath = path.join(root, "invalid-fixture.mjs");
    const pidPath = path.join(root, "fixture.pid");
    await fs.writeFile(
      fixturePath,
      `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); console.log(JSON.stringify({type:"wrong"})); setInterval(() => {}, 1000);`,
      "utf8",
    );

    await expect(
      startHttpFixture({
        fixturePath,
        labelPrefix: "node",
        env: createChildEnv({ home: root, tempDir: os.tmpdir() }),
      }),
    ).rejects.toThrow("invalid readiness");
    const pid = Number(await fs.readFile(pidPath, "utf8"));
    try {
      await vi.waitFor(() => expect(processIsAlive(pid)).toBe(false), { timeout: 1_000 });
    } finally {
      if (processIsAlive(pid)) {
        process.kill(pid, "SIGKILL");
      }
    }
    expect(processIsAlive(pid)).toBe(false);
  });

  it("kills task-owned fixture descendants when stopping the captured root", async () => {
    const root = tempDirs.make("mcp-fixture-descendant-cleanup-");
    const fixturePath = path.join(root, "fixture.mjs");
    const descendantPidPath = path.join(root, "descendant.pid");
    await fs.writeFile(
      fixturePath,
      `import {spawn} from "node:child_process"; import fs from "node:fs"; const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); fs.writeFileSync(${JSON.stringify(descendantPidPath)},String(child.pid)); console.log(JSON.stringify({type:"openclaw-mcp-parity-ready",urls:{streamableHttp:"http://127.0.0.1/mcp",sse:"http://127.0.0.1/sse"}})); setInterval(()=>{},1000);`,
      "utf8",
    );

    const fixture = await startHttpFixture({
      fixturePath,
      labelPrefix: "node",
      env: createChildEnv({ home: root, tempDir: os.tmpdir() }),
    });
    const descendantPid = Number(await fs.readFile(descendantPidPath, "utf8"));
    try {
      expect(processIsAlive(descendantPid)).toBe(true);

      await stopChild(fixture);

      await vi.waitFor(() => expect(processIsAlive(descendantPid)).toBe(false), { timeout: 1_000 });
    } finally {
      await stopChild(fixture);
      if (processIsAlive(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
    }
  });
});
