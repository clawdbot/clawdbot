import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQaGatewayChild } from "./gateway-child.js";
import { isQaPosixProcessGroupAlive, signalQaPosixProcessGroup } from "./posix-process-group.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const boundary = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("./gateway-process-boundary.js", async (original) => ({
  ...(await original<typeof import("./gateway-process-boundary.js")>()),
  createQaGatewayProcessBoundaryController: boundary.create,
}));
// These tests own child lifetime, not the Gateway WebSocket protocol. HTTP
// readiness, spawning, termination, liveness probes, and artifacts stay real.
vi.mock("./gateway-rpc-client.js", () => ({
  startQaGatewayRpcClient: async () => ({ request: async () => ({}), stop: async () => {} }),
}));

const dirs = createTempDirHarness();
const owners: ReturnType<typeof createQaGatewayChild>[] = [];
const groups: number[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  boundary.create.mockReset();
  for (const owner of owners) {
    await owner.stop();
  }
  for (const group of groups) {
    if (isQaPosixProcessGroupAlive(group)) {
      expect(signalQaPosixProcessGroup(group, "SIGKILL")).toBeUndefined();
    }
    await vi.waitFor(() => expect(isQaPosixProcessGroupAlive(group)).toBe(false));
  }
  owners.length = 0;
  groups.length = 0;
  await dirs.cleanup();
});

async function fixture(failReplacement: boolean | "descendant" = false) {
  const root = await dirs.makeTempDir("qa-lifetime-");
  const record = path.join(root, "children.json");
  const cli = path.join(root, "gateway.mjs");
  await fs.writeFile(
    cli,
    `
import fs from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
const [record, failReplacement, command, ...args] = process.argv.slice(2);
if (command === "descendant") {
  process.on("SIGTERM", () => {});
  setTimeout(() => process.exit(0), 30_000);
  const output = setInterval(() => {
    if (fs.existsSync(record + ".emit")) {
      console.log("QA_DESCENDANT_STILL_OWNED");
      clearInterval(output);
    }
  }, 25);
  process.send("ready");
} else if (command === "models") {
  for await (const ignored of process.stdin) {}
  process.exit(0);
}
if (command === "gateway") {
const previous = fs.existsSync(record) ? JSON.parse(fs.readFileSync(record, "utf8")) : [];
fs.writeFileSync(record, JSON.stringify([...previous, process.pid]));
fs.writeSync(1, "QA_GATEWAY_ATTEMPT_" + (previous.length + 1) + " apiKey=synthetic-fixture-secret\\n");
if (previous.length && failReplacement !== "false") {
  if (failReplacement === "descendant") {
    const descendant = spawn(process.execPath, [process.argv[1], record, "false", "descendant"], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    await once(descendant, "message");
  }
  process.exit(17);
}
http.createServer((_request, response) => response.end("ok")).listen(Number(args[args.indexOf("--port") + 1]), "127.0.0.1");
}
`,
  );
  const params = {
    repoRoot: process.cwd(),
    command: {
      executablePath: process.execPath,
      argsPrefix: [cli, record, String(failReplacement)],
      usePackagedPlugins: true,
      tempParentDir: root,
    },
    transportBaseUrl: "http://127.0.0.1:1",
    controlUiEnabled: false,
  };
  const pids = () => {
    const children = JSON.parse(readFileSync(record, "utf8")) as number[];
    for (const pid of children) {
      if (!groups.includes(pid)) {
        groups.push(pid);
      }
    }
    return children;
  };
  return { root, params, pids, emitOutput: () => fs.writeFile(record + ".emit", "") };
}

