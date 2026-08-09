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
  AcceptedWorkspacePublicationIndeterminateError,
  isAcceptedWorkspacePublicationIndeterminateError,
} from "./workspace-accepted-publication.js";
import {
  createAcceptedWorkspacePublisherFactory,
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

function settlement(outcome: "begun" | "rolled-back" | "applied" | "committed"): SpawnResult {
  return result({ stdout: `${JSON.stringify({ version: 1, outcome })}\n` });
}

describe("accepted workspace publication", () => {
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
      if (!stagingRoot) {
        throw new Error("accepted transaction did not begin before transfer");
      }
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
    expect(manifestCalls).toEqual(["idempotent"]);
    expect(publishingSettled).toBe(false);
    await expect(fs.access(path.join(workspace, "result.txt"))).rejects.toThrow();
    expect(transactionCalls.some((entry) => entry.action === "rollback")).toBe(false);

    const gateWriter = await fs.open(gate, "w");
    await gateWriter.write("release");
    await gateWriter.close();
    await expect(publishing).resolves.toBeUndefined();
    if (!applyExited) {
      throw new Error("remote apply process was not started");
    }
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

  it("leaves publication pending when settle reaches its lock deadline behind a live apply", async () => {
    const root = tempDirs.make("openclaw-accepted-settle-deadline-");
    const local = path.join(root, "local");
    let workspace = path.join(root, "workspace");
    const gate = path.join(root, "gate.fifo");
    const applyMarker = path.join(root, "apply-started");
    const applyPreload = path.join(root, "apply-gate.cjs");
    const settlePreload = path.join(root, "settle-clock.cjs");
    await Promise.all([fs.mkdir(local), fs.mkdir(workspace)]);
    workspace = await fs.realpath(workspace);
    await Promise.all([
      fs.writeFile(path.join(local, "result.txt"), "local\n"),
      fs.writeFile(path.join(workspace, "result.txt"), "worker\n"),
    ]);
    expect((await runCommandWithTimeout(["mkfifo", gate], { timeoutMs: 10_000 })).code).toBe(0);
    const gateController = await fs.open(gate, "r+");
    let gateReleased = false;
    const releaseApply = async () => {
      if (gateReleased) {
        return;
      }
      gateReleased = true;
      await gateController.write("release");
      await gateController.close();
    };
    await Promise.all([
      fs.writeFile(
        applyPreload,
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
      ),
      fs.writeFile(
        settlePreload,
        `let now = 0;
Date.now = () => now;
Atomics.wait = function(waitArray, index, value, timeout) {
  now += 9 * 60 * 1000 + Number(timeout || 0) + 1;
  return "timed-out";
};
`,
      ),
    ]);
    const env = {
      ...process.env,
      OPENCLAW_TEST_GATE: gate,
      OPENCLAW_TEST_GATE_SOURCE: path.join(workspace, "result.txt"),
      OPENCLAW_TEST_APPLY_MARKER: applyMarker,
    };
    const remote = manifest("worker\n");
    const accepted = manifest("local\n");
    const transactionCalls: Array<{ action: string; nonce: string }> = [];
    let stagingRoot: string | undefined;
    let applyChild: ReturnType<typeof spawn> | undefined;
    let applyExited:
      | Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>
      | undefined;
    const runWorkspaceCommand = async (command: WorkerWorkspaceCommand): Promise<SpawnResult> => {
      const action =
        command.argv[2] === REMOTE_WORKSPACE_ACCEPTED_TRANSACTION_JS ? command.argv[3] : undefined;
      if (!action) {
        return result();
      }
      transactionCalls.push({ action, nonce: command.argv[5]! });
      if (action === "apply") {
        const child = spawn(
          process.execPath,
          ["--require", applyPreload, ...command.argv.slice(1)],
          { env, stdio: ["pipe", "pipe", "pipe"] },
        );
        applyChild = child;
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
        [
          process.execPath,
          ...(action === "settle" ? ["--require", settlePreload] : []),
          ...command.argv.slice(1),
        ],
        { timeoutMs: 10_000, baseEnv: env, input: command.input },
      );
      if (action === "begin" && commandResult.code === 0) {
        stagingRoot = commandResult.stdout.trim();
      }
      return commandResult;
    };
    const publisher = createAcceptedWorkspacePublisherFactory({
      runWorkspaceCommand,
      runRsync: async () => {
        if (!stagingRoot) {
          throw new Error("accepted transaction did not begin before transfer");
        }
        await fs.copyFile(path.join(local, "result.txt"), path.join(stagingRoot, "result.txt"));
        return result();
      },
      scpTarget: "test",
      localPath: local,
      remoteWorkspaceDir: workspace,
    })(remote, manifestRef(remote));

    try {
      const thrown = await publisher
        .publishAcceptedManifest({
          manifestRef: manifestRef(accepted),
          manifest: accepted,
          conflictPaths: ["result.txt"],
        })
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(AcceptedWorkspacePublicationIndeterminateError);
      expect(transactionCalls.map(({ action }) => action)).toEqual(["begin", "apply", "settle"]);
      expect(new Set(transactionCalls.map(({ nonce }) => nonce)).size).toBe(1);
      expect(transactionCalls.some(({ action }) => action === "rollback")).toBe(false);
      await expect(fs.access(path.join(workspace, "result.txt"))).rejects.toThrow();

      await releaseApply();
      if (!applyExited) {
        throw new Error("remote apply process was not started");
      }
      await expect(applyExited).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
      await expect(fs.readFile(path.join(workspace, "result.txt"), "utf8")).resolves.toBe(
        "local\n",
      );

      await recoverAcceptedWorkspacePublication({
        runWorkspaceCommand,
        remoteWorkspaceDir: workspace,
      });
      await expect(fs.readFile(path.join(workspace, "result.txt"), "utf8")).resolves.toBe(
        "worker\n",
      );
      expect(
        (await fs.readdir(root)).filter((name) => name.startsWith(".openclaw-accepted-")),
      ).toEqual([]);
    } finally {
      await releaseApply().catch(() => undefined);
      await applyExited?.catch(async () => {
        if (applyChild?.exitCode === null && applyChild.signalCode === null) {
          applyChild.kill("SIGTERM");
          await waitForChildClose(applyChild, 1_000).catch(() => undefined);
        }
      });
    }
  });

  it("keeps an unobservable apply pending when settlement is unobservable", async () => {
    const remote = manifest("worker\n");
    const accepted = manifest("local\n");
    const actions: string[] = [];
    const factory = createAcceptedWorkspacePublisherFactory({
      runWorkspaceCommand: async (command) => {
        if (command.argv[2] !== REMOTE_WORKSPACE_ACCEPTED_TRANSACTION_JS) {
          return result();
        }
        const action = command.argv[3];
        actions.push(action!);
        if (action === "begin") {
          return result({ stdout: "/remote/staging\n" });
        }
        if (action === "apply") {
          return result({ code: 255, stderr: "apply transport lost" });
        }
        if (action === "settle") {
          throw new WorkerTunnelOwnerDisconnectedError();
        }
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
    expect(thrown).toBeInstanceOf(AcceptedWorkspacePublicationIndeterminateError);
    expect(isAcceptedWorkspacePublicationIndeterminateError(thrown)).toBe(true);
    expect(thrown).toMatchObject({
      message: "Accepted workspace publication is indeterminate and requires recovery",
      operation: "apply",
      cause: expect.objectContaining({
        message: "Worker workspace sync failed: apply transport lost",
      }),
      observationFailure: expect.any(WorkerTunnelOwnerDisconnectedError),
    });
    expect(actions).toEqual(["begin", "apply", "settle"]);
  });

  it.each([
    {
      name: "an ordinary observed failure",
      apply: result({ code: 1, stderr: "apply rejected" }),
      settle: undefined,
      actions: ["begin", "apply", "rollback"],
    },
    {
      name: "settlement observes the begun phase",
      apply: result({ code: 255, stderr: "apply transport lost" }),
      settle: settlement("begun"),
      actions: ["begin", "apply", "settle", "rollback"],
    },
    {
      name: "settlement observes a completed rollback",
      apply: result({ code: 255, stderr: "apply transport lost" }),
      settle: settlement("rolled-back"),
      actions: ["begin", "apply", "settle", "rollback"],
    },
  ])("uses the safe rollback path after $name", async ({ apply, settle, actions: expected }) => {
    const remote = manifest("worker\n");
    const accepted = manifest("local\n");
    const actions: string[] = [];
    const publisher = createAcceptedWorkspacePublisherFactory({
      runWorkspaceCommand: async (command) => {
        if (command.argv[2] !== REMOTE_WORKSPACE_ACCEPTED_TRANSACTION_JS) {
          return result();
        }
        const action = command.argv[3]!;
        actions.push(action);
        if (action === "begin") {
          return result({ stdout: "/remote/staging\n" });
        }
        if (action === "apply") {
          return apply;
        }
        if (action === "settle") {
          if (!settle) {
            throw new Error("unexpected settlement");
          }
          return settle;
        }
        return result();
      },
      runRsync: async () => result(),
      scpTarget: "test",
      localPath: "/local",
      remoteWorkspaceDir: "/remote",
    })(remote, manifestRef(remote));

    await expect(
      publisher.publishAcceptedManifest({
        manifestRef: manifestRef(accepted),
        manifest: accepted,
        conflictPaths: ["result.txt"],
      }),
    ).rejects.toThrow(/apply (?:rejected|transport lost)/u);
    expect(actions).toEqual(expected);
  });

  it("keeps an ambiguous apply pending when settlement output is malformed", async () => {
    const remote = manifest("worker\n");
    const accepted = manifest("local\n");
    const actions: string[] = [];
    const publisher = createAcceptedWorkspacePublisherFactory({
      runWorkspaceCommand: async (command) => {
        if (command.argv[2] !== REMOTE_WORKSPACE_ACCEPTED_TRANSACTION_JS) {
          return result();
        }
        const action = command.argv[3]!;
        actions.push(action);
        if (action === "begin") {
          return result({ stdout: "/remote/staging\n" });
        }
        if (action === "apply") {
          return result({ code: 255, stderr: "apply transport lost" });
        }
        if (action === "settle") {
          return result({ stdout: '{"version":1,"outcome":"applied","extra":true}\n' });
        }
        return result();
      },
      runRsync: async () => result(),
      scpTarget: "test",
      localPath: "/local",
      remoteWorkspaceDir: "/remote",
    })(remote, manifestRef(remote));

    await expect(
      publisher.publishAcceptedManifest({
        manifestRef: manifestRef(accepted),
        manifest: accepted,
        conflictPaths: ["result.txt"],
      }),
    ).rejects.toBeInstanceOf(AcceptedWorkspacePublicationIndeterminateError);
    expect(actions).toEqual(["begin", "apply", "settle"]);
  });

  it.each([
    {
      name: "settlement observes the committed phase",
      outcome: "committed" as const,
      retry: false,
      secondCommit: result(),
      expected: "success" as const,
    },
    {
      name: "settlement observes applied and retries commit once",
      outcome: "applied" as const,
      retry: true,
      secondCommit: result(),
      expected: "success" as const,
    },
    {
      name: "the one safe commit retry is unobservable",
      outcome: "applied" as const,
      retry: true,
      secondCommit: result({ code: 255, stderr: "retry transport lost" }),
      expected: "pending" as const,
    },
    {
      name: "settlement observes the begun phase",
      outcome: "begun" as const,
      retry: false,
      secondCommit: result(),
      expected: "rollback" as const,
    },
    {
      name: "settlement observes a completed rollback",
      outcome: "rolled-back" as const,
      retry: false,
      secondCommit: result(),
      expected: "rollback" as const,
    },
    {
      name: "the one safe commit retry is rejected",
      outcome: "applied" as const,
      retry: true,
      secondCommit: result({ code: 1, stderr: "retry rejected" }),
      expected: "rollback" as const,
    },
  ])(
    "handles an ambiguous commit when $name",
    async ({ outcome, retry, secondCommit, expected }) => {
      const remote = manifest("worker\n");
      const accepted = manifest("local\n");
      const acceptedRef = manifestRef(accepted);
      const transactionCalls: Array<{ action: string; nonce: string }> = [];
      let commitCount = 0;
      const publisher = createAcceptedWorkspacePublisherFactory({
        runWorkspaceCommand: async (command) => {
          if (command.argv[2] !== REMOTE_WORKSPACE_ACCEPTED_TRANSACTION_JS) {
            return result({ stdout: command.argv[5] === "publish" ? "" : `${acceptedRef}\n` });
          }
          const action = command.argv[3]!;
          transactionCalls.push({ action, nonce: command.argv[5]! });
          if (action === "begin") {
            return result({ stdout: "/remote/staging\n" });
          }
          if (action === "commit") {
            commitCount += 1;
            return commitCount === 1
              ? result({ code: 255, stderr: "commit transport lost" })
              : secondCommit;
          }
          if (action === "settle") {
            return settlement(outcome);
          }
          return result();
        },
        runRsync: async () => result(),
        scpTarget: "test",
        localPath: "/local",
        remoteWorkspaceDir: "/remote",
      })(remote, manifestRef(remote));

      const publishing = publisher.publishAcceptedManifest({
        manifestRef: acceptedRef,
        manifest: accepted,
        conflictPaths: ["result.txt"],
      });

      if (expected === "success") {
        await expect(publishing).resolves.toBeUndefined();
      } else if (expected === "pending") {
        await expect(publishing).rejects.toBeInstanceOf(
          AcceptedWorkspacePublicationIndeterminateError,
        );
      } else {
        await expect(publishing).rejects.toThrow(/commit transport lost|retry rejected/u);
      }
      expect(transactionCalls.map(({ action }) => action)).toEqual([
        "begin",
        "apply",
        "commit",
        "settle",
        ...(retry ? ["commit"] : []),
        ...(expected === "rollback" ? ["rollback"] : []),
      ]);
      expect(new Set(transactionCalls.map(({ nonce }) => nonce)).size).toBe(1);
      expect(transactionCalls.some(({ action }) => action === "rollback")).toBe(
        expected === "rollback",
      );
    },
  );

  it("rolls back after an ordinary observed commit failure", async () => {
    const remote = manifest("worker\n");
    const accepted = manifest("local\n");
    const acceptedRef = manifestRef(accepted);
    const actions: string[] = [];
    const publisher = createAcceptedWorkspacePublisherFactory({
      runWorkspaceCommand: async (command) => {
        if (command.argv[2] !== REMOTE_WORKSPACE_ACCEPTED_TRANSACTION_JS) {
          return result({ stdout: command.argv[5] === "publish" ? "" : `${acceptedRef}\n` });
        }
        const action = command.argv[3]!;
        actions.push(action);
        if (action === "begin") {
          return result({ stdout: "/remote/staging\n" });
        }
        if (action === "commit") {
          return result({ code: 1, stderr: "commit rejected" });
        }
        return result();
      },
      runRsync: async () => result(),
      scpTarget: "test",
      localPath: "/local",
      remoteWorkspaceDir: "/remote",
    })(remote, manifestRef(remote));

    await expect(
      publisher.publishAcceptedManifest({
        manifestRef: acceptedRef,
        manifest: accepted,
        conflictPaths: ["result.txt"],
      }),
    ).rejects.toThrow("commit rejected");
    expect(actions).toEqual(["begin", "apply", "commit", "rollback"]);
  });
});
