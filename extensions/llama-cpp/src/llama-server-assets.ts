import path from "node:path";
import type { ArchiveExtractLimits } from "openclaw/plugin-sdk/archive";
import { resolveLlamaCppDataDir } from "./defaults.js";

export const LLAMA_SERVER_RELEASE = "b10534";
export const LLAMA_SERVER_BUILD = 10_534;
export const LLAMA_SERVER_COMMIT = "2b5621094ef383cdcd8428ef6d22efe5df976532";

type RegularFileAliases = ReadonlyArray<readonly [source: string, aliases: readonly string[]]>;

export type LlamaServerArchive = {
  archive: "tar.gz" | "zip";
  archiveRoot: string;
  name: string;
  sha256: string;
  regularFileAliases: RegularFileAliases;
  limits?: ArchiveExtractLimits;
};

export type LlamaServerAsset = LlamaServerArchive & {
  platform: NodeJS.Platform;
  arch: string;
  backend: "metal" | "cpu" | "cuda";
  executable: string;
  dependencies?: ReadonlyArray<LlamaServerArchive & { files: readonly string[] }>;
};

const MEBIBYTE = 1024 * 1024;
// CUDA's verified ggml-cuda.dll is 538 MB; its separate runtime contains 574 MB of DLLs.
// Keep the larger budget local to these pinned archives, not every managed download.
const CUDA_ARCHIVE_LIMITS = {
  maxArchiveBytes: 400 * MEBIBYTE,
  maxExtractedBytes: 600 * MEBIBYTE,
  maxEntryBytes: 520 * MEBIBYTE,
};

// These basenames are authenticated by the adjacent release checksum. Archive-provided
// links are ignored; update this manifest together with each pinned llama.cpp release.
const MACOS_ALIASES = [
  ["libggml-rpc.0.20.2.dylib", ["libggml-rpc.0.dylib", "libggml-rpc.dylib"]],
  ["libllama.0.1.2.dylib", ["libllama.0.dylib", "libllama.dylib"]],
  ["libmtmd.0.1.2.dylib", ["libmtmd.0.dylib", "libmtmd.dylib"]],
  ["libggml.0.20.2.dylib", ["libggml.0.dylib", "libggml.dylib"]],
  ["libggml-base.0.20.2.dylib", ["libggml-base.0.dylib", "libggml-base.dylib"]],
  ["libggml-blas.0.20.2.dylib", ["libggml-blas.0.dylib", "libggml-blas.dylib"]],
  ["libllama-common.0.1.2.dylib", ["libllama-common.0.dylib", "libllama-common.dylib"]],
  ["libggml-cpu.0.20.2.dylib", ["libggml-cpu.0.dylib", "libggml-cpu.dylib"]],
] as const satisfies RegularFileAliases;

const MACOS_METAL_ALIASES = [
  ...MACOS_ALIASES,
  ["libggml-metal.0.20.2.dylib", ["libggml-metal.0.dylib", "libggml-metal.dylib"]],
] as const satisfies RegularFileAliases;

const LINUX_ALIASES = [
  ["libllama.so.0.1.2", ["libllama.so.0", "libllama.so"]],
  ["libggml.so.0.20.2", ["libggml.so.0", "libggml.so"]],
  ["libmtmd.so.0.1.2", ["libmtmd.so.0", "libmtmd.so"]],
  ["libggml-base.so.0.20.2", ["libggml-base.so.0", "libggml-base.so"]],
  ["libllama-common.so.0.1.2", ["libllama-common.so.0", "libllama-common.so"]],
] as const satisfies RegularFileAliases;

