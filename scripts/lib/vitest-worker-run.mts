import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runManagedCommand } from "./managed-child-process.mts";
import {
  verifyVitestWorkerArtifacts,
  vitestArtifactDirectory,
  VITEST_WORKER_PREPARE_REQUEST,
  VITEST_WORKER_PREPARE_REPLY,
  type VitestWorkerDescriptor,
  type VitestWorkerManifest,
  type VitestArtifactDemand,
} from "./vitest-worker-artifacts.mts";

const root = fileURLToPath(new URL("../../", import.meta.url));

function createVitestWorkerDirectory() {
  const parent = path.join(root, ".artifacts", "vitest-workers");
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, "run-"));
  fs.writeFileSync(path.join(directory, "package.json"), '{"type":"module"}\n');
  return directory;
}

/** The invocation owns preparation and waits for every real borrower before disposal. */
export function createVitestWorkerRun(env: NodeJS.ProcessEnv = process.env) {
  const directory = createVitestWorkerDirectory();
  const preparations = new Map<VitestArtifactDemand, Promise<VitestWorkerManifest>>();
  let disposal: Promise<void> | undefined;
  const borrowers: Promise<unknown>[] = [];
  let channelError: Error | undefined;
  const compilerAbort = new AbortController();
  let compilerJoined = true;

  function prepare(demand: VitestArtifactDemand): Promise<VitestWorkerManifest> {
    if (disposal) {
      return Promise.reject(new Error("Compiled subprocess owner is closing"));
    }
    const existing = preparations.get(demand);
    if (existing) {
      return existing;
    }
    const preparation = (async () => {
      // Members are immutable. Workers reference the already sealed small member;
      // mixed requests never extend a manifest or compile a second handoff closure.
      if (demand === "workers") {
        await prepare("handoff");
      }
      if (disposal) {
        throw new Error("Compiled subprocess owner is closing");
      }
      compilerJoined = false;
      const code = await runManagedCommand({
        bin: process.execPath,
        args: [
          fileURLToPath(new URL("./vitest-worker-compiler.mts", import.meta.url)),
          directory,
          demand,
        ],
        cwd: root,
        env,
        shell: false,
        // Match the native declaration owner: POSIX group/output join; Windows close/taskkill.
        requireProcessTreeExit: process.platform !== "win32",
        signal: compilerAbort.signal,
      }).then(
        (exitCode) => {
          compilerJoined = true;
          return exitCode;
        },
        (error: unknown) => {
          // Managed abort rejects only after verified termination. Uncertain
          // cleanup (including aggregated setup failure) must retain this generation.
          compilerJoined = Boolean(
            error &&
            typeof error === "object" &&
            (("code" in error && error.code === "ABORT_ERR") ||
              ("code" in error &&
                error.code === "EPROCESSGROUP_CLEANUP_FAILED" &&
                "processTreeState" in error &&
                error.processTreeState === "terminated")),
          );
          throw error;
        },
      );
      if (code !== 0) {
        throw new Error(`Compiled subprocess build failed with exit code ${code}`);
      }
      const manifest: VitestWorkerManifest = JSON.parse(
        fs.readFileSync(
          path.join(vitestArtifactDirectory(directory, demand), "manifest.json"),
          "utf8",
        ),
      );
      console.error(
        `[vitest-${demand}] prepared ${manifest.identity.slice(0, 12)} in ${Math.round(manifest.durationMs)}ms (${Object.keys(manifest.inputs).length} inputs, ${Object.keys(manifest.outputs).length} outputs)`,
      );
      return manifest;
    })();
    preparations.set(demand, preparation);
    return preparation;
  }
  return {
    descriptor: { directory } satisfies VitestWorkerDescriptor,
    borrow<T>(child: ChildProcess, completion: Promise<T>): Promise<T> {
      const requests = new Map<VitestArtifactDemand, Promise<void>>();
      const onMessage = (message: unknown) => {
        if (
          !message ||
          typeof message !== "object" ||
          !("type" in message) ||
          message.type !== VITEST_WORKER_PREPARE_REQUEST ||
          !("demand" in message) ||
          (message.demand !== "workers" && message.demand !== "handoff") ||
          requests.has(message.demand)
        ) {
          return;
        }
        const demand = message.demand;
        requests.set(
          demand,
          (async () => {
            let reply: { type: string; demand: VitestArtifactDemand; error?: string } = {
              type: VITEST_WORKER_PREPARE_REPLY,
              demand,
            };
            try {
              const manifest = await prepare(demand);
              await verifyVitestWorkerArtifacts(
                vitestArtifactDirectory(directory, demand),
                manifest,
              );
              if (demand === "workers") {
                await verifyVitestWorkerArtifacts(
                  vitestArtifactDirectory(directory, "handoff"),
                  await prepare("handoff"),
                );
              }
              if (disposal) {
                throw new Error("Compiled subprocess owner is closing");
              }
            } catch (error) {
              reply = { type: VITEST_WORKER_PREPARE_REPLY, demand, error: String(error) };
            }
            if (child.connected) {
              child.send(reply, (error) => {
                channelError ??= error ?? undefined;
              });
            }
          })(),
        );
      };
      child.on("message", onMessage);
      // Existing Windows completion observes exit; artifact ownership additionally
      // waits for close so inherited handles cannot outlive deletion.
      const closed = new Promise<void>((resolve) => {
        child.once("close", () => resolve());
      });
      const joined = (async () => {
        try {
          return await completion;
        } finally {
          await closed;
          child.off("message", onMessage);
        }
      })();
      // Child completion must let callers reach disposal to cancel compilation.
      // The owner still joins admission reads before releasing their generation.
      const ownedCompletion = (async () => {
        const completed = await Promise.allSettled([joined]);
        const admissions = await Promise.allSettled(requests.values());
        const failed = [...completed, ...admissions].find((result) => result.status === "rejected");
        if (failed?.status === "rejected") {
          throw failed.reason;
        }
      })();
      borrowers.push(ownedCompletion);
      void ownedCompletion.catch(() => {});
      return joined;
    },
    dispose(): Promise<void> {
      return (disposal ??= (async () => {
        compilerAbort.abort();
        const settled = await Promise.allSettled(borrowers);
        const uncertain = settled.find((result) => result.status === "rejected");
        try {
          const prepared = await Promise.allSettled(preparations.values());
          const failed = prepared.find((result) => result.status === "rejected");
          if (failed?.status === "rejected") {
            throw failed.reason;
          }
          if (uncertain?.status === "rejected") {
            throw uncertain.reason;
          }
          if (channelError) {
            throw channelError;
          }
          for (const demand of ["handoff", "workers"] as const) {
            const member = vitestArtifactDirectory(directory, demand);
            if (!fs.existsSync(path.join(member, "manifest.json"))) {
              continue;
            }
            console.error("[vitest-workers] verifying completed generation before cleanup");
            await verifyVitestWorkerArtifacts(member);
          }
        } finally {
          if (uncertain || !compilerJoined) {
            console.error(
              `[vitest-workers] retaining ${directory}: ${!compilerJoined ? "compiler" : "borrower"} join failed`,
            );
          } else {
            // Large generations must not block signal delivery during final cleanup.
            await fs.promises.rm(directory, { recursive: true, force: true });
          }
        }
      })());
    },
  };
}

export type VitestWorkerRun = ReturnType<typeof createVitestWorkerRun>;
