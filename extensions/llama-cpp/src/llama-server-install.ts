import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import * as tar from "tar";
import { resolveLlamaCppDataDir } from "./defaults.js";
import {
  LLAMA_SERVER_BUILD,
  LLAMA_SERVER_COMMIT,
  LLAMA_SERVER_RELEASE,
  resolveManagedLlamaServerPaths,
  selectLlamaServerAsset,
  type LlamaServerAsset,
} from "./llama-server-assets.js";

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

function assetUrl(asset: LlamaServerAsset): string {
  return `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_SERVER_RELEASE}/${asset.name}`;
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const input = fs.createReadStream(filePath);
    input.on("data", (chunk) => hash.update(chunk));
    input.once("error", reject);
    input.once("end", resolve);
  });
  return hash.digest("hex");
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
      const reader = response.body.getReader();
      let downloadedSize = 0;
      let previousSize = 0;
      let previousAt = Date.now();
      let rollingBytesPerSecond = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
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
      } finally {
        await handle.close();
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
      await fsp.rename(partialPath, params.destination);
    } finally {
      await release();
    }
  } finally {
    await fsp.rm(partialPath, { force: true }).catch(() => undefined);
  }
}

async function extractZip(archivePath: string, destination: string): Promise<void> {
  const zip = await JSZip.loadAsync(await fsp.readFile(archivePath));
  for (const entry of Object.values(zip.files)) {
    const normalized = path.posix.normalize(entry.name);
    if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) {
      throw new Error(`unsafe path in llama-server archive: ${entry.name}`);
    }
    const outputPath = path.join(destination, ...normalized.split("/"));
    if (entry.dir) {
      await fsp.mkdir(outputPath, { recursive: true });
    } else {
      await fsp.mkdir(path.dirname(outputPath), { recursive: true });
      await fsp.writeFile(outputPath, await entry.async("nodebuffer"), { mode: 0o600 });
    }
  }
}

async function findExecutable(root: string, executable: string): Promise<string> {
  for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isFile() && entry.name === executable) {
      return candidate;
    }
    if (entry.isDirectory()) {
      const nested = await findExecutable(candidate, executable).catch(() => undefined);
      if (nested) {
        return nested;
      }
    }
  }
  throw new Error(`llama-server archive does not contain ${executable}`);
}

async function runVersion(command: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFile(command, ["--version"], { timeout: VERSION_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(error.message, { cause: error }));
      } else {
        resolve(`${stdout}${stderr}`.trim());
      }
    });
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

async function validateInstalledServer(command: string): Promise<void> {
  let version: string;
  try {
    version = await runVersion(command);
  } catch (error) {
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
}

async function installLlamaServer(asset: LlamaServerAsset): Promise<string> {
  assertSupportedLinuxRuntime(asset);
  const { installDir, command } = resolveManagedLlamaServerPaths(asset);
  if (
    await fsp
      .stat(command)
      .then((stat) => stat.isFile())
      .catch(() => false)
  ) {
    await validateInstalledServer(command);
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
    });
    await fsp.mkdir(extractDir, { recursive: true });
    if (asset.archive === "zip") {
      await extractZip(archivePath, extractDir);
    } else {
      await tar.x({ file: archivePath, cwd: extractDir, preservePaths: false });
    }
    const extractedCommand = await findExecutable(extractDir, asset.executable);
    const extractedRoot = path.dirname(extractedCommand);
    await fsp.chmod(extractedCommand, 0o755);
    await validateInstalledServer(extractedCommand);
    await fsp.mkdir(path.dirname(installDir), { recursive: true });
    await fsp.rm(installDir, { recursive: true, force: true });
    await fsp.rename(extractedRoot, installDir);
    await validateInstalledServer(command);
    return command;
  } finally {
    await Promise.all([
      fsp.rm(archivePath, { force: true }),
      fsp.rm(extractDir, { recursive: true, force: true }),
    ]);
  }
}

export async function ensureLlamaServerInstalled(): Promise<{
  command: string;
  asset: LlamaServerAsset;
}> {
  const asset = selectLlamaServerAsset();
  const key = `${asset.platform}/${asset.arch}/${LLAMA_SERVER_RELEASE}`;
  const pending = installationPromises.get(key) ?? installLlamaServer(asset);
  installationPromises.set(key, pending);
  try {
    return { command: await pending, asset };
  } finally {
    if (installationPromises.get(key) === pending) {
      installationPromises.delete(key);
    }
  }
}
