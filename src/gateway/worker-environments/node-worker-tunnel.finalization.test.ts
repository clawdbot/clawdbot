import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  inspectNodeWorkerProcessIdentity,
  requireNodeWorkerProcessIdentity,
  type NodeWorkerProcessIdentity,
} from "../../node-host/node-worker-process-identity.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  parseNodeWorkerWorkspaceExecInput,
  type NodeWorkerWorkspaceExecInput,
} from "../../worker/node-workspace-protocol.js";
import { createNodeWorkerWorkspaceActions } from "./node-worker-workspace-actions.js";
import {
  createNodeWorkspaceTransferHttpCallback,
  handleNodeWorkspaceTransferHttpRequest,
  type NodeWorkspaceTransferHttpCallback,
} from "./node-workspace-transfer-http.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import type { WorkerWorkspaceQuiescence } from "./tunnel-contract.js";
import { verifyReconciledWorkspaceFinal } from "./workspace-finalize.js";
import type {
  WorkerWorkspaceReconciliationJournal,
  WorkerWorkspaceReconciliationJournalAdapter,
} from "./workspace-manifest.js";
import { REMOTE_WORKSPACE_RESUME_JS } from "./workspace-quiescence-scripts.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let server: Server;
let gatewayUrl: string;
let transferCallback: NodeWorkspaceTransferHttpCallback | undefined;
let captureReady: ((pid: number) => void) | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith("/capture-ready/")) {
      captureReady?.(Number(req.url.slice("/capture-ready/".length)));
      res.writeHead(204).end();
      return;
    }
    void handleNodeWorkspaceTransferHttpRequest({
      req,
      res,
      clientIp: "127.0.0.1",
      callback: transferCallback,
    }).then(
      (handled) => {
        if (!handled) {
          res.writeHead(404).end();
        }
      },
      (error: unknown) => res.destroy(error instanceof Error ? error : new Error(String(error))),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("workspace finalization fixture did not bind");
  }
  gatewayUrl = `ws://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

afterEach(() => vi.restoreAllMocks());

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

type NodeWorkspaceActions = ReturnType<typeof createNodeWorkerWorkspaceActions>;
type PreparedReconciliation = Awaited<ReturnType<NodeWorkspaceActions["reconcileWorkspace"]>>;
type FinalizationFixture = {
  localPath: string;
  remoteWorkspaceDir: string;
  owner: AbortController;
  commands: NodeWorkerWorkspaceExecInput[];
  published: ReturnType<typeof vi.fn<(ref: string) => void>>;
  acceptedManifestRef: () => string | undefined;
  prepare: () => Promise<{
    reconciliation: PreparedReconciliation;
    quiescence: WorkerWorkspaceQuiescence;
  }>;
  armLateWriter: () => Promise<void>;
  blockNextGitCapture: () => Promise<{
    ready: Promise<NodeWorkerProcessIdentity>;
    close: () => Promise<void>;
  }>;
};

async function withWorkspaceFixture(
  run: (fixture: FinalizationFixture) => Promise<void>,
  gitWorkspace = false,
): Promise<void> {
  const root = await fs.realpath(tempDirs.make("node-finalization-boundary-"));
  const localPath = path.join(root, "gateway-workspace");
  const bin = path.join(root, "bin");
  const home = path.join(root, "node-home");
  await Promise.all([fs.mkdir(localPath), fs.mkdir(bin), fs.mkdir(home)]);
  await fs.writeFile(path.join(localPath, "input.txt"), "baseline\n");
  const identity = {
    gatewayNamespace: "finalization-test",
    environmentId: "environment-finalization",
    sessionId: "session-finalization",
    generation: 1,
  };
  const owner = new AbortController();
  const expiresAtMs = Date.now() + 10 * 60_000;
  const service = createNodeWorkspaceTransferService({
    temporaryRoot: path.join(root, "transfer"),
    getOwner: () => ({
      environment: {
        state: "attached",
        ownerEpoch: 1,
        attachedSessionIds: [identity.sessionId],
        destroyRequestedAtMs: null,
      },
      credential: {
        ownerEpoch: 1,
        expiresAtMs,
        sessionId: identity.sessionId,
      },
    }),
  });
  transferCallback = createNodeWorkspaceTransferHttpCallback(service);
  const runtime = new NodeWorkerWorkspaceRuntime({
    root: path.join(root, "node-host"),
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      HOME: home,
      NODE_COMPILE_CACHE: path.join(root, "compile-cache"),
    },
  });
  const commands: NodeWorkerWorkspaceExecInput[] = [];
  const actions = createNodeWorkerWorkspaceActions({
    ...identity,
    ownerEpoch: 1,
    ownerSignal: owner.signal,
    isOwnerCurrent: () => !owner.signal.aborted,
    workspaceTransfer: service,
    runWorkspaceCommand: async (command) => {
      const input = parseNodeWorkerWorkspaceExecInput(
        JSON.stringify({
          ...identity,
          argv: [...command.argv],
          input: command.input,
          // The Gateway forwards 60s; the standalone receiver's 120s default is not this path.
          timeoutMs: command.timeoutMs ?? 60_000,
          resetWorkspace: command.resetWorkspace,
          transfer: command.transfer,
          seed: command.seed,
        }),
      );
      commands.push(input);
      const signal = command.signal
        ? AbortSignal.any([owner.signal, command.signal])
        : owner.signal;
      return await runtime.exec(input, signal, { url: gatewayUrl });
    },
  });
  const published = vi.fn<(ref: string) => void>();
  let acceptedManifestRef: string | undefined;
  let pendingJournal: WorkerWorkspaceReconciliationJournal | undefined;
  const journal: WorkerWorkspaceReconciliationJournalAdapter = {
    load: () => pendingJournal,
    begin: (next) => {
      pendingJournal = next;
    },
    commit: (manifestRef) => {
      acceptedManifestRef = manifestRef;
      pendingJournal = undefined;
    },
    abort: () => {
      pendingJournal = undefined;
    },
  };
  let quiescence: WorkerWorkspaceQuiescence | undefined;
  let lease:
    | { workspaceDir: string; nonce: string; watchdog: NodeWorkerProcessIdentity }
    | undefined;
  try {
    if (gitWorkspace) {
      for (const args of [
        ["-c", "init.templateDir=", "init", "--quiet"],
        ["add", "input.txt"],
        [
          "-c",
          "user.name=Finalization Test",
          "-c",
          "user.email=finalization@example.invalid",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "--quiet",
          "--no-verify",
          "-m",
          "fixture",
        ],
      ]) {
        const result = await runCommandWithTimeout(["git", "-C", localPath, ...args], {
          timeoutMs: 10_000,
        });
        expect(result).toMatchObject({ code: 0, termination: "exit" });
      }
    }
    const synced = await actions.syncWorkspace({
      localPath,
      sessionId: identity.sessionId,
      generation: 1,
    });
    const remoteWorkspaceDir = synced.remoteWorkspaceDir;
    await run({
      localPath,
      remoteWorkspaceDir,
      owner,
      commands,
      published,
      acceptedManifestRef: () => acceptedManifestRef,
      prepare: async () => {
        quiescence = await actions.quiesceWorkspace(remoteWorkspaceDir);
        if (process.platform !== "win32") {
          const key = createHash("sha256").update(remoteWorkspaceDir).digest("hex");
          const directory = path.join(
            path.dirname(remoteWorkspaceDir),
            ".openclaw-worker",
            "quiescence",
          );
          const name = (await fs.readdir(directory)).find(
            (entry) => entry.startsWith(`${key}.`) && entry.endsWith(".json"),
          );
          if (!name) {
            throw new Error("workspace fixture did not acquire its quiescence lease");
          }
          const recorded = JSON.parse(await fs.readFile(path.join(directory, name), "utf8")) as {
            nonce: string;
            processes: unknown[];
            watchdog: { pid: number };
          };
          expect(recorded.processes).toEqual([]);
          lease = {
            workspaceDir: remoteWorkspaceDir,
            nonce: recorded.nonce,
            watchdog: requireNodeWorkerProcessIdentity(recorded.watchdog.pid),
          };
        }
        const reconciliation = await actions.reconcileWorkspace({
          localPath,
          remoteWorkspaceDir,
          baseManifestRef: synced.manifestRef,
          journal,
          stagedResult: {
            ref: "refs/openclaw/worker-results/finalization-test",
            record: published,
          },
        });
        return { reconciliation, quiescence };
      },
      armLateWriter: async () => {
        const marker = path.join(root, "late-writer");
        await fs.writeFile(
          path.join(bin, "ps"),
          `#!/bin/sh\ncase "$*" in\n *"stat=,lstart="*)\n  if [ -f ${shellQuote(marker)} ]; then\n   rm -- ${shellQuote(marker)}\n   printf 'late writer\\n' > ${shellQuote(path.join(remoteWorkspaceDir, "input.txt"))}\n  fi ;;\nesac\nexec /bin/ps "$@"\n`,
          { mode: 0o700 },
        );
        await fs.writeFile(marker, "armed");
      },
      blockNextGitCapture: async () => {
        const { promise: ready, resolve, reject } = createDeferredCore<NodeWorkerProcessIdentity>();
        let child: NodeWorkerProcessIdentity | undefined;
        captureReady = (pid) => {
          try {
            child = requireNodeWorkerProcessIdentity(pid);
            resolve(child);
          } catch (error) {
            reject(error);
          }
        };
        void ready.catch(() => undefined);
        const close = async () => {
          captureReady = undefined;
          reject(new Error("capture startup observer closed"));
          // A failed drain assertion still owns this exact fixture child, never a reused PID.
          if (child && inspectNodeWorkerProcessIdentity(child) === "live") {
            process.kill(child.pid, "SIGKILL");
            await vi.waitFor(() => {
              expect(inspectNodeWorkerProcessIdentity(child!)).not.toBe("live");
            });
          }
        };
        // Directory watch notifications can miss the PID marker. The running descendant
        // acknowledges directly, after installing its keepalive, through the fixture server.
        const blocker = `setInterval(() => {}, 1000);
require("node:http").get(${JSON.stringify(gatewayUrl.replace("ws:", "http:") + "/capture-ready/")} + process.pid, (response) => response.resume());`;
        try {
          await fs.writeFile(
            path.join(bin, "git"),
            `#!/bin/sh\nset -eu\ncase " $* " in\n *" ls-files "*)\n  exec ${shellQuote(process.execPath)} -e ${shellQuote(blocker)} ;;\nesac\nPATH=${shellQuote(process.env.PATH ?? "")} exec git "$@"\n`,
            { mode: 0o700 },
          );
          return { ready, close };
        } catch (error) {
          await close();
          await ready.catch(() => undefined);
          throw error;
        }
      },
    });
  } finally {
    try {
      try {
        await quiescence?.resume().catch((error: unknown) => {
          if (!owner.signal.aborted) {
            throw error;
          }
        });
      } finally {
        owner.abort();
        // Cancellation closes the tunnel signal; cleanup still owns this exact temporary lease.
        if (lease) {
          try {
            await runtime.exec({
              ...identity,
              argv: ["node", "-e", REMOTE_WORKSPACE_RESUME_JS, lease.workspaceDir, lease.nonce],
              timeoutMs: 10_000,
            });
          } finally {
            const watchdog = lease.watchdog;
            if (inspectNodeWorkerProcessIdentity(watchdog) === "live") {
              process.kill(watchdog.pid, "SIGTERM");
            }
            await vi.waitFor(() => {
              expect(inspectNodeWorkerProcessIdentity(watchdog)).not.toBe("live");
            });
          }
        }
      }
    } finally {
      transferCallback = undefined;
      await service.closeAll();
    }
  }
}

