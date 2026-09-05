import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs, { type BigIntStats } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveLlamaCppDataDir } from "./defaults.js";
import {
  LLAMA_SERVER_BUILD,
  LLAMA_SERVER_COMMIT,
  LLAMA_SERVER_RELEASE,
  resolveManagedLlamaServerPaths,
  selectLlamaServerAsset,
  type LlamaServerArchive,
  type LlamaServerAsset,
} from "./llama-server-assets.js";
import {
  extractLlamaServerArchive,
  extractLlamaServerDependencyArchive,
} from "./llama-server-extract.js";

export {
  resolveManagedLlamaServerPaths,
  selectLlamaServerAsset,
  type LlamaServerAsset,
} from "./llama-server-assets.js";

const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const VERSION_TIMEOUT_MS = 15_000;

export type LlamaDownloadProgress = (status: {
  downloadedSize: number;
  totalSize: number;
  bytesPerSecond: number;
}) => void;

const installationPromises = new Map<string, Promise<string>>();

function compareVersion(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }
  return 0;
}

function assertSupportedLinuxRuntime(asset: LlamaServerAsset): void {
  if (asset.platform !== "linux") {
    return;
  }
  const header = asOptionalRecord(asOptionalRecord(process.report?.getReport())?.header);
  const glibc = typeof header?.glibcVersionRuntime === "string" ? header.glibcVersionRuntime : "";
  if (!glibc) {
    throw new Error(
      "The verified Ubuntu llama-server build requires glibc and cannot run on musl/Alpine. Install llama-server manually for this host and configure its absolute path.",
    );
  }
  const minimum = asset.arch === "arm64" ? "2.38" : "2.34";
  if (compareVersion(glibc, minimum) < 0) {
    throw new Error(
      `The verified llama-server build requires glibc ${minimum}+ on Linux ${asset.arch}; this host has ${glibc}. Install a compatible llama-server manually and configure its absolute path.`,
    );
  }
}

function assetUrl(asset: LlamaServerArchive): string {
  return `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_SERVER_RELEASE}/${asset.name}`;
}

const verifiedFiles = new Map<string, { identity: string; sha256: string }>();
const VERIFIED_FILE_LIMIT = 16;

