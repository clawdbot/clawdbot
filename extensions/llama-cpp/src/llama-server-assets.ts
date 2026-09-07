import path from "node:path";
import type { ArchiveExtractLimits } from "openclaw/plugin-sdk/archive";
import { resolveLlamaCppDataDir } from "./defaults.js";

export const LLAMA_SERVER_RELEASE = "b10809";
export const LLAMA_SERVER_BUILD = 10_809;
export const LLAMA_SERVER_COMMIT = "5266f24da75dc449bd56cbed7addb9c8e4a6a73e";

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
const CUDA_ARCHIVE_LIMITS = {
  maxArchiveBytes: 400 * MEBIBYTE,
  maxExtractedBytes: 600 * MEBIBYTE,
  maxEntryBytes: 521 * MEBIBYTE,
};

// These basenames are authenticated by the adjacent release checksum. Archive-provided
// links are ignored; update this manifest together with each pinned llama.cpp release.
const MACOS_ALIASES = [
  ["libggml-rpc.0.23.0.dylib", ["libggml-rpc.0.dylib", "libggml-rpc.dylib"]],
  ["libllama.0.4.0.dylib", ["libllama.0.dylib", "libllama.dylib"]],
  ["libmtmd.0.4.0.dylib", ["libmtmd.0.dylib", "libmtmd.dylib"]],
  ["libggml.0.23.0.dylib", ["libggml.0.dylib", "libggml.dylib"]],
  ["libggml-base.0.23.0.dylib", ["libggml-base.0.dylib", "libggml-base.dylib"]],
  ["libggml-blas.0.23.0.dylib", ["libggml-blas.0.dylib", "libggml-blas.dylib"]],
  ["libllama-common.0.4.0.dylib", ["libllama-common.0.dylib", "libllama-common.dylib"]],
  ["libggml-cpu.0.23.0.dylib", ["libggml-cpu.0.dylib", "libggml-cpu.dylib"]],
] as const satisfies RegularFileAliases;

const MACOS_METAL_ALIASES = [
  ...MACOS_ALIASES,
  ["libggml-metal.0.23.0.dylib", ["libggml-metal.0.dylib", "libggml-metal.dylib"]],
] as const satisfies RegularFileAliases;

const LINUX_ALIASES = [
  ["libllama.so.0.4.0", ["libllama.so.0", "libllama.so"]],
  ["libggml.so.0.23.0", ["libggml.so.0", "libggml.so"]],
  ["libmtmd.so.0.4.0", ["libmtmd.so.0", "libmtmd.so"]],
  ["libggml-base.so.0.23.0", ["libggml-base.so.0", "libggml-base.so"]],
  ["libllama-common.so.0.4.0", ["libllama-common.so.0", "libllama-common.so"]],
] as const satisfies RegularFileAliases;

const LLAMA_SERVER_ASSETS: LlamaServerAsset[] = [
  {
    platform: "darwin",
    arch: "arm64",
    backend: "metal",
    archive: "tar.gz",
    archiveRoot: `llama-${LLAMA_SERVER_RELEASE}`,
    name: `llama-${LLAMA_SERVER_RELEASE}-bin-macos-arm64.tar.gz`,
    sha256: "7d692df9e1e386e62f1c12b843903218041e6cd74c9415aa39a7ed3176f9eaa2",
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
    sha256: "13b34aa8a5d87341a21065a83f54a8167e1aaa6fe0d66065de01632a1ed64be6",
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
    sha256: "f2b7333971e1b7b42e9268bfdbfa30f5f56e2897156084d2251385df94aec358",
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
    sha256: "5e34434ddc6d03cd1584f403201aff0d4bd1a5793a72ff7e286532dfd1e4b941",
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
    sha256: "c77bfcd9ed8d91e8721a2d6a290b907fddd4fa5412a47b21c6fa1709116b85f9",
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
    sha256: "c1058fe5764a687275c8d20d6bbc1454e787cdbb8ebb8c37a2f959f2b144dc77",
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
    sha256: "9df3158ed228a641a4b127942d7f459f24c9e13f04682659d05c00c80099b6b5",
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