const LLAMA_SERVER_ASSETS: LlamaServerAsset[] = [
  {
    platform: "darwin",
    arch: "arm64",
    backend: "metal",
    archive: "tar.gz",
    archiveRoot: `llama-${LLAMA_SERVER_RELEASE}`,
    name: `llama-${LLAMA_SERVER_RELEASE}-bin-macos-arm64.tar.gz`,
    sha256: "51f193eef26b053554e288fb924b24d41d3d7b2bafa338c19e2817fa793d5e86",
    executable: "llama-server",
    regularFileAliases: MACOS_METAL_ALIASES,
  },
  {
    platform: "darwin",
    arch: "x64",
    backend: "cpu",
    archive: "tar.gz",
    archiveRoot: `llama-${LLAMA_SERVER_RELEASE}`,
    name: `llama-${LLAMA_SERVER_RELEASE}-bin-macos-x64.tar.gz`,
    sha256: "69b13035f4301354922a8cfacd1bcf2bb2de4ff0c2e19fedb44963378ff53dc5",
    executable: "llama-server",
    regularFileAliases: MACOS_ALIASES,
  },
  {
    platform: "linux",
    arch: "arm64",
    backend: "cpu",
    archive: "tar.gz",
    archiveRoot: `llama-${LLAMA_SERVER_RELEASE}`,
    name: `llama-${LLAMA_SERVER_RELEASE}-bin-ubuntu-arm64.tar.gz`,
    sha256: "66535de5cb9293c075a1951c51a3b2ae6f1899623e21177845f6d2a73b78c94e",
    executable: "llama-server",
    regularFileAliases: LINUX_ALIASES,
  },
  {
    platform: "linux",
    arch: "x64",
    backend: "cpu",
    archive: "tar.gz",
    archiveRoot: `llama-${LLAMA_SERVER_RELEASE}`,
    name: `llama-${LLAMA_SERVER_RELEASE}-bin-ubuntu-x64.tar.gz`,
    sha256: "cc6a12b026edcf1b211be2bb7366c5dadcad778fd8f13019d0694038053d5e4a",
    executable: "llama-server",
    regularFileAliases: LINUX_ALIASES,
  },
  {
    platform: "win32",
    arch: "x64",
    backend: "cuda",
    archive: "zip",
    archiveRoot: ".",
    name: `llama-${LLAMA_SERVER_RELEASE}-bin-win-cuda-12.4-x64.zip`,
    sha256: "f4964cec6c96e90a5f7379e4c2d0c437d8f1fe4263cbb8f39c7625f7c5937986",
    executable: "llama-server.exe",
    regularFileAliases: [],
    limits: CUDA_ARCHIVE_LIMITS,
    dependencies: [
      {
        archive: "zip",
        archiveRoot: ".",
        name: "cudart-llama-bin-win-cuda-12.4-x64.zip",
        sha256: "8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6",
        regularFileAliases: [],
        files: ["cublas64_12.dll", "cublasLt64_12.dll", "cudart64_12.dll"],
        limits: { ...CUDA_ARCHIVE_LIMITS, maxEntries: 3 },
      },
    ],
  },
  {
    platform: "win32",
    arch: "arm64",
    backend: "cpu",
    archive: "zip",
    archiveRoot: ".",
    name: `llama-${LLAMA_SERVER_RELEASE}-bin-win-cpu-arm64.zip`,
    sha256: "d33618b10fda35d34d85da60926c6c470f98f3f66ce6b52c3c1f583461416012",
    executable: "llama-server.exe",
    regularFileAliases: [],
  },
  {
    platform: "win32",
    arch: "x64",
    backend: "cpu",
    archive: "zip",
    archiveRoot: ".",
    name: `llama-${LLAMA_SERVER_RELEASE}-bin-win-cpu-x64.zip`,
    sha256: "295ae03ad58d9276afa36f5f8d111d67fc1491c7aff3a3e6d13051a772f93c21",
    executable: "llama-server.exe",
    regularFileAliases: [],
  },
];

export function selectLlamaServerAsset(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  acceleration?:
    | { kind: "cpu" | "metal" }
    | { kind: "cuda"; devices: readonly { driverVersion: string; computeCapability?: number }[] },
): LlamaServerAsset {
  const backend =
    acceleration?.kind ?? (platform === "darwin" && arch === "arm64" ? "metal" : "cpu");
  if (backend === "cuda" && acceleration?.kind === "cuda") {
    if (platform !== "win32" || arch !== "x64") {
      throw new Error(
        `No verified CUDA llama-server ${LLAMA_SERVER_RELEASE} build is available for ${platform}/${arch}. Install a CUDA-enabled llama-server manually and configure its absolute path, or explicitly choose CPU setup.`,
      );
    }
    // The upstream build uses CUDA 12.4 Update 1 with PTX. Require its full driver
    // level: CUDA minor-version compatibility does not guarantee PTX JIT support.
    const compatible =
      acceleration.devices.length > 0 &&
      acceleration.devices.every((device) => {
        const version = /^(\d+)\.(\d+)(?:\.\d+)?$/u.exec(device.driverVersion);
        const driver =
          version &&
          (Number(version[1]) > 551 || (Number(version[1]) === 551 && Number(version[2]) >= 78));
        return driver && (device.computeCapability === undefined || device.computeCapability >= 5);
      });
    if (!compatible) {
      throw new Error(
        "The verified CUDA 12.4 build requires NVIDIA driver 551.78 or newer and compute capability 5.0 or newer. Update the NVIDIA driver, configure a compatible llama-server manually, or explicitly choose CPU setup.",
      );
    }
  }
  const asset = LLAMA_SERVER_ASSETS.find(
    (candidate) =>
      candidate.platform === platform && candidate.arch === arch && candidate.backend === backend,
  );
  if (!asset) {
    throw new Error(
      `No verified llama-server ${LLAMA_SERVER_RELEASE} build is available for ${platform}/${arch}. Install a compatible llama-server manually, then rerun llama.cpp setup with its absolute path.`,
    );
  }
  return asset;
}

export function resolveManagedLlamaServerPaths(asset = selectLlamaServerAsset()): {
  installDir: string;
  command: string;
  presetPath: string;
} {
  const installDir = path.join(
    resolveLlamaCppDataDir(),
    LLAMA_SERVER_RELEASE,
    `${asset.platform}-${asset.arch}${asset.backend === "cuda" ? "-cuda-12.4" : ""}`,
  );
  return {
    installDir,
    command: path.join(installDir, asset.executable),
    presetPath: path.join(resolveLlamaCppDataDir(), "models.ini"),
  };
}
