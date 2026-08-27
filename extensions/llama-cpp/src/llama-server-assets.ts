import path from "node:path";
import { resolveLlamaCppDataDir } from "./defaults.js";

export const LLAMA_SERVER_RELEASE = "b10534";
export const LLAMA_SERVER_BUILD = 10_534;
export const LLAMA_SERVER_COMMIT = "2b5621094ef383cdcd8428ef6d22efe5df976532";

type RegularFileAliases = ReadonlyArray<readonly [source: string, aliases: readonly string[]]>;

export type LlamaServerAsset = {
  platform: NodeJS.Platform;
  arch: string;
  backend: "metal" | "cpu";
  archive: "tar.gz" | "zip";
  archiveRoot: string;
  name: string;
  sha256: string;
  executable: string;
  regularFileAliases: RegularFileAliases;
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
  arch = process.arch,
): LlamaServerAsset {
  const asset = LLAMA_SERVER_ASSETS.find(
    (candidate) => candidate.platform === platform && candidate.arch === arch,
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
    `${asset.platform}-${asset.arch}`,
  );
  return {
    installDir,
    command: path.join(installDir, asset.executable),
    presetPath: path.join(resolveLlamaCppDataDir(), "models.ini"),
  };
}
