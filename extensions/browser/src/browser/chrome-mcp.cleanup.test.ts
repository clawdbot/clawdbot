import childProcess, { type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net, { type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { promisify } from "node:util";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createChromeMcpSession } from "./chrome-mcp-connect.js";
import { buildChromeMcpSessionCacheKey } from "./chrome-mcp-options.js";
import {
  closeTrackedChromeMcpSession,
  parseChromeMcpUnixProcessListForTest,
} from "./chrome-mcp-process.js";
import { leaseSession } from "./chrome-mcp-session.js";
import {
  chromeMcpCleanupPromises,
  retainedChromeMcpCleanupSessions,
  setChromeMcpProcessCleanupDeps,
  setChromeMcpSessionFactory,
} from "./chrome-mcp-state.js";

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ child: () => ({ warn: vi.fn() }) }),
}));

afterEach(() => {
  setChromeMcpProcessCleanupDeps(null);
  setChromeMcpSessionFactory(null);
  vi.restoreAllMocks();
});

async function createHeldStdioPeer({
  earlyDescendant = false,
  releaseCapture,
}: {
  earlyDescendant?: boolean;
  releaseCapture?: () => void;
} = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "chrome-mcp-cleanup-")));
  const script = path.join(root, "peer.mjs");
  const sockets = new Set<Socket>();
  const socketClosures: Promise<void>[] = [];
  const connected = new Map<string, Socket>();
  const waiters = new Map<string, (socket: Socket) => void>();
  const waitFor = (event: string) => {
    const socket = connected.get(event);
    return socket
      ? Promise.resolve(socket)
      : new Promise<Socket>((resolve) => {
          waiters.set(event, resolve);
        });
  };
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socketClosures.push(
      new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
      }),
    );
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {}); // The owned peer may exit while teardown sends its release.
    if (disposing) {
      socket.end("release\n");
    }
    let pending = "";
    socket.on("data", (chunk) => {
      pending += chunk.toString();
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) {
          return;
        }
        const event = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        connected.set(event, socket);
        waiters.get(event)?.(socket);
      }
    });
  });
  let child: ChildProcess | undefined;
  let childClosed: Promise<unknown> | undefined;
  const resources: { creation?: ReturnType<typeof createChromeMcpSession> } = {};
  let disposing: Promise<void> | undefined;
  const options = { command: process.execPath, args: [script] };
  const cacheKey = buildChromeMcpSessionCacheKey("cleanup-fixture", options);
  const dispose = () =>
    (disposing ??= (async () => {
      releaseCapture?.();
      // This independent fixture channel releases only these exact peers, including
      // an untracked descendant when testing a deliberately failed process census.
      for (const socket of sockets) {
        socket.end("release\n");
      }
      if (resources.creation) {
        const session = await resources.creation.promise;
        await closeTrackedChromeMcpSession(cacheKey, session).catch(() => {});
        await resources.creation.cleanup;
        await chromeMcpCleanupPromises.get(session)?.catch(() => {});
      }
      await childClosed;
      await Promise.all(socketClosures);
      // Test-only state can be discarded only after the fixture peers have closed.
      retainedChromeMcpCleanupSessions.delete(cacheKey);
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
      await fs.rm(root, { recursive: true, force: true });
    })());
  onTestFinished(dispose);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing fixture listener");
  }
  await fs.writeFile(
    script,
    `import { spawn } from "node:child_process";
import net from "node:net";
import { createInterface } from "node:readline";
const control = net.connect(${address.port}, "127.0.0.1");
const descendant = process.argv[2] === "descendant";
control.on("connect", () => {
  control.write((descendant ? "descendant" : "root") + "\\n");
  if (descendant) process.send("ready");
});
control.on("data", () => process.exit(0));
control.on("close", () => process.exit(0));
if (!descendant) {
  const spawnDescendant = (ready) => {
    const child = spawn(process.execPath, [${JSON.stringify(script)}, "descendant"], {
      stdio: ["ignore", ${earlyDescendant ? '"ignore", "ignore"' : '"inherit", "inherit"'}, "ipc"],
    });
    child.once("message", () => { child.disconnect(); ready(); });
  };
  if (${earlyDescendant}) spawnDescendant(() => control.write("early-descendant-ready\\n"));
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    const request = JSON.parse(line);
    if (request.method !== "initialize") return;
    control.write("initialize\\n");
    spawnDescendant(() => {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id,
        error: { code: -32000, message: "fixture initialization failed" } }) + "\\n");
    });
  });
  input.on("close", () => control.write("stdin-ended\\n"));
}
`,
  );
  const spawn = childProcess.spawn;
  vi.spyOn(childProcess, "spawn").mockImplementation((...args: Parameters<typeof spawn>) => {
    const spawned = spawn(...args);
    if (args[0] === process.execPath && Array.isArray(args[1]) && args[1][0] === script) {
      child = spawned;
      childClosed = once(spawned, "close");
    }
    return spawned;
  });
  resources.creation = createChromeMcpSession(cacheKey, "cleanup-fixture", options);
  const session = await resources.creation.promise;
  if (!child) {
    throw new Error("SDK did not spawn the fixture child");
  }
  return {
    session,
    cacheKey,
    options,
    events: connected,
    exactChild: child,
    exited: once(child, "exit"),
    closed: childClosed,
    waitFor,
    dispose,
  };
}