function own(params: Parameters<ReturnType<typeof createQaGatewayChild>["start"]>[0]) {
  const owner = createQaGatewayChild();
  owners.push(owner);
  return { start: () => owner.start(params), stop: owner.stop };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe.skipIf(process.platform === "win32")("QA gateway lifetime ownership", () => {
  it("reports never spawned when preparation fails", async () => {
    const root = await dirs.makeTempDir("qa-lifetime-missing-");
    const owner = own({
      repoRoot: root,
      command: { executablePath: process.execPath, tempParentDir: path.join(root, "absent") },
      transportBaseUrl: "http://127.0.0.1:1",
    });
    await expect(owner.start()).rejects.toThrow("ENOENT");
    await expect(owner.stop()).resolves.toEqual({ process: "never-spawned", errors: [] });
  });

  it("closes startup admission before asynchronous preparation can spawn", async () => {
    const { root, params } = await fixture();
    const owner = own(params);
    const start = owner.start();
    const rejected = expect(start).rejects.toThrow("lifecycle is closed");
    await expect(owner.stop()).resolves.toEqual({ process: "never-spawned", errors: [] });
    await rejected;
    expect(await fs.readdir(root)).toEqual(["gateway.mjs"]);
  });

  it("retains the startup error and confirms teardown after listening fails", async () => {
    const { params, pids } = await fixture();
    const failure = new Error("listening callback failed");
    const owner = own({
      ...params,
      onListening: () => {
        pids();
        throw failure;
      },
    });
    await expect(owner.start()).rejects.toMatchObject({ cause: failure });
    await expect(owner.stop()).resolves.toEqual({ process: "confirmed-stopped", errors: [] });
    expect(pids().every((pid) => !isQaPosixProcessGroupAlive(pid))).toBe(true);
  });

  it("owns an unaccepted launcher and separates boundary diagnostics from termination", async () => {
    const { params } = await fixture();
    const rejected = new Error("verified acceptance failed");
    const diagnostic = new Error("boundary evidence write failed");
    boundary.create.mockResolvedValue({
      prepare: async ({ env }: { env: NodeJS.ProcessEnv }) => ({ env }),
      accept: async ({ child }: { child: { pid: number } }) => {
        groups.push(child.pid);
        throw rejected;
      },
      abort: async () => {
        throw diagnostic;
      },
    });
    const owner = own({
      ...params,
      command: {
        ...params.command,
        processBoundary: {
          kind: "linux-proc-v1",
          evidenceDir: params.command.tempParentDir,
          expectedGid: 1,
          expectedUid: 1,
          forwardedEnvKeys: [],
          runtimeArgsPrefix: [],
          runtimeExecutablePath: process.execPath,
          terminationRetryTimeoutMs: 45_000,
        },
      },
    });
    const error = await owner.start().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors[0]).toMatchObject({
      message: expect.stringContaining(rejected.message),
    });
    await expect(owner.stop()).resolves.toEqual({
      process: "confirmed-stopped",
      errors: [diagnostic],
    });
    expect(groups.every((pid) => !isQaPosixProcessGroupAlive(pid))).toBe(true);
  });

  it("settles a failed replacement, not only its stopped predecessor", async () => {
    const { params, pids } = await fixture(true);
    const owner = own(params);
    const gateway = await owner.start();
    pids();
    await expect(gateway.restartAfterStateMutation(async () => {})).rejects.toThrow("exitCode=17");
    await expect(owner.stop()).resolves.toEqual({ process: "confirmed-stopped", errors: [] });
    expect(pids()).toHaveLength(2);
    expect(pids().every((pid) => !isQaPosixProcessGroupAlive(pid))).toBe(true);
  });

  it.each(["startup", "replacement"] as const)(
    "preserves sanitized log evidence when explicit stop follows %s failure",
    async (phase) => {
      const { params, pids } = await fixture(phase === "replacement");
      const owner = own({
        ...params,
        onListening: () => {
          pids();
          if (phase === "startup") {
            throw new Error("fixture listening failed");
          }
        },
      });
      if (phase === "startup") {
        await expect(owner.start()).rejects.toThrow("fixture listening failed");
      } else {
        const gateway = await owner.start();
        await expect(gateway.restartAfterStateMutation(async () => {})).rejects.toThrow(
          "exitCode=17",
        );
      }
      const artifactRoot = path.join(process.cwd(), ".artifacts/qa-e2e/startup-lease-fix");
      await fs.mkdir(artifactRoot, { recursive: true });
      const preserveToDir = await fs.mkdtemp(path.join(artifactRoot, "preserved-log-"));
      try {
        await expect(owner.stop({ preserveToDir })).resolves.toEqual({
          process: "confirmed-stopped",
          errors: [],
        });
        const log = await fs.readFile(path.join(preserveToDir, "gateway.stdout.log"), "utf8");
        expect(log).toContain(`QA_GATEWAY_ATTEMPT_${phase === "startup" ? 1 : 2}`);
        expect(log).toContain("apiKey=<redacted>");
        expect(log).not.toContain("synthetic-fixture-secret");
        expect(pids().every((pid) => !isQaPosixProcessGroupAlive(pid))).toBe(true);
      } finally {
        await fs.rm(preserveToDir, { recursive: true, force: true });
      }
    },
  );

  it("retains a failed replacement group until a later stop confirms termination", async () => {
    const { params, pids, emitOutput } = await fixture("descendant");
    const owner = own(params);
    const gateway = await owner.start();
    const [predecessor] = pids();
    const realKill = process.kill.bind(process);
    let terminationPending = false;
    let overlappingTermination = false;
    const signalFault = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      const replacement = pids()[1];
      if (replacement && pid === -replacement && (signal === "SIGTERM" || signal === "SIGKILL")) {
        if (signal === "SIGTERM") {
          overlappingTermination ||= terminationPending;
          terminationPending = true;
        } else {
          terminationPending = false;
        }
        throw Object.assign(new Error("owned replacement signal denied"), { code: "EPERM" });
      }
      return realKill(pid, signal);
    });
    try {
      await expect(gateway.restartAfterStateMutation(async () => {})).rejects.toBeInstanceOf(
        AggregateError,
      );
      const [stopped] = await Promise.all([owner.stop(), owner.stop()]);
      expect(overlappingTermination).toBe(false);
      expect(stopped.process).toBe("unconfirmed");
      expect(stopped.errors.length).toBeGreaterThan(0);
      expect(isQaPosixProcessGroupAlive(predecessor!)).toBe(false);
      expect(isQaPosixProcessGroupAlive(pids()[1]!)).toBe(true);
      await expect(fs.stat(gateway.tempRoot)).resolves.toBeDefined();
      await emitOutput();
      await vi.waitFor(async () =>
        expect(
          await fs.readFile(path.join(gateway.tempRoot, "gateway.stdout.log"), "utf8"),
        ).toContain("QA_DESCENDANT_STILL_OWNED"),
      );
    } finally {
      signalFault.mockRestore();
    }
    await expect(owner.stop()).resolves.toEqual({ process: "confirmed-stopped", errors: [] });
    expect(pids().every((pid) => !isQaPosixProcessGroupAlive(pid))).toBe(true);
  });

  it("does not spawn a replacement after stop closes an awaited mutation", async () => {
    const { params, pids } = await fixture();
    const owner = own(params);
    const gateway = await owner.start();
    pids();
    const entered = deferred();
    const release = deferred();
    const restarting = gateway.restartAfterStateMutation(async () => {
      entered.resolve();
      await release.promise;
    });
    const rejected = expect(restarting).rejects.toThrow("lifecycle is closed");
    await entered.promise;
    const stopping = owner.stop();
    release.resolve();
    await rejected;
    await expect(stopping).resolves.toEqual({ process: "confirmed-stopped", errors: [] });
    expect(pids()).toHaveLength(1);
  });

  it("reports artifact failure while still confirming process shutdown", async () => {
    const { params, pids } = await fixture();
    const owner = own(params);
    const gateway = await owner.start();
    pids();
    const result = await owner.stop({
      preserveToDir: path.resolve(process.cwd(), "../qa-artifacts-outside-repo"),
    });
    expect(result.process).toBe("confirmed-stopped");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(pids().every((pid) => !isQaPosixProcessGroupAlive(pid))).toBe(true);
    expect(await fs.stat(gateway.tempRoot)).toBeDefined();
  });
});
