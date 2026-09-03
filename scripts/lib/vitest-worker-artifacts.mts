import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Declaration paths are shared metadata; only the runner imports their build values.
export const runtimeProcessDeclarationEntries = {
  "infra/runtime-process-entrypoints": "src/infra/runtime-process-entrypoints.ts",
  "extensions/memory-core/manager-search-knn-entrypoint":
    "extensions/memory-core/src/memory/manager-search-knn-entrypoint.ts",
};
export const vitestWorkerDeclarationEntries = {
  ...runtimeProcessDeclarationEntries,
  "extensions/qa-lab/gateway-child-artifacts-runtime.test-support":
    "extensions/qa-lab/src/gateway-child-artifacts-runtime.test-support.ts",
  "agents/command/cli-compaction-runtime.test-support":
    "src/agents/command/cli-compaction-runtime.test-support.ts",
  "cron/owner-hardening-runtime.test-support": "src/cron/owner-hardening-runtime.test-support.ts",
  "gateway/server-methods/sessions-list-cache-retention-entrypoint.test-support":
    "src/gateway/server-methods/sessions-list-cache-retention-entrypoint.test-support.ts",
  "gateway/session-title-retention.test-support":
    "src/gateway/session-title-retention.test-support.ts",
  "node-host/config-runtime.test-support": "src/node-host/config-runtime.test-support.ts",
  "skills/library/persistence-runtime.test-support":
    "src/skills/library/persistence-runtime.test-support.ts",
  "state/openclaw-state-lease-runtime.test-support":
    "src/state/openclaw-state-lease-runtime.test-support.ts",
  "tui/tui-pty-runtime-test-support": "src/tui/tui-pty-runtime-test-support.ts",
};

export type VitestWorkerDescriptor = { directory: string };
export type VitestWorkerManifest = {
  identity: string;
  inputs: Record<string, string>;
  outputs: Record<string, string>;
  durationMs: number;
};
const root = fileURLToPath(new URL("../../", import.meta.url));
export const hashVitestWorkerArtifact = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
// Compiler/Vite IDs use forward slashes on Windows; filesystem paths use native separators.
const nativeModulePath = (id: string) => path.normalize(id.replaceAll("\\", "/"));
const declarations = new Map(
  Object.entries(vitestWorkerDeclarationEntries).map(([entry, source]) => [
    nativeModulePath(path.join(root, source)),
    entry,
  ]),
);
export const VITEST_WORKER_PREPARE_REQUEST = "openclaw:prepare-test-subprocesses";
export const VITEST_WORKER_PREPARE_REPLY = "openclaw:test-subprocesses-prepared";

export async function verifyVitestWorkerArtifacts(
  directory: string,
  manifest?: VitestWorkerManifest,
) {
  const completed: VitestWorkerManifest =
    manifest ??
    JSON.parse(await fs.promises.readFile(path.join(directory, "manifest.json"), "utf8"));
  const groups = [
    {
      files: completed.inputs,
      root: undefined,
      changed: "Source changed during compiled subprocess invocation",
    },
    {
      files: completed.outputs,
      root: path.join(directory, "dist"),
      changed: "Compiled subprocess artifact changed",
    },
  ];
  const batchSize = 32;
  for (const { files, root: baseDir, changed } of groups) {
    const entries = Object.entries(files);
    for (let offset = 0; offset < entries.length; offset += batchSize) {
      // Native batches keep pre-install planning dependency-free and signals responsive.
      // Drain every started read before rejection: the owner may delete files next.
      const settled = await Promise.allSettled(
        entries.slice(offset, offset + batchSize).map(async ([name, expected]) => {
          const filename = baseDir ? path.join(baseDir, name) : name;
          if (hashVitestWorkerArtifact(await fs.promises.readFile(filename)) !== expected) {
            throw new Error(`${changed}: ${name}`);
          }
        }),
      );
      const failed = settled.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") {
        throw failed.reason;
      }
    }
  }
}

export function resolveVitestWorkerDeclaration(id: string, directory: string): string | undefined {
  const entry = declarations.get(nativeModulePath(id));
  if (entry) {
    const compiled = path.join(directory, "dist", `${entry}.js`);
    fs.accessSync(compiled);
    return compiled.replaceAll("\\", "/");
  }
  return undefined;
}

export function isVitestWorkerDeclaration(id: string): boolean {
  return declarations.has(nativeModulePath(id));
}

/** One finite request over the already-owned Node IPC channel; never a path/build request. */
export function requestVitestWorkerArtifacts(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send || !process.connected) {
      reject(new Error("Compiled subprocess owner IPC is unavailable"));
      return;
    }
    const finish = (error?: Error) => {
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
      process.channel?.unref();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const onDisconnect = () => finish(new Error("Compiled subprocess owner disconnected"));
    const onMessage = (message: unknown) => {
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === VITEST_WORKER_PREPARE_REPLY
      ) {
        finish("error" in message ? new Error(String(message.error)) : undefined);
      }
    };
    process.on("message", onMessage);
    process.once("disconnect", onDisconnect);
    process.channel?.ref();
    process.send(VITEST_WORKER_PREPARE_REQUEST, (error) => {
      if (error) {
        finish(error);
      }
    });
  });
}
