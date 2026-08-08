import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { waitForChildClose, waitForFile } from "../../../test/helpers/process-wait.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCommandWithTimeout, type SpawnResult } from "../../process/exec.js";
import { createDeferred } from "../../shared/deferred.js";
import {
  WorkerTunnelOwnerDisconnectedError,
  type WorkerWorkspaceCommand,
} from "./tunnel-contract.js";
import {
  createAcceptedWorkspacePublisherFactory,
  isIndeterminateWorkspaceApplyResult,
  recoverAcceptedWorkspacePublication,
} from "./workspace-accepted-sync.js";
import {
  serializeWorkerWorkspaceManifest,
  type WorkerWorkspaceManifest,
} from "./workspace-manifest.js";
import {
  REMOTE_WORKSPACE_ACCEPTED_TRANSACTION_JS,
  REMOTE_WORKSPACE_MANIFEST_JS,
} from "./workspace-sync-scripts.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function result(overrides: Partial<SpawnResult> = {}): SpawnResult {
  return {
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    ...overrides,
  };
}

function manifest(content: string): WorkerWorkspaceManifest {
  return {
    version: 1,
    baseCommit: null,
    entries: [
      {
        path: "result.txt",
        type: "file",
        mode: 0o644,
        size: Buffer.byteLength(content),
        sha256: createHash("sha256").update(content).digest("hex"),
      },
    ],
  };
}

function manifestRef(value: WorkerWorkspaceManifest): string {
  return `sha256:${createHash("sha256").update(serializeWorkerWorkspaceManifest(value)).digest("hex")}`;
}

