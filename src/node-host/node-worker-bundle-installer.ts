import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import {
  validateWorkerAdmissionHandshake,
  type WorkerAdmissionHandshake,
} from "../../packages/gateway-protocol/src/index.js";
import { resolveStateDir } from "../config/paths.js";
import { isPathInside } from "../infra/path-guards.js";
import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";
import { runCommandWithTimeout } from "../process/exec.js";
import {
  DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
  extractWorkerBundleArchive,
  readWorkerBundleDirectoryManifest,
} from "../shared/worker-bundle-archive.js";
import { hashWorkerBundleManifest } from "../shared/worker-bundle-hash.js";
import { MAX_WORKER_BUNDLE_ARCHIVE_BYTES } from "../shared/worker-bundle-limits.js";
import {
  nodeWorkerBundleTransferPath,
  NodeWorkerBundleInstallError,
  type NodeWorkerBundleInstallInput,
} from "../worker/node-bundle-install-protocol.js";
import { sameWorkerBuild } from "../worker/worker-build-identity.js";
import {
  NodeWorkerTransferHttpError,
  openNodeWorkerTransferHttpRequest,
} from "./node-worker-transfer-http.js";

const INSTALL_RECEIPT = "bootstrap-receipt.json";
const INSTALL_TIMEOUT_MS = 35 * 60_000;
const INSTALL_IGNORED_TOP_LEVEL = new Set(["node_modules", INSTALL_RECEIPT]);

type BundleInstallCommandRunner = typeof runCommandWithTimeout;

function commandEnv(homeDir: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    HOME: homeDir,
    ...(process.platform === "win32" ? { USERPROFILE: homeDir } : {}),
    CI: "1",
    GIT_ASKPASS: "",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    SSH_ASKPASS: "",
  };
}

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

async function downloadBundle(params: {
  gatewayUrl: string;
  gatewayTlsFingerprint?: string;
  input: NodeWorkerBundleInstallInput;
  destination: string;
  signal?: AbortSignal;
}): Promise<void> {
  const response = await openNodeWorkerTransferHttpRequest({
    gatewayUrl: params.gatewayUrl,
    tlsFingerprint: params.gatewayTlsFingerprint,
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
  const output = fs.createWriteStream(params.destination, { flags: "wx", mode: 0o600 });
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const value of response) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.byteLength;
      if (bytes > params.input.archive.bytes || bytes > MAX_WORKER_BUNDLE_ARCHIVE_BYTES) {
        throw new Error("worker bundle download exceeded its byte limit");
      }
      hash.update(chunk);
      if (!output.write(chunk)) {
        await new Promise<void>((resolve, reject) => {
          output.once("drain", resolve);
          output.once("error", reject);
        });
      }
    }
    await new Promise<void>((resolve, reject) => {
      output.end(resolve);
      output.once("error", reject);
    });
  } catch (error) {
    output.destroy();
    await fsp.rm(params.destination, { force: true });
    throw error;
  }
  if (bytes !== params.input.archive.bytes || hash.digest("hex") !== params.input.archive.sha256) {
    await fsp.rm(params.destination, { force: true });
    throw new Error("worker bundle download failed integrity validation");
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
    const entry = await fsp.realpath(path.join(root, "openclaw.mjs"));
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

async function publishBundle(destination: string, staging: string): Promise<void> {
  const prior = `${destination}.previous-${process.pid}-${randomUUID()}`;
  let movedPrior = false;
  try {
    await fsp.rename(destination, prior);
    movedPrior = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  try {
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
  readonly #env: NodeJS.ProcessEnv;
  readonly #runCommand: BundleInstallCommandRunner;
  readonly #operations = new KeyedAsyncQueue();

  constructor(
    options: {
      root?: string;
      env?: NodeJS.ProcessEnv;
      runCommand?: BundleInstallCommandRunner;
    } = {},
  ) {
    const env = options.env ?? process.env;
    this.#root = path.resolve(options.root ?? path.join(resolveStateDir(env), "node-host"));
    this.#env = { ...env };
    this.#runCommand = options.runCommand ?? runCommandWithTimeout;
  }

  async ensure(params: {
    input: NodeWorkerBundleInstallInput;
    gatewayUrl: string;
    gatewayTlsFingerprint?: string;
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
        if (await validateInstalledBundle(destination, input.build)) {
          return structuredClone(input.build);
        }
        await fsp.mkdir(bundlesRoot, { recursive: true, mode: 0o700 });
        await removeStaleInstallStaging(bundlesRoot);
        const operationRoot = await fsp.mkdtemp(
          path.join(bundlesRoot, `.staging-${input.build.bundleHash}-`),
        );
        try {
          const archivePath = path.join(operationRoot, "bundle.tgz");
          const staging = path.join(operationRoot, "root");
          const homeDir = path.join(operationRoot, "home");
          await fsp.mkdir(homeDir, { mode: 0o700 });
          await downloadBundle({
            gatewayUrl: params.gatewayUrl,
            gatewayTlsFingerprint: params.gatewayTlsFingerprint,
            input,
            destination: archivePath,
            signal: params.signal,
          });
          await extractWorkerBundleArchive({
            tarballPath: archivePath,
            destination: staging,
            expectedBundleHash: input.build.bundleHash,
            limits: DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
          });
          const install = await this.#runCommand(
            [
              "npm",
              "install",
              "--prefix",
              staging,
              "--ignore-scripts",
              "--omit=dev",
              "--no-audit",
              "--no-fund",
              "--package-lock=false",
            ],
            {
              cwd: staging,
              baseEnv: commandEnv(homeDir, this.#env),
              timeoutMs: INSTALL_TIMEOUT_MS,
              signal: params.signal,
              maxOutputBytes: 256 * 1024,
              maxCombinedOutputBytes: 512 * 1024,
            },
          );
          if (install.termination !== "exit" || install.code !== 0) {
            throw new Error("worker bundle dependency installation failed");
          }
          const installedManifest = await readWorkerBundleDirectoryManifest({
            root: staging,
            limits: DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
            ignoreTopLevel: new Set(["node_modules"]),
          });
          if (hashWorkerBundleManifest(installedManifest) !== input.build.bundleHash) {
            throw new Error("worker bundle changed during dependency installation");
          }
          const receipt = await fsp.open(path.join(staging, INSTALL_RECEIPT), "wx", 0o600);
          try {
            await receipt.writeFile(`${JSON.stringify(input.build)}\n`);
            await receipt.sync();
          } finally {
            await receipt.close();
          }
          await publishBundle(destination, staging);
          if (!(await validateInstalledBundle(destination, input.build))) {
            throw new Error("published worker bundle failed validation");
          }
          return structuredClone(input.build);
        } finally {
          await fsp.rm(operationRoot, { recursive: true, force: true });
        }
      } catch (error) {
        if (error instanceof NodeWorkerBundleInstallError) {
          throw error;
        }
        if (error instanceof NodeWorkerTransferHttpError) {
          throw new NodeWorkerBundleInstallError(
            error.reason === "tls-fingerprint-mismatch"
              ? "worker-bundle-install-failed: gateway TLS fingerprint mismatch"
              : "worker-bundle-install-failed: gateway transfer is unavailable",
            { cause: error },
          );
        }
        throw new NodeWorkerBundleInstallError(
          "worker-bundle-install-failed: bundle installation did not complete",
          { cause: error },
        );
      }
    });
  }
}

export type NodeWorkerBundleInstallerControl = Pick<NodeWorkerBundleInstaller, "ensure">;