// POSIX keeps the exact SDK child alive at EOF; Windows deliberately taskkills the tree first.
describe.skipIf(process.platform === "win32")("Chrome MCP SDK-initiated cleanup", () => {
  it.each([false, true])(
    "joins failed initialization and fences replacement (ephemeral=%s)",
    async (ephemeral) => {
      const fixture = await createHeldStdioPeer();
      const { session, cacheKey, exactChild } = fixture;
      try {
        let settled = 0;
        const readiness = session.ready.finally(() => {
          settled += 1;
        });
        void readiness.catch(() => {});
        const rootControl = await fixture.waitFor("stdin-ended");
        await fixture.waitFor("descendant");
        expect(exactChild.exitCode).toBeNull();
        expect(session.transport.pid).toBeNull();
        const cleanup = Promise.all(
          [
            closeTrackedChromeMcpSession(cacheKey, session),
            session.client.close(),
            session.transport.close(),
          ].map((closing) =>
            closing.finally(() => {
              settled += 1;
            }),
          ),
        );
        void cleanup.catch(() => {});
        const replacementFactory = vi.fn(async () => {
          throw new Error("replacement admitted");
        });
        setChromeMcpSessionFactory(replacementFactory);
        const replacement = leaseSession("cleanup-fixture", fixture.options, { ephemeral });
        const replacementResult = expect(replacement).rejects.toThrow("replacement admitted");
        await setImmediate();
        expect(
          settled,
          "readiness and every close must join shutdown while the exact child is alive",
        ).toBe(0);
        expect(replacementFactory).not.toHaveBeenCalled();
        expect(session.processCleanup).toMatchObject({
          status: "tracked",
          target: { root: { pid: exactChild.pid }, descendants: [expect.any(Object)] },
        });
        rootControl.end("release\n");
        await fixture.exited;
        await cleanup;
        await fixture.closed;
        await expect(readiness).rejects.toThrow("fixture initialization failed");
        expect(settled).toBe(4);
        await replacementResult;
        expect(replacementFactory).toHaveBeenCalledOnce();
        expect(session.processCleanup?.status).toBe("closed");
        expect(exactChild.exitCode).toBe(0);
        expect((await fixture.waitFor("descendant")).destroyed).toBe(true);
      } finally {
        await fixture.dispose();
      }
    },
  );

  it("does not admit initialize after close interrupts the initial process snapshot", async () => {
    const scanStarted = createDeferred<void>();
    const releaseScan = createDeferred<void>();
    setChromeMcpProcessCleanupDeps({
      listProcesses: async () => {
        const { stdout } = await promisify(childProcess.execFile)(
          "ps",
          ["-axww", "-o", "pid=,ppid=,lstart=,command="],
          { env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, maxBuffer: 4 * 1024 * 1024 },
        );
        const snapshots = parseChromeMcpUnixProcessListForTest(stdout, process.platform);
        scanStarted.resolve();
        await releaseScan.promise;
        return snapshots;
      },
    });
    const fixture = await createHeldStdioPeer({ releaseCapture: releaseScan.resolve });
    try {
      await Promise.race([scanStarted.promise, fixture.session.ready]);
      const closing = closeTrackedChromeMcpSession(fixture.cacheKey, fixture.session);
      void closing.catch(() => {});
      releaseScan.resolve();
      const rootControl = await fixture.waitFor("stdin-ended");
      rootControl.end("release\n");
      await closing;
      expect(fixture.events.has("initialize")).toBe(false);
      expect(fixture.events.has("descendant")).toBe(false);
      await expect(fixture.session.ready).rejects.toThrow("Chrome MCP session is closing");
      expect(fixture.session.processCleanup?.status).toBe("closed");
    } finally {
      releaseScan.resolve();
      await fixture.dispose();
    }
  });

  it("retains failed initial capture after the child exits with an untracked descendant", async () => {
    const scanStarted = createDeferred<void>();
    const releaseScan = createDeferred<void>();
    setChromeMcpProcessCleanupDeps({
      listProcesses: async () => {
        scanStarted.resolve();
        await releaseScan.promise;
        throw new Error("fixture process census failed");
      },
    });
    const fixture = await createHeldStdioPeer({
      earlyDescendant: true,
      releaseCapture: releaseScan.resolve,
    });
    try {
      await scanStarted.promise;
      await fixture.waitFor("early-descendant-ready");
      const rootControl = await fixture.waitFor("root");
      const descendantControl = await fixture.waitFor("descendant");
      rootControl.end("release\n");
      await fixture.closed;
      releaseScan.resolve();
      await fixture.session.ready.catch(() => {});
      expect(fixture.events.has("initialize")).toBe(false);
      expect(fixture.session.transport.pid).toBeNull();
      expect(descendantControl.destroyed).toBe(false);
      expect(fixture.session.processCleanup?.status).toBe("uncertain");
      await expect(fixture.session.ready).rejects.toThrow(
        "subprocess tree cleanup could not be verified",
      );
      await expect(closeTrackedChromeMcpSession(fixture.cacheKey, fixture.session)).rejects.toThrow(
        "subprocess tree cleanup could not be verified",
      );
      const replacementFactory = vi.fn(async () => {
        throw new Error("replacement admitted");
      });
      setChromeMcpSessionFactory(replacementFactory);
      await expect(leaseSession("cleanup-fixture", fixture.options)).rejects.toThrow(
        "subprocess tree cleanup could not be verified",
      );
      expect(replacementFactory).not.toHaveBeenCalled();
    } finally {
      releaseScan.resolve();
      await fixture.dispose();
    }
  });
});

it.each([
  { name: "native argument validation", command: process.execPath, args: ["\0"] },
  {
    name: "missing executable",
    command: path.join(os.tmpdir(), "absent-chrome-mcp", "missing"),
    args: [],
  },
])("settles cleanup after $name fails without a child", async (options) => {
  const cacheKey = buildChromeMcpSessionCacheKey("failed-spawn", options);
  const creation = createChromeMcpSession(cacheKey, "failed-spawn", options);
  const session = await creation.promise;
  await expect(session.ready).rejects.toThrow();
  await closeTrackedChromeMcpSession(cacheKey, session);
  await creation.cleanup;
  expect(session.processCleanup?.status).toBe("closed");
  expect(session.transport.pid).toBeNull();
});