describe("accepted workspace publication", () => {
  it.each([
    ["successful exit", result(), false],
    ["ordinary remote failure", result({ code: 1 }), false],
    ["SSH transport exit", result({ code: 255 }), true],
    ["timeout", result({ code: null, killed: true, termination: "timeout" }), true],
    ["no-output timeout", result({ code: null, termination: "no-output-timeout" }), true],
    ["signal", result({ code: null, signal: "SIGTERM", termination: "signal" }), true],
  ] as const)("classifies %s ambiguity", (_name, commandResult, expected) => {
    expect(isIndeterminateWorkspaceApplyResult(commandResult)).toBe(expected);
  });

  it("settles a still-running apply after SSH loses its exit status", async () => {
    const root = tempDirs.make("openclaw-accepted-ssh-loss-");
    const local = path.join(root, "local");
    let workspace = path.join(root, "workspace");
    const gate = path.join(root, "gate.fifo");
    const applyMarker = path.join(root, "apply-started");
    const settleStarted = createDeferred();
    const preload = path.join(root, "gate.cjs");
    await Promise.all([fs.mkdir(local), fs.mkdir(workspace)]);
    workspace = await fs.realpath(workspace);
    await Promise.all([
      fs.writeFile(path.join(local, "result.txt"), "local\n"),
      fs.writeFile(path.join(workspace, "result.txt"), "worker\n"),
    ]);
    expect((await runCommandWithTimeout(["mkfifo", gate], { timeoutMs: 10_000 })).code).toBe(0);
    await fs.writeFile(
      preload,
      `const fs = require("node:fs");
const path = require("node:path");
const renameSync = fs.renameSync;
let gated = false;
fs.renameSync = function(source, destination) {
  const value = renameSync.apply(this, arguments);
  if (!gated && process.argv[1] === "apply" && source === process.env.OPENCLAW_TEST_GATE_SOURCE && destination.includes(path.sep + "backup" + path.sep)) {
    gated = true;
    fs.writeFileSync(process.env.OPENCLAW_TEST_APPLY_MARKER, "");
    fs.readFileSync(process.env.OPENCLAW_TEST_GATE);
  }
  return value;
};
`,
    );
    const env = {
      ...process.env,
      OPENCLAW_TEST_GATE: gate,
      OPENCLAW_TEST_GATE_SOURCE: path.join(workspace, "result.txt"),
      OPENCLAW_TEST_APPLY_MARKER: applyMarker,
    };
    const remote = manifest("worker\n");
    const accepted = manifest("local\n");
    const acceptedRef = manifestRef(accepted);
    const transactionCalls: Array<{
      action: string;
      nonce: string;
      transportRetry: WorkerWorkspaceCommand["transportRetry"];
    }> = [];
    const manifestCalls: Array<WorkerWorkspaceCommand["transportRetry"]> = [];
    let stagingRoot: string | undefined;
    let applyExited:
      | Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>
      | undefined;
    const runWorkspaceCommand = async (command: WorkerWorkspaceCommand): Promise<SpawnResult> => {
      const transactionAction =
        command.argv[2] === REMOTE_WORKSPACE_ACCEPTED_TRANSACTION_JS ? command.argv[3] : undefined;
      if (!transactionAction) {
        expect(command.argv[2]).toBe(REMOTE_WORKSPACE_MANIFEST_JS);
        manifestCalls.push(command.transportRetry);
        return result({ stdout: command.argv[5] === "publish" ? "" : `${acceptedRef}\n` });
      }
      transactionCalls.push({
        action: transactionAction,
        nonce: command.argv[5]!,
        transportRetry: command.transportRetry,
      });
      if (transactionAction === "settle") {
        settleStarted.resolve();
      }
      if (transactionAction === "apply") {
        const child = spawn(process.execPath, ["--require", preload, ...command.argv.slice(1)], {
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
        child.stdin.end(command.input);
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
        });
        applyExited = waitForChildClose(child, 10_000).then(({ code, signal }) => ({
          code,
          signal,
          stderr,
        }));
        await waitForFile(applyMarker, 10_000);
        return result({ code: 255, stderr: "connection lost after remote apply started" });
      }
      const commandResult = await runCommandWithTimeout(
        [process.execPath, ...command.argv.slice(1)],
        {
          timeoutMs: 10_000,
          baseEnv: env,
          input: command.input,
        },
      );
      if (transactionAction === "begin" && commandResult.code === 0) {
        stagingRoot = commandResult.stdout.trim();
      }
      return commandResult;
    };
    const runRsync = async (): Promise<SpawnResult> => {
      if (!stagingRoot) throw new Error("accepted transaction did not begin before transfer");
      await fs.copyFile(path.join(local, "result.txt"), path.join(stagingRoot, "result.txt"));
      return result();
    };
    const publisher = createAcceptedWorkspacePublisherFactory({
      runWorkspaceCommand,
      runRsync,
      scpTarget: "test",
      localPath: local,
      remoteWorkspaceDir: workspace,
    })(remote, manifestRef(remote));

    const publishing = publisher.publishAcceptedManifest({
      manifestRef: acceptedRef,
      manifest: accepted,
      conflictPaths: ["result.txt"],
    });
    let publishingSettled = false;
    void publishing.then(
      () => {
        publishingSettled = true;
      },
      () => {
        publishingSettled = true;
      },
    );
    await waitForFile(applyMarker, 10_000);
    await settleStarted.promise;
    expect(transactionCalls.map((entry) => entry.action)).toEqual(["begin", "apply", "settle"]);
    expect(new Set(transactionCalls.map((entry) => entry.nonce)).size).toBe(1);
    expect(transactionCalls.every((entry) => entry.transportRetry === "never")).toBe(true);
    expect(manifestCalls).toEqual(["idempotent", "idempotent"]);
    expect(publishingSettled).toBe(false);
    await expect(fs.access(path.join(workspace, "result.txt"))).rejects.toThrow();
    expect(transactionCalls.some((entry) => entry.action === "rollback")).toBe(false);

    const gateWriter = await fs.open(gate, "w");
    await gateWriter.write("release");
    await gateWriter.close();
    await expect(publishing).resolves.toBeUndefined();
    if (!applyExited) throw new Error("remote apply process was not started");
    await expect(applyExited).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(transactionCalls.map((entry) => entry.action)).toEqual([
      "begin",
      "apply",
      "settle",
      "commit",
    ]);
    expect(new Set(transactionCalls.map((entry) => entry.nonce)).size).toBe(1);
    expect(transactionCalls.every((entry) => entry.transportRetry === "never")).toBe(true);
    expect(manifestCalls).toEqual(["idempotent", "idempotent"]);
    await expect(fs.readFile(path.join(workspace, "result.txt"), "utf8")).resolves.toBe("local\n");
    await expect(fs.readFile(path.join(local, "result.txt"), "utf8")).resolves.toBe("local\n");

    await recoverAcceptedWorkspacePublication({
      runWorkspaceCommand,
      remoteWorkspaceDir: workspace,
    });
    expect(transactionCalls.map((entry) => entry.action)).toEqual([
      "begin",
      "apply",
      "settle",
      "commit",
      "recover",
    ]);
    expect(transactionCalls.every((entry) => entry.transportRetry === "never")).toBe(true);
    expect(
      (await fs.readdir(root)).filter((name) => name.startsWith(".openclaw-accepted-")),
    ).toEqual([]);
  });

  it("preserves the apply failure when settlement and rollback both throw", async () => {
    const rollbackFailure = new WorkerTunnelOwnerDisconnectedError();
    const remote = manifest("worker\n");
    const accepted = manifest("local\n");
    const factory = createAcceptedWorkspacePublisherFactory({
      runWorkspaceCommand: async (command) => {
        if (command.argv[2] !== REMOTE_WORKSPACE_ACCEPTED_TRANSACTION_JS) return result();
        const action = command.argv[3];
        if (action === "begin") return result({ stdout: "/remote/staging\n" });
        if (action === "apply") return result({ code: 255, stderr: "apply transport lost" });
        if (action === "settle") throw new WorkerTunnelOwnerDisconnectedError();
        if (action === "rollback") throw rollbackFailure;
        return result();
      },
      runRsync: async () => result(),
      scpTarget: "test",
      localPath: "/local",
      remoteWorkspaceDir: "/remote",
    });

    const publishing = factory(remote, manifestRef(remote)).publishAcceptedManifest({
      manifestRef: manifestRef(accepted),
      manifest: accepted,
      conflictPaths: ["result.txt"],
    });
    const thrown = await publishing.catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toMatchObject({
      message: "Accepted workspace publication rollback failed",
      cause: expect.objectContaining({
        message: "Worker workspace sync failed: apply transport lost",
      }),
      rollbackFailure,
    });
  });
});