function fileIdentity(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function rememberVerifiedFile(filePath: string, stat: BigIntStats, sha256: string): void {
  verifiedFiles.delete(filePath);
  verifiedFiles.set(filePath, { identity: fileIdentity(stat), sha256 });
  if (verifiedFiles.size > VERIFIED_FILE_LIMIT) {
    const oldest = verifiedFiles.keys().next().value;
    if (oldest !== undefined) {
      verifiedFiles.delete(oldest);
    }
  }
}

export async function sha256File(filePath: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  try {
    const identity = fileIdentity(await fsp.stat(filePath, { bigint: true }));
    const verified = verifiedFiles.get(filePath);
    if (verified?.identity === identity) {
      return verified.sha256;
    }
    verifiedFiles.delete(filePath);
    const handle = await fsp.open(filePath, "r");
    try {
      const before = fileIdentity(await handle.stat({ bigint: true }));
      const hash = createHash("sha256");
      // Bind the digest to an open file, not a pathname that can be replaced during the scan.
      const input = handle.createReadStream({
        autoClose: false,
        highWaterMark: 1024 * 1024,
        signal,
      });
      for await (const chunk of input) {
        hash.update(chunk);
      }
      const after = await handle.stat({ bigint: true });
      if (
        before !== fileIdentity(after) ||
        before !== fileIdentity(await fsp.stat(filePath, { bigint: true }))
      ) {
        throw new Error(`File changed during integrity verification: ${filePath}. Retry setup.`);
      }
      const sha256 = hash.digest("hex");
      rememberVerifiedFile(filePath, after, sha256);
      return sha256;
    } finally {
      await handle.close();
    }
  } catch (error) {
    verifiedFiles.delete(filePath);
    throw error;
  }
}

function readResponseSha256(response: Response): string | undefined {
  for (const name of ["x-checksum-sha256", "x-linked-etag"]) {
    const value = response.headers.get(name)?.replace(/^W\//u, "").replaceAll('"', "").trim();
    if (value && /^[a-f\d]{64}$/iu.test(value)) {
      return value.toLowerCase();
    }
  }
  const encoded = response.headers.get("digest")?.match(/(?:^|,)\s*sha-256=([^,\s]+)/iu)?.[1];
  return encoded ? Buffer.from(encoded, "base64").toString("hex") : undefined;
}

export async function downloadVerifiedFile(params: {
  url: string;
  destination: string;
  expectedSha256?: string;
  expectedSize?: number;
  requireServerDigest?: boolean;
  signal?: AbortSignal;
  onProgress?: LlamaDownloadProgress;
}): Promise<void> {
  const partialPath = `${params.destination}.partial-${randomUUID()}`;
  await fsp.mkdir(path.dirname(params.destination), { recursive: true });
  // Setup/doctor closure must not cold-load the SSRF barrel (DNS, proxy state,
  // logging); defer it to actual download time per the closure guard contract.
  const { fetchWithSsrFGuard, ssrfPolicyFromHttpBaseUrlAllowedOrigin } =
    await import("openclaw/plugin-sdk/ssrf-runtime");
  try {
    const { response, release } = await fetchWithSsrFGuard({
      url: params.url,
      signal: params.signal,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      policy: ssrfPolicyFromHttpBaseUrlAllowedOrigin(params.url),
      requireHttps: true,
      auditContext: "llama-cpp-download",
    });
    try {
      if (!response.ok || !response.body) {
        throw new Error(`download failed: HTTP ${response.status} ${response.statusText}`);
      }
      const expectedSha256 = params.expectedSha256 ?? readResponseSha256(response);
      if (!expectedSha256 && params.requireServerDigest) {
        throw new Error(
          "the download server did not provide a SHA-256 digest; download the GGUF manually and configure its local path",
        );
      }
      const contentLength = Number(response.headers.get("content-length"));
      const totalSize =
        params.expectedSize ??
        (Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0);
      const handle = await fsp.open(partialPath, "wx", 0o600);
      const hash = createHash("sha256");
      let downloadedSize = 0;
      let previousSize = 0;
      let previousAt = Date.now();
      let rollingBytesPerSecond = 0;
      try {
        // Unlock on every exit; the guard owns aborting an unfinished download.
        for await (const value of response.body.values({ preventCancel: true })) {
          const chunk = Buffer.from(value);
          await handle.writeFile(chunk);
          hash.update(chunk);
          downloadedSize += chunk.byteLength;
          const now = Date.now();
          if (now > previousAt) {
            const currentRate = ((downloadedSize - previousSize) * 1000) / (now - previousAt);
            rollingBytesPerSecond =
              rollingBytesPerSecond === 0
                ? currentRate
                : rollingBytesPerSecond * 0.75 + currentRate * 0.25;
          }
          previousSize = downloadedSize;
          previousAt = now;
          params.onProgress?.({ downloadedSize, totalSize, bytesPerSecond: rollingBytesPerSecond });
        }
        if (params.expectedSize && downloadedSize !== params.expectedSize) {
          throw new Error(
            `download size mismatch: expected ${params.expectedSize}, got ${downloadedSize}`,
          );
        }
        const actualSha256 = hash.digest("hex");
        if (expectedSha256 && actualSha256 !== expectedSha256.toLowerCase()) {
          throw new Error(
            `download SHA-256 mismatch: expected ${expectedSha256}, got ${actualSha256}`,
          );
        }
        const completed = await handle.stat({ bigint: true });
        params.signal?.throwIfAborted();
        await fsp.rename(partialPath, params.destination);
        const published = await handle.stat({ bigint: true });
        // Rename can change ctime. Retain the verified open file's publication identity so
        // setup and cold chat preparation do not rescan a multi-GB download in this process.
        if (completed.size === published.size && completed.mtimeNs === published.mtimeNs) {
          rememberVerifiedFile(params.destination, published, actualSha256);
        }
      } finally {
        await handle.close();
      }
    } finally {
      await release();
    }
  } finally {
    await fsp.rm(partialPath, { force: true }).catch(() => undefined);
  }
}

async function runServerCommand(
  command: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: VERSION_TIMEOUT_MS, signal, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(error.message, { cause: error }));
        } else {
          resolve(`${stdout}${stderr}`.trim());
        }
      },
    );
  });
}

function formatRuntimeDependencyError(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  if (process.platform === "linux") {
    return new Error(
      `The verified llama-server build could not start. Install the OpenMP runtime (for example libgomp1 on Debian/Ubuntu or libgomp on Fedora), then rerun llama.cpp setup. Detail: ${detail}`,
      { cause: error },
    );
  }
  if (process.platform === "win32") {
    return new Error(
      `The verified llama-server build could not start. Install the Microsoft Visual C++ 2015-2022 Redistributable, then rerun llama.cpp setup. Detail: ${detail}`,
      { cause: error },
    );
  }
  return new Error(`The verified llama-server build could not start: ${detail}`, { cause: error });
}

async function validateInstalledServer(
  command: string,
  asset: LlamaServerAsset,
  signal?: AbortSignal,
): Promise<void> {
  let version: string;
  try {
    version = await runServerCommand(command, ["--version"], signal);
  } catch (error) {
    signal?.throwIfAborted();
    throw formatRuntimeDependencyError(error);
  }
  const versionLine = version.split(/\r?\n/u, 1)[0]?.trim() ?? "";
  const match = versionLine.match(/^version: .+ \(build (\d+), commit ([a-f\d]{9})\)$/u);
  const build = match?.[1] ? Number(match[1]) : undefined;
  const commit = match?.[2];
  if (build !== LLAMA_SERVER_BUILD || commit !== LLAMA_SERVER_COMMIT.slice(0, 9)) {
    throw new Error(
      `Unexpected llama-server build at ${command}: expected ${LLAMA_SERVER_RELEASE} (${LLAMA_SERVER_COMMIT.slice(0, 9)}), got ${version || "no version output"}`,
    );
  }
  if (asset.backend === "cuda") {
    // --version succeeds even if a dynamically loaded CUDA backend fails. Device
    // enumeration must prove CUDA is usable before this installation is published.
    const devices = await runServerCommand(command, ["--list-devices"], signal);
    if (!/^\s*CUDA\d+: .+\(\d+ MiB, \d+ MiB free\)$/mu.test(devices)) {
      throw new Error(
        "The verified llama-server could not initialize an NVIDIA CUDA device. Update the NVIDIA driver and rerun setup, or configure a compatible llama-server manually. CPU fallback was not activated.",
      );
    }
  }
}

