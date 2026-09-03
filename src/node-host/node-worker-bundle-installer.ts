import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import fsp from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { CloudflareAccessCredentials } from "../../packages/gateway-client/src/cloudflare-access.js";
import {
  validateWorkerAdmissionHandshake,
  type WorkerAdmissionHandshake,
} from "../../packages/gateway-protocol/src/index.js";
import { resolveStateDir } from "../config/paths.js";
import { hasErrnoCode } from "../infra/errors.js";
import { FsSafeError, root as fsSafeRoot } from "../infra/fs-safe.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { isPathInside } from "../infra/path-guards.js";
import { redactSensitiveText } from "../logging/redact.js";
import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";
import {
  DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
  extractWorkerBundleArchive,
  readWorkerBundleDirectoryManifest,
} from "../shared/worker-bundle-archive.js";
import {
  hashWorkerBundleManifest,
  WORKER_BUNDLE_ENTRY_PATH,
  workerBundleArchiveRelativePath,
} from "../shared/worker-bundle-hash.js";
import { MAX_WORKER_BUNDLE_ARCHIVE_BYTES } from "../shared/worker-bundle-limits.js";
import {
  nodeWorkerBundleTransferPath,
  NodeWorkerBundleInstallError,
  type NodeWorkerBundleInstallInput,
} from "../worker/node-bundle-install-protocol.js";
import { sameWorkerBuild } from "../worker/worker-build-identity.js";
import { snapshotNodeWorkerEnv } from "./node-worker-environment.js";
import {
  NodeWorkerTransferHttpError,
  openNodeWorkerTransferHttpRequest,
} from "./node-worker-transfer-http.js";

const INSTALL_RECEIPT = "bootstrap-receipt.json";
const INSTALL_IGNORED_TOP_LEVEL = new Set([INSTALL_RECEIPT]);
const BUNDLE_HASH_PATTERN = /^[a-f0-9]{64}$/u;
const STAGING_PATTERN = /^\.staging-[a-f0-9]{64}-/u;
const PREVIOUS_PATTERN = /^[a-f0-9]{64}\.previous-/u;
const BUNDLE_DELETE_BATCH = 16;
const WORKER_PREWARM_TIMEOUT_MS = 10 * 60_000;
const execFileAsync = promisify(execFile);

async function responseBody(response: IncomingMessage, maxBytes = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of response) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    total += chunk.byteLength;
    if (total > maxBytes) {
      response.destroy(new Error("worker bundle transfer response exceeded its byte limit"));
      throw new Error("worker bundle transfer response exceeded its byte limit");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function writeBundleArchive(params: {
  source: AsyncIterable<Uint8Array>;
  archive: NodeWorkerBundleInstallInput["archive"];
  destination: string;
  signal?: AbortSignal;
}): Promise<void> {
  const output = await fsp.open(params.destination, "wx", 0o600);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    params.signal?.throwIfAborted();
    for await (const chunk of params.source) {
      params.signal?.throwIfAborted();
      bytes += chunk.byteLength;
      if (bytes > params.archive.bytes || bytes > MAX_WORKER_BUNDLE_ARCHIVE_BYTES) {
        throw new Error("worker bundle archive exceeded its byte limit");
      }
      hash.update(chunk);
      await output.writeFile(chunk);
    }
    params.signal?.throwIfAborted();
    if (bytes !== params.archive.bytes || hash.digest("hex") !== params.archive.sha256) {
      throw new Error("worker bundle archive failed integrity validation");
    }
  } finally {
    await output.close();
  }
}

