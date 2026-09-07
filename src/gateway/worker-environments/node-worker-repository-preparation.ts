import { createHash } from "node:crypto";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { SpawnResult } from "../../process/exec.js";
import type { WorkerWorkspaceCommand, WorkerWorkspaceSyncResult } from "./tunnel-contract.js";
import { boundedWorkerError } from "./worker-error.js";
import { workspaceSyncError } from "./workspace-sync-helpers.js";
import { REMOTE_WORKSPACE_MANIFEST_JS } from "./workspace-sync-scripts.js";

const GIT_TIMEOUT_MS = 60_000;
const MANIFEST_REF_PATTERN = /^sha256:[a-f0-9]{64}$/u;
export const WORKER_REPOSITORY_GIT_ARGS = ["-c", "credential.helper=", "-c", "core.askPass="];
const workspaceSyncLog = createSubsystemLogger("gateway/worker-workspace");

export type NodeWorkerRepositoryExec = (
  params: WorkerWorkspaceCommand & { resetWorkspace?: boolean },
) => Promise<SpawnResult & { workspaceDir: string }>;

type RepositoryIdentity = {
  origin: string;
  commit?: string;
  ref?: string;
  branch?: string;
  gitToken?: string;
};

const AUTHENTICATED_GIT_JS = String.raw`const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const { origin, token } = JSON.parse(fs.readFileSync(0, "utf8"));
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(GIT_|GH_TOKEN$|GITHUB_TOKEN$)/i.test(key)) delete env[key];
Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: require("node:os").devNull, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" });
if (token) Object.assign(env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http." + origin + ".extraheader", GIT_CONFIG_VALUE_0: "Authorization: Basic " + Buffer.from("x-access-token:" + token).toString("base64") });
const result = spawnSync("git", process.argv.slice(1), { env, stdio: ["ignore", "inherit", "inherit"] });
process.exitCode = result.status ?? 1;`;

export type NodeWorkerRepositoryOutcome =
  | {
      kind: "prepared";
      seeded: boolean;
      result: WorkerWorkspaceSyncResult & { baseCommit: string };
    }
  | {
      kind: "failed";
      reason: "clone-failed" | "checkout-failed" | "manifest-capture-failed" | "manifest-mismatch";
    };

function succeeded(result: SpawnResult): boolean {
  return result.termination === "exit" && result.code === 0;
}

/**
 * Admission owns the validated repository source; the command owner fences
 * every operation to its remote session workspace. This owner never reads a Gateway checkout.
 */
