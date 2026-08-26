import path from "node:path";
import { resolveLlamaCppDataDir } from "./defaults.js";

export const LLAMA_SERVER_RELEASE = "b10472";
export const LLAMA_SERVER_BUILD = 10_472;
export const LLAMA_SERVER_COMMIT = "60eeeb6082c1126bb8bc72902c83123cd056811b";

export type LlamaServerAsset = {
  platform: NodeJS.Platform;
  arch: string;
  backend: "metal" | "cpu";
  archive: "tar.gz" | "zip";
  name: string;
  sha256: string;
  executable: string;
};

const LLAMA_SERVER_ASSETS: LlamaServerAsset[] = [
  {
    platform: "darwin",
    arch: "arm64",
    backend: "metal",
    archive: "tar.gz",
    name: `llama-${LLAMA_SERVER_RELEASE}-bin-macos-arm64.tar.gz`,
    sha256: "194a3e7008cc8c4e7a8d201012f4a32102333664c2eb7d0511d091589c48a13c",
    executable: "llama-server",
  },
  {
    platform: "darwin",
    arch: "x64",
    backend: "cpu",
    archive: "tar.gz",
    name: `llama-${LLAMA_SERVER_RELEASE}-bin-macos-x64.tar.gz`,
    sha256: "fc92e1521cb1ddfd723ff81ea48fac0792a988da6ed052965a84411634d97fd4",
    executable: "llama-server",
  },
  {
    platform: "linux",
    arch: "arm64",
    backend: "cpu",
    archive: "tar.gz",
    name: `llama-${LLAMA_SERVER_RELEASE}-bin-ubuntu-arm64.tar.gz`,
    sha256: "3c289bb7be0766189f71c47791e28d9d80540871771c1c7930be3711784c1f4d",
    executable: "llama-server",
  },
  {
    platform: "linux",
    arch: "x64",
    backend: "cpu",
    archive: "tar.gz",
    name: `llama-${LLAMA_SERVER_RELEASE}-bin-ubuntu-x64.tar.gz`,
    sha256: "8826da7085323c25180cb997ebb48c121c0a3698ec102ea3248843d3a7ed4166",
    executable: "llama-server",
  },
  {
    platform: "win32",
    arch: "arm64",
    backend: "cpu",
    archive: "zip",
    name: `llama-${LLAMA_SERVER_RELEASE}-bin-win-cpu-arm64.zip`,
    sha256: "6de7a00ad19fa3c5a772575d8a4fc75b265fcc2b875a2206b437af7d925b29b1",
    executable: "llama-server.exe",
  },
  {
    platform: "win32",
    arch: "x64",
    backend: "cpu",
    archive: "zip",
    name: `llama-${LLAMA_SERVER_RELEASE}-bin-win-cpu-x64.zip`,
    sha256: "ef495329c85c171991972fd3226a179c1900368cab66e2ebba8b21a7471a74e5",
    executable: "llama-server.exe",
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