async function acquireBundle(params: {
  packageRoot: string | null;
  gatewayUrl: string;
  gatewayTlsFingerprint?: string;
  gatewayCloudflareAccess?: CloudflareAccessCredentials;
  input: NodeWorkerBundleInstallInput;
  destination: string;
  signal?: AbortSignal;
}): Promise<void> {
  if (params.packageRoot) {
    const root = await fsSafeRoot(params.packageRoot);
    let opened;
    try {
      opened = await root.open(workerBundleArchiveRelativePath(params.input.archive.sha256));
    } catch (error) {
      // Only an absent source takes the authenticated update path. Unsafe local bytes fail closed.
      if (!(error instanceof FsSafeError) || error.code !== "not-found") {
        throw error;
      }
    }
    if (opened) {
      try {
        // Root.open pins a contained regular file; its streaming API does not enforce maxBytes.
        if (
          opened.stat.size !== params.input.archive.bytes ||
          opened.stat.size > MAX_WORKER_BUNDLE_ARCHIVE_BYTES
        ) {
          throw new Error("prepared worker bundle archive has an unexpected length");
        }
        const source = opened.handle.createReadStream({ autoClose: false });
        try {
          await writeBundleArchive({ ...params, source, archive: params.input.archive });
        } finally {
          source.destroy();
        }
      } finally {
        await opened.handle.close();
      }
      return;
    }
  }
  params.signal?.throwIfAborted();
  const response = await openNodeWorkerTransferHttpRequest({
    gatewayUrl: params.gatewayUrl,
    tlsFingerprint: params.gatewayTlsFingerprint,
    cloudflareAccess: params.gatewayCloudflareAccess,
    routePath: nodeWorkerBundleTransferPath(params.input.build.bundleHash),
    method: "GET",
    token: params.input.archive.token,
    signal: params.signal,
  });
  if (response.statusCode !== 200) {
    await responseBody(response);
    throw new Error(`gateway returned ${response.statusCode ?? 0}`);
  }
  const contentLength = Number(response.headers["content-length"]);
  if (contentLength !== params.input.archive.bytes) {
    response.destroy();
    throw new Error("gateway returned an unexpected worker bundle length");
  }
  try {
    await writeBundleArchive({ ...params, source: response, archive: params.input.archive });
  } finally {
    response.destroy();
  }
}

async function readReceipt(bundleDir: string): Promise<WorkerAdmissionHandshake | undefined> {
  try {
    const raw = JSON.parse(
      await fsp.readFile(path.join(bundleDir, INSTALL_RECEIPT), "utf8"),
    ) as unknown;
    return validateWorkerAdmissionHandshake(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

async function validateInstalledBundle(
  bundleDir: string,
  expected: WorkerAdmissionHandshake,
): Promise<boolean> {
  try {
    const rootStats = await fsp.lstat(bundleDir);
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      return false;
    }
    const receipt = await readReceipt(bundleDir);
    if (!receipt || !sameWorkerBuild(receipt, expected)) {
      return false;
    }
    const manifest = await readWorkerBundleDirectoryManifest({
      root: bundleDir,
      limits: DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
      ignoreTopLevel: INSTALL_IGNORED_TOP_LEVEL,
    });
    if (hashWorkerBundleManifest(manifest) !== expected.bundleHash) {
      return false;
    }
    const root = await fsp.realpath(bundleDir);
    const entry = await fsp.realpath(path.join(root, WORKER_BUNDLE_ENTRY_PATH));
    return isPathInside(root, entry) && (await fsp.stat(entry)).isFile();
  } catch {
    return false;
  }
}

async function removeStaleInstallStaging(bundlesRoot: string): Promise<void> {
  const entries = await fsp.readdir(bundlesRoot, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.name.startsWith(".staging-") && entry.isDirectory() && !entry.isSymbolicLink()) {
        await fsp.rm(path.join(bundlesRoot, entry.name), { recursive: true, force: true });
      }
    }),
  );
}