// POSIX production refuses root-owned quiescence; Windows uses its shared-host lease instead.
describe.skipIf(process.platform !== "win32" && process.getuid?.() === 0)(
  "node workspace finalization boundary",
  () => {
    it("uses two finalization RPCs and verifies the accepted manifest after local-only changes", async () => {
      await withWorkspaceFixture(async (fixture) => {
        await fs.writeFile(
          path.join(fixture.remoteWorkspaceDir, "node-result.txt"),
          "node result\n",
        );
        await fs.writeFile(path.join(fixture.localPath, "local-only.txt"), "gateway result\n");
        const { reconciliation, quiescence } = await fixture.prepare();
        const uploadedRef = reconciliation.manifestRef;
        fixture.commands.length = 0;

        await verifyReconciledWorkspaceFinal(reconciliation, quiescence);

        expect(fixture.published).toHaveBeenCalledExactlyOnceWith(
          "refs/openclaw/worker-results/finalization-test",
        );
        expect(reconciliation.manifestRef).not.toBe(uploadedRef);
        expect(fixture.acceptedManifestRef()).toBe(reconciliation.manifestRef);
        for (const root of [fixture.localPath, fixture.remoteWorkspaceDir]) {
          await expect(fs.readFile(path.join(root, "node-result.txt"), "utf8")).resolves.toBe(
            "node result\n",
          );
          await expect(fs.readFile(path.join(root, "local-only.txt"), "utf8")).resolves.toBe(
            "gateway result\n",
          );
        }
        const fences = fixture.commands.filter((command) => !command.transfer);
        expect(fences).toHaveLength(2);
        expect(fences.map((command) => command.timeoutMs)).toEqual([180_000, 120_000]);
      });
    });

    it.each(
      (
        [
          { phase: "during the pre-apply renewal", disposition: "retry", applied: false },
          { phase: "after apply", disposition: "preserve-result", applied: true },
        ] as const
      ).filter(({ applied }) => applied || process.platform !== "win32"),
    )("rejects a late writer $phase without publishing", async ({ disposition, applied }) => {
      await withWorkspaceFixture(async (fixture) => {
        await fs.writeFile(
          path.join(fixture.remoteWorkspaceDir, "node-result.txt"),
          "node result\n",
        );
        const { reconciliation, quiescence } = await fixture.prepare();
        if (applied) {
          const apply = reconciliation.applyPreparedStagedResult?.bind(reconciliation);
          if (!apply) {
            throw new Error("staged workspace did not provide its apply owner");
          }
          reconciliation.applyPreparedStagedResult = async () => {
            await apply();
            // Also exercises Windows: its renewal child exits before the outer post-capture.
            await fs.writeFile(path.join(fixture.remoteWorkspaceDir, "input.txt"), "late writer\n");
          };
        } else {
          await fixture.armLateWriter();
        }

        await expect(
          verifyReconciledWorkspaceFinal(reconciliation, quiescence),
        ).rejects.toMatchObject({
          message: expect.stringContaining("Cloud workspace changed during final reconciliation"),
          reclaimDisposition: disposition,
        });
        const localResult = path.join(fixture.localPath, "node-result.txt");
        if (applied) {
          await expect(fs.readFile(localResult, "utf8")).resolves.toBe("node result\n");
          expect(fixture.acceptedManifestRef()).toBeDefined();
        } else {
          await expect(fs.stat(localResult)).rejects.toMatchObject({ code: "ENOENT" });
          expect(fixture.acceptedManifestRef()).toBeUndefined();
        }
        expect(fixture.published).not.toHaveBeenCalled();
        await expect(fs.readFile(path.join(fixture.localPath, "input.txt"), "utf8")).resolves.toBe(
          "baseline\n",
        );
        await expect(
          fs.readFile(path.join(fixture.remoteWorkspaceDir, "input.txt"), "utf8"),
        ).resolves.toBe("late writer\n");
      });
    });

    it.runIf(process.platform !== "win32").each([
      ["cancels a blocked capture descendant before applying or publishing", true],
      ["drains a blocked capture descendant at its 60-second deadline", false],
    ] as const)("%s", async (_title, cancel) => {
      await withWorkspaceFixture(async (fixture) => {
        const { reconciliation, quiescence } = await fixture.prepare();
        const capture = await fixture.blockNextGitCapture();
        const pending = verifyReconciledWorkspaceFinal(reconciliation, quiescence);
        const settled = pending.then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        try {
          const child = await Promise.race([
            capture.ready,
            settled.then((outcome) => {
              throw new Error("capture finished before its descendant blocked", {
                cause: outcome.ok ? undefined : outcome.error,
              });
            }),
          ]);
          expect(inspectNodeWorkerProcessIdentity(child)).toBe("live");
          if (cancel) {
            fixture.owner.abort(new Error("fixture placement retired"));
          }
          await expect(settled).resolves.toMatchObject({
            ok: false,
            error: { reclaimDisposition: "retry" },
          });
          if (!cancel) {
            await expect(settled).resolves.toMatchObject({
              error: { message: expect.stringContaining("ETIMEDOUT") },
            });
          }
          expect(inspectNodeWorkerProcessIdentity(child)).not.toBe("live");
          expect(fixture.acceptedManifestRef()).toBeUndefined();
          expect(fixture.published).not.toHaveBeenCalled();
        } finally {
          fixture.owner.abort();
          await settled;
          await capture.close();
          await capture.ready.catch(() => undefined);
        }
      }, true);
    });
  },
);