type LlamaServerInstallOptions = {
  asset?: LlamaServerAsset;
  signal?: AbortSignal;
  onProgress?: LlamaDownloadProgress;
};

async function installLlamaServer(
  asset: LlamaServerAsset,
  options: LlamaServerInstallOptions,
): Promise<string> {
  options.signal?.throwIfAborted();
  assertSupportedLinuxRuntime(asset);
  const { installDir, command } = resolveManagedLlamaServerPaths(asset);
  if (
    await fsp
      .stat(command)
      .then((stat) => stat.isFile())
      .catch(() => false)
  ) {
    await validateInstalledServer(command, asset, options.signal);
    return command;
  }
  const dataDir = resolveLlamaCppDataDir();
  const archivePath = path.join(dataDir, `.download-${randomUUID()}-${asset.name}`);
  const extractDir = path.join(dataDir, `.extract-${randomUUID()}`);
  await fsp.mkdir(dataDir, { recursive: true });
  try {
    await downloadVerifiedFile({
      url: assetUrl(asset),
      destination: archivePath,
      expectedSha256: asset.sha256,
      signal: options.signal,
      onProgress: options.onProgress,
    });
    const serverExtractDir = path.join(extractDir, "server");
    await fsp.mkdir(serverExtractDir, { recursive: true });
    const extractedCommand = await extractLlamaServerArchive({
      archivePath,
      destDir: serverExtractDir,
      asset,
    });
    const extractedRoot = path.dirname(extractedCommand);
    for (const [index, dependency] of (asset.dependencies ?? []).entries()) {
      options.signal?.throwIfAborted();
      const dependencyArchive = path.join(extractDir, dependency.name);
      await downloadVerifiedFile({
        url: assetUrl(dependency),
        destination: dependencyArchive,
        expectedSha256: dependency.sha256,
        signal: options.signal,
        onProgress: options.onProgress,
      });
      const dependencyExtractDir = path.join(extractDir, `dependency-${index}`);
      await fsp.mkdir(dependencyExtractDir);
      const dependencyRoot = await extractLlamaServerDependencyArchive({
        archivePath: dependencyArchive,
        destDir: dependencyExtractDir,
        asset: dependency,
      });
      for (const file of dependency.files) {
        await fsp.copyFile(
          path.join(dependencyRoot, file),
          path.join(extractedRoot, file),
          fs.constants.COPYFILE_EXCL,
        );
      }
    }
    options.signal?.throwIfAborted();
    await fsp.chmod(extractedCommand, 0o755);
    await validateInstalledServer(extractedCommand, asset, options.signal);
    await fsp.mkdir(path.dirname(installDir), { recursive: true });
    options.signal?.throwIfAborted();
    await fsp.rm(installDir, { recursive: true, force: true });
    await fsp.rename(extractedRoot, installDir);
    await validateInstalledServer(command, asset, options.signal);
    return command;
  } finally {
    await Promise.all([
      fsp.rm(archivePath, { force: true }),
      fsp.rm(extractDir, { recursive: true, force: true }),
    ]);
  }
}

export async function ensureLlamaServerInstalled(options: LlamaServerInstallOptions = {}): Promise<{
  command: string;
  asset: LlamaServerAsset;
}> {
  options.signal?.throwIfAborted();
  const asset = options.asset ?? selectLlamaServerAsset();
  const key = resolveManagedLlamaServerPaths(asset).command;
  const previous = installationPromises.get(key);
  // Each caller owns its cancellation. Serialize attempts so a cancelled setup
  // cannot poison another caller or race its archive cleanup/publication.
  const pending = Promise.resolve(previous)
    .catch(() => undefined)
    .then(() => installLlamaServer(asset, options))
    .finally(() => {
      if (installationPromises.get(key) === pending) {
        installationPromises.delete(key);
      }
    });
  installationPromises.set(key, pending);
  const command =
    previous && options.signal
      ? await new Promise<string>((resolve, reject) => {
          const signal = options.signal;
          const onAbort = () => reject(toErrorObject(signal?.reason, "Installation cancelled"));
          signal?.addEventListener("abort", onAbort, { once: true });
          void pending
            .then(resolve, reject)
            .finally(() => signal?.removeEventListener("abort", onAbort));
          if (signal?.aborted) {
            onAbort();
          }
        })
      : await pending;
  return { command, asset };
}