async function publishBundle(
  destination: string,
  staging: string,
  signal?: AbortSignal,
): Promise<void> {
  const prior = `${destination}.previous-${process.pid}-${randomUUID()}`;
  let movedPrior = false;
  signal?.throwIfAborted();
  try {
    await fsp.rename(destination, prior);
    movedPrior = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  try {
    // Cancellation after moving the old install must restore it through the same rollback path.
    signal?.throwIfAborted();
    await fsp.rename(staging, destination);
  } catch (error) {
    if (movedPrior) {
      await fsp.rename(prior, destination).catch(() => undefined);
    }
    throw error;
  }
  if (movedPrior) {
    await fsp.rm(prior, { recursive: true, force: true }).catch(() => undefined);
  }
}

export class NodeWorkerBundleInstaller {
  readonly #root: string;
  readonly #packageRoot: string | null;
  readonly #operations = new KeyedAsyncQueue();
  readonly #bundleGenerationsByNamespace = new Map<string, Map<string, number>>();
  readonly #currentGenerationByNamespace = new Map<string, number>();
  readonly #prewarmedBundles = new Set<string>();
  readonly #workerEnv: NodeJS.ProcessEnv;

  constructor(options: { root?: string; env?: NodeJS.ProcessEnv } = {}) {
    const env = options.env ?? process.env;
    this.#root = path.resolve(options.root ?? path.join(resolveStateDir(env), "node-host"));
    this.#packageRoot = resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url });
    this.#workerEnv = snapshotNodeWorkerEnv(env);
  }

  #markPendingRetention(gatewayNamespace: string, bundleHash: string): void {
    const generation = (this.#currentGenerationByNamespace.get(gatewayNamespace) ?? 0) + 1;
    this.#currentGenerationByNamespace.set(gatewayNamespace, generation);
    const generations =
      this.#bundleGenerationsByNamespace.get(gatewayNamespace) ?? new Map<string, number>();
    generations.set(bundleHash, generation);
    this.#bundleGenerationsByNamespace.set(gatewayNamespace, generations);
  }

  async #prewarmBundle(bundleDir: string, signal?: AbortSignal): Promise<void> {
    if (this.#prewarmedBundles.has(bundleDir)) {
      return;
    }
    try {
      await execFileAsync(
        process.execPath,
        [path.join(bundleDir, WORKER_BUNDLE_ENTRY_PATH), "--internal-worker-prewarm"],
        {
          cwd: bundleDir,
          env: this.#workerEnv,
          timeout: WORKER_PREWARM_TIMEOUT_MS,
          windowsHide: true,
          ...(signal ? { signal } : {}),
        },
      );
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason ?? error;
      }
      throw error;
    }
    this.#prewarmedBundles.add(bundleDir);
  }

  async ensure(params: {
    input: NodeWorkerBundleInstallInput;
    gatewayUrl: string;
    gatewayTlsFingerprint?: string;
    gatewayCloudflareAccess?: CloudflareAccessCredentials;
    signal?: AbortSignal;
  }): Promise<WorkerAdmissionHandshake> {
    const { input } = params;
    // One namespace owns every staging sibling, so serialize it before sweeping crash residue.
    const key = input.gatewayNamespace;
    return await this.#operations.enqueue(key, async () => {
      try {
        params.signal?.throwIfAborted();
        const bundlesRoot = path.join(this.#root, input.gatewayNamespace, "bundles");
        const destination = path.join(bundlesRoot, input.build.bundleHash);
        const installed = await validateInstalledBundle(destination, input.build);
        params.signal?.throwIfAborted();
        if (!installed) {
          await fsp.mkdir(bundlesRoot, { recursive: true, mode: 0o700 });
          await removeStaleInstallStaging(bundlesRoot);
          const operationRoot = await fsp.mkdtemp(
            path.join(bundlesRoot, `.staging-${input.build.bundleHash}-`),
          );
          try {
            const archivePath = path.join(operationRoot, "bundle.tgz");
            const staging = path.join(operationRoot, "root");
            params.signal?.throwIfAborted();
            await acquireBundle({
              packageRoot: this.#packageRoot,
              gatewayUrl: params.gatewayUrl,
              gatewayTlsFingerprint: params.gatewayTlsFingerprint,
              gatewayCloudflareAccess: params.gatewayCloudflareAccess,
              input,
              destination: archivePath,
              signal: params.signal,
            });
            params.signal?.throwIfAborted();
            await extractWorkerBundleArchive({
              tarballPath: archivePath,
              destination: staging,
              expectedBundleHash: input.build.bundleHash,
              limits: DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
            });
            params.signal?.throwIfAborted();
            const receipt = await fsp.open(path.join(staging, INSTALL_RECEIPT), "wx", 0o600);
            try {
              params.signal?.throwIfAborted();
              await receipt.writeFile(`${JSON.stringify(input.build)}\n`);
              await receipt.sync();
            } finally {
              await receipt.close();
            }
            await publishBundle(destination, staging, params.signal);
            if (!(await validateInstalledBundle(destination, input.build))) {
              throw new Error("published worker bundle failed validation");
            }
          } finally {
            await fsp.rm(operationRoot, { recursive: true, force: true });
          }
        }
        params.signal?.throwIfAborted();
        if (input.bundlePrewarm) {
          await this.#prewarmBundle(destination, params.signal);
        }
        params.signal?.throwIfAborted();
        this.#markPendingRetention(input.gatewayNamespace, input.build.bundleHash);
        return structuredClone(input.build);
      } catch (error) {
        if (error instanceof NodeWorkerBundleInstallError) {
          throw error;
        }
        if (error instanceof NodeWorkerTransferHttpError) {
          throw new NodeWorkerBundleInstallError(
            error.reason === "tls-fingerprint-mismatch"
              ? "worker-bundle-install-failed: gateway TLS fingerprint mismatch"
              : error.reason === "cloudflare-access-requires-tls"
                ? "worker-bundle-install-failed: Cloudflare Access credentials require HTTPS"
                : "worker-bundle-install-failed: gateway transfer is unavailable",
            { cause: error },
          );
        }
        const detail = truncateUtf16Safe(
          redactSensitiveText(error instanceof Error ? error.message : String(error)),
          512,
        );
        throw new NodeWorkerBundleInstallError(
          `worker-bundle-install-failed: ${detail || "bundle installation did not complete"}`,
          { cause: error },
        );
      }
    });
  }

  async inspect(params: {
    gatewayNamespace: string;
    bundleHash: string;
  }): Promise<{ bundleHash: string; status: "installed" | "missing" }> {
    return await this.#operations.enqueue(params.gatewayNamespace, async () => {
      const bundleDir = path.join(
        this.#root,
        params.gatewayNamespace,
        "bundles",
        params.bundleHash,
      );
      const receipt = await readReceipt(bundleDir);
      const installed =
        receipt?.bundleHash === params.bundleHash &&
        (await validateInstalledBundle(bundleDir, receipt));
      return { bundleHash: params.bundleHash, status: installed ? "installed" : "missing" };
    });
  }

  async retain(params: {
    gatewayNamespace: string;
    bundleHashes: readonly string[];
    acknowledgedGeneration?: number;
  }): Promise<{ deleted: number; hasMore: boolean; generation: number }> {
    return await this.#operations.enqueue(params.gatewayNamespace, async () => {
      const bundlesRoot = path.join(this.#root, params.gatewayNamespace, "bundles");
      let entries: Dirent[];
      try {
        entries = await fsp.readdir(bundlesRoot, { withFileTypes: true });
      } catch (error) {
        if (hasErrnoCode(error, "ENOENT")) {
          return {
            deleted: 0,
            hasMore: false,
            generation: this.#currentGenerationByNamespace.get(params.gatewayNamespace) ?? 0,
          };
        }
        throw error;
      }
      const protectedHashes = new Set(params.bundleHashes);
      const generations =
        this.#bundleGenerationsByNamespace.get(params.gatewayNamespace) ??
        new Map<string, number>();
      const acknowledgedGeneration = params.acknowledgedGeneration ?? 0;
      for (const [bundleHash, generation] of generations) {
        if (generation > acknowledgedGeneration) {
          protectedHashes.add(bundleHash);
        } else {
          generations.delete(bundleHash);
        }
      }
      if (generations.size > 0) {
        this.#bundleGenerationsByNamespace.set(params.gatewayNamespace, generations);
      } else {
        this.#bundleGenerationsByNamespace.delete(params.gatewayNamespace);
      }
      const candidates = entries
        .filter(
          (entry) =>
            entry.isDirectory() &&
            !entry.isSymbolicLink() &&
            ((BUNDLE_HASH_PATTERN.test(entry.name) && !protectedHashes.has(entry.name)) ||
              STAGING_PATTERN.test(entry.name) ||
              PREVIOUS_PATTERN.test(entry.name)),
        )
        .map((entry) => entry.name)
        .toSorted();
      const selected = candidates.slice(0, BUNDLE_DELETE_BATCH);
      for (const name of selected) {
        const target = path.join(bundlesRoot, name);
        await fsp.rm(target, { recursive: true, force: true });
        this.#prewarmedBundles.delete(target);
      }
      return {
        deleted: selected.length,
        hasMore: candidates.length > selected.length,
        generation: this.#currentGenerationByNamespace.get(params.gatewayNamespace) ?? 0,
      };
    });
  }
}

export type NodeWorkerBundleInstallerControl = Pick<NodeWorkerBundleInstaller, "ensure"> &
  Partial<Pick<NodeWorkerBundleInstaller, "inspect" | "retain">>;