export function createNodeWorkerRepositoryPreparation(exec: NodeWorkerRepositoryExec) {
  let seedStoreFailureLogged = false;
  const git = (
    identity: RepositoryIdentity | undefined,
    args: string[],
    resetWorkspace?: boolean,
  ) =>
    exec({
      argv: ["node", "-e", AUTHENTICATED_GIT_JS, "--", ...WORKER_REPOSITORY_GIT_ARGS, ...args],
      input: JSON.stringify({ origin: identity?.origin, token: identity?.gitToken }),
      ...(resetWorkspace ? { resetWorkspace: true } : {}),
      timeoutMs: GIT_TIMEOUT_MS,
      transportRetry: "never",
    });
  const capture = async (dir: string, base: string | null, reference?: string) =>
    await exec({
      argv: [
        "node",
        "-e",
        REMOTE_WORKSPACE_MANIFEST_JS,
        dir,
        ...(base ? [base, "eligible"] : ["", "all"]),
        ...(reference ? [reference.slice("sha256:".length)] : []),
      ],
      timeoutMs: GIT_TIMEOUT_MS,
      transportRetry: "idempotent",
    });
  const checkoutAndCapture = async (
    identity: RepositoryIdentity,
    workspaceDir: string,
    expectedManifestRef: string | undefined,
    seeded: boolean,
  ): Promise<NodeWorkerRepositoryOutcome> => {
    // Restore asks for the immutable SHA even when a force push removed its branch ref.
    const fetched = await git(identity, [
      "fetch",
      "--no-tags",
      "--",
      "origin",
      identity.commit ?? identity.ref ?? "HEAD",
    ]);
    if (!succeeded(fetched)) {
      return { kind: "failed", reason: "checkout-failed" };
    }
    const resolved = await git(identity, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"]);
    const revision = resolved.stdout.trim();
    if (
      !succeeded(resolved) ||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(revision) ||
      (identity.commit !== undefined && revision !== identity.commit)
    ) {
      return { kind: "failed", reason: "checkout-failed" };
    }
    const checkedOut = await git(identity, ["checkout", "--detach", "--force", revision]);
    if (!succeeded(checkedOut) || checkedOut.workspaceDir !== workspaceDir) {
      return { kind: "failed", reason: "checkout-failed" };
    }
    const captured = await capture(checkedOut.workspaceDir, revision);
    const manifestRef = captured.stdout.trim();
    if (!succeeded(captured) || !MANIFEST_REF_PATTERN.test(manifestRef)) {
      return { kind: "failed", reason: "manifest-capture-failed" };
    }
    if (expectedManifestRef !== undefined && manifestRef !== expectedManifestRef) {
      return { kind: "failed", reason: "manifest-mismatch" };
    }
    return {
      kind: "prepared",
      seeded,
      result: {
        mode: "git",
        remoteWorkspaceDir: checkedOut.workspaceDir,
        manifestRef,
        baseCommit: revision,
      },
    };
  };
  return {
    configureAuthor: async (workspaceDir: string, author: { name?: string; email?: string }) => {
      for (const [key, value] of Object.entries(author)) {
        if (!value) {
          continue;
        }
        const configured = await git(undefined, [
          "-C",
          workspaceDir,
          "config",
          "--local",
          `user.${key}`,
          value,
        ]);
        if (!succeeded(configured)) {
          throw workspaceSyncError(configured);
        }
      }
    },
    captureManifest: async (dir: string, base: string | null, reference: string) => {
      const captured = await capture(dir, base, reference);
      const manifestRef = captured.stdout.trim();
      if (!succeeded(captured) || !MANIFEST_REF_PATTERN.test(manifestRef)) {
        const detail = boundedWorkerError(
          captured.stderr.trim() ||
            (!succeeded(captured)
              ? `${captured.termination} (exit code ${captured.code}, signal ${captured.signal})`
              : "invalid manifest reference"),
        );
        throw new Error(`Node workspace manifest capture failed: ${detail}`);
      }
      return manifestRef;
    },
    async prepareRepository(
      identity: RepositoryIdentity,
      expectedManifestRef?: string,
    ): Promise<NodeWorkerRepositoryOutcome> {
      const seedKey = createHash("sha256").update(identity.origin).digest("hex");
      let outcome: NodeWorkerRepositoryOutcome | undefined;
      {
        try {
          const applied = await exec({
            argv: ["openclaw-internal-workspace-seed"],
            seed: { action: "apply", key: seedKey },
            timeoutMs: GIT_TIMEOUT_MS,
            transportRetry: "never",
          });
          if (succeeded(applied) && applied.stdout.trim() === "applied") {
            const remote = await git(identity, ["remote", "get-url", "origin"]);
            if (!succeeded(remote) || remote.stdout.trim() !== identity.origin) {
              throw new Error("Node workspace seed origin mismatch");
            }
            outcome = await checkoutAndCapture(
              identity,
              applied.workspaceDir,
              expectedManifestRef,
              true,
            );
          }
        } catch (error) {
          if (error instanceof Error && error.message.includes("INVALID_REQUEST")) {
            throw error;
          } else {
            // Seeded failure self-heals through the clone path; without this line the
            // degradation would be invisible behind an ordinary "published-origin" sync.
            workspaceSyncLog.info("node worker workspace seeded sync failed; cloning", {
              error: boundedWorkerError(error),
            });
          }
        }
      }
      if (outcome?.kind !== "prepared") {
        const cloned = await git(
          identity,
          [
            "-c",
            "init.templateDir=",
            "clone",
            "--filter=blob:none",
            "--no-checkout",
            "--",
            identity.origin,
            ".",
          ],
          true,
        );
        if (!succeeded(cloned)) {
          return { kind: "failed", reason: "clone-failed" };
        }
        outcome = await checkoutAndCapture(
          identity,
          cloned.workspaceDir,
          expectedManifestRef,
          false,
        );
      }
      if (outcome.kind === "prepared") {
        try {
          const stored = await exec({
            argv: ["openclaw-internal-workspace-seed"],
            seed: { action: "store", key: seedKey, maxAgeMs: 6 * 60 * 60 * 1000 },
            timeoutMs: 180_000,
            transportRetry: "never",
          });
          if (!succeeded(stored)) {
            throw workspaceSyncError(stored);
          }
        } catch (error) {
          if (error instanceof Error && error.message.includes("INVALID_REQUEST")) {
            throw error;
          }
          if (!seedStoreFailureLogged) {
            seedStoreFailureLogged = true;
            workspaceSyncLog.warn("node worker workspace seed store failed", {
              error: boundedWorkerError(error),
            });
          }
        }
      }
      if (outcome.kind === "prepared" && identity.branch) {
        const bound = await git(identity, [
          "checkout",
          "-B",
          identity.branch,
          outcome.result.baseCommit,
        ]);
        if (!succeeded(bound)) {
          return { kind: "failed", reason: "checkout-failed" };
        }
      }
      return outcome;
    },
  };
}
