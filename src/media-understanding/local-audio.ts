import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { MediaUnderstandingModelConfig } from "../config/types.tools.js";
import { runExec } from "../process/exec.js";
import { fileExists } from "./fs.js";

export type LocalAudioCandidate = {
  id: "parakeet-mlx" | "whisper-cli" | "sherpa-onnx-offline" | "whisper";
  command: string;
  resolvedCommand?: string;
  available: boolean;
  ready: boolean;
  capableBackend?: "cuda" | "metal" | "mlx";
  requestedBackend?: string;
  observedBackend?: "cpu" | "cuda" | "metal";
  evidence: string;
  selected: boolean;
  reason?: string;
  entry?: MediaUnderstandingModelConfig;
};

export type LocalAudioSelection = {
  candidates: LocalAudioCandidate[];
  entries: MediaUnderstandingModelConfig[];
  selected?: LocalAudioCandidate;
};

type InspectionOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  resolveBinary?: (name: string, env: NodeJS.ProcessEnv) => Promise<string | null>;
  checkExecutable?: (filePath: string, platform: NodeJS.Platform) => Promise<boolean>;
  resolveRealpath?: (filePath: string) => Promise<string>;
  inspectLinkedLibraries?: (filePath: string, platform: NodeJS.Platform) => Promise<string | null>;
};

const binaryCache = new Map<string, Promise<string | null>>();
const libraryCache = new Map<string, Promise<string | null>>();
const observedBackendCache = new Map<string, "cpu" | "cuda" | "metal">();

export function clearLocalAudioInspectionCacheForTests(): void {
  binaryCache.clear();
  libraryCache.clear();
  observedBackendCache.clear();
}

function commandId(command: string): string {
  return path.basename(command.trim()).toLowerCase();
}

export function resolveRequestedLocalAudioBackend(params: {
  command: string;
  args: readonly string[];
}): string | undefined {
  const command = commandId(params.command);
  if (command === "sherpa-onnx-offline") {
    const providerIndex = params.args.findIndex((arg) => arg === "--provider");
    return (
      (providerIndex >= 0 ? params.args[providerIndex + 1] : undefined) ??
      params.args.find((arg) => arg.startsWith("--provider="))?.slice("--provider=".length) ??
      "cpu"
    )
      .trim()
      .toLowerCase();
  }
  if (command === "whisper-cli") {
    if (params.args.includes("-ng") || params.args.includes("--no-gpu")) {
      return "cpu";
    }
    const deviceIndex = params.args.findIndex((arg) => arg === "-dev" || arg === "--device");
    const device =
      (deviceIndex >= 0 ? params.args[deviceIndex + 1] : undefined) ??
      params.args.find((arg) => arg.startsWith("--device="))?.slice("--device=".length);
    return device?.trim() ? `device:${device.trim()}` : undefined;
  }
  return undefined;
}

function observationKey(params: { command: string; args: readonly string[] }): string {
  return `${params.command.trim()}\0${resolveRequestedLocalAudioBackend(params) ?? "default"}`;
}

export function recordLocalAudioBackendObservation(params: {
  command: string;
  args: readonly string[];
  output: string;
}): "cpu" | "cuda" | "metal" | undefined {
  if (commandId(params.command) !== "whisper-cli") {
    return undefined;
  }
  const backend = /using\s+(?:MTL\d+|Metal)\s+backend/i.test(params.output)
    ? "metal"
    : /using\s+CUDA\d*\s+backend/i.test(params.output)
      ? "cuda"
      : /using\s+CPU\s+backend|no GPU found/i.test(params.output)
        ? "cpu"
        : undefined;
  if (backend) {
    observedBackendCache.set(observationKey(params), backend);
  }
  return backend;
}

function getObservedBackend(params: {
  command: string;
  args: readonly string[];
}): "cpu" | "cuda" | "metal" | undefined {
  return observedBackendCache.get(observationKey(params));
}

async function isExecutable(filePath: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return false;
    }
    if (platform !== "win32") {
      await fs.access(filePath, fsConstants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

function binaryNames(name: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform !== "win32" || path.extname(name)) {
    return [name];
  }
  const extensions = (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean);
  return [name, ...extensions.map((extension) => `${name}${extension}`)];
}

function expandHomeDir(value: string, env: NodeJS.ProcessEnv): string {
  const trimmed = value.trim().replace(/^"(.*)"$/, "$1");
  if (trimmed === "~") {
    return env.HOME ?? trimmed;
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return env.HOME ? path.join(env.HOME, trimmed.slice(2)) : trimmed;
  }
  return trimmed;
}

async function findBinary(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  checkExecutable: (filePath: string, platform: NodeJS.Platform) => Promise<boolean> = isExecutable,
): Promise<string | null> {
  const key = `${platform}\0${env.PATH ?? ""}\0${env.PATHEXT ?? ""}\0${name}`;
  const cached = binaryCache.get(key);
  if (cached) {
    return await cached;
  }
  const lookup = (async () => {
    const direct = name.trim();
    const candidates = binaryNames(direct, platform, env);
    if (direct.includes("/") || direct.includes("\\")) {
      for (const candidate of candidates) {
        const expanded =
          candidate === "~" || candidate.startsWith("~/") || candidate.startsWith("~\\")
            ? path.join(env.HOME ?? "~", candidate.slice(candidate === "~" ? 1 : 2))
            : candidate;
        if (await checkExecutable(expanded, platform)) {
          return expanded;
        }
      }
      return null;
    }
    for (const directory of (env.PATH ?? "").split(path.delimiter)) {
      const expandedDirectory = expandHomeDir(directory, env);
      if (!expandedDirectory) {
        continue;
      }
      for (const candidate of candidates) {
        const fullPath = path.join(expandedDirectory, candidate);
        if (await checkExecutable(fullPath, platform)) {
          return fullPath;
        }
      }
    }
    return null;
  })();
  binaryCache.set(key, lookup);
  return await lookup;
}

async function inspectLinkedLibraries(
  filePath: string,
  platform: NodeJS.Platform,
): Promise<string | null> {
  const key = `${platform}\0${filePath}`;
  const cached = libraryCache.get(key);
  if (cached) {
    return await cached;
  }
  const inspection = (async () => {
    const command = platform === "darwin" ? "otool" : platform === "linux" ? "readelf" : null;
    if (!command) {
      return null;
    }
    try {
      const args = platform === "darwin" ? ["-L", filePath] : ["-d", filePath];
      const result = await runExec(command, args, { timeoutMs: 1500 });
      return `${result.stdout}\n${result.stderr ?? ""}`;
    } catch {
      return null;
    }
  })();
  libraryCache.set(key, inspection);
  return await inspection;
}

async function inspectWhisperBackend(params: {
  command: string;
  platform: NodeJS.Platform;
  arch: string;
  realpath: (filePath: string) => Promise<string>;
  libraries: (filePath: string, platform: NodeJS.Platform) => Promise<string | null>;
}): Promise<Pick<LocalAudioCandidate, "capableBackend" | "evidence">> {
  const libraries = await params.libraries(params.command, params.platform);
  if (/(?:ggml[-_]?cuda|libcuda|libcudart)/i.test(libraries ?? "")) {
    return {
      capableBackend: "cuda",
      evidence: "whisper-cli links a CUDA ggml runtime",
    };
  }
  if (params.platform === "darwin" && params.arch === "arm64") {
    const realCommand = await params.realpath(params.command).catch(() => params.command);
    if (
      /(?:ggml[-_]?metal|Metal\.framework)/i.test(libraries ?? "") ||
      /\/Cellar\/whisper-cpp\/[^/]+\/bin\/whisper-cli$/.test(realCommand)
    ) {
      return {
        capableBackend: "metal",
        evidence: "Apple Silicon Homebrew whisper-cpp runtime with Metal support",
      };
    }
  }
  return {
    evidence: "whisper-cli backend cannot be proven without loading a model",
  };
}

function rank(candidate: LocalAudioCandidate): number {
  if (
    candidate.id === "whisper-cli" &&
    (candidate.observedBackend === "metal" || candidate.observedBackend === "cuda")
  ) {
    return 0;
  }
  if (candidate.id === "sherpa-onnx-offline") {
    return 1;
  }
  if (candidate.id === "whisper-cli") {
    return 2;
  }
  return candidate.id === "parakeet-mlx" ? 3 : 4;
}

export async function inspectLocalAudioSelection(
  options: InspectionOptions = {},
): Promise<LocalAudioSelection> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const resolveBinary = async (name: string) =>
    options.resolveBinary
      ? await options.resolveBinary(name, env)
      : await findBinary(name, env, platform, options.checkExecutable);
  const [parakeetCommand, whisperCommand, sherpaCommand, pythonCommand] = await Promise.all(
    ["parakeet-mlx", "whisper-cli", "sherpa-onnx-offline", "whisper"].map(resolveBinary),
  );

  const envModel = env.WHISPER_CPP_MODEL?.trim();
  const defaultWhisperModel = "/opt/homebrew/share/whisper-cpp/for-tests-ggml-tiny.bin";
  const whisperModel = envModel && (await fileExists(envModel)) ? envModel : defaultWhisperModel;
  const whisperReady = Boolean(whisperCommand) && (await fileExists(whisperModel));
  const whisperBackend = whisperCommand
    ? await inspectWhisperBackend({
        command: whisperCommand,
        platform,
        arch,
        realpath: options.resolveRealpath ?? fs.realpath,
        libraries: options.inspectLinkedLibraries ?? inspectLinkedLibraries,
      })
    : {
        evidence: "whisper-cli command not found",
      };

  const sherpaDir = env.SHERPA_ONNX_MODEL_DIR?.trim();
  const sherpaFiles = sherpaDir
    ? ["tokens.txt", "encoder.onnx", "decoder.onnx", "joiner.onnx"].map((file) =>
        path.join(sherpaDir, file),
      )
    : [];
  const sherpaReady =
    Boolean(sherpaCommand) &&
    sherpaFiles.length === 4 &&
    (await Promise.all(sherpaFiles.map(fileExists))).every(Boolean);
  const parakeetReady = Boolean(parakeetCommand) && platform === "darwin" && arch === "arm64";
  const parakeetArgs = [
    "{{MediaPath}}",
    "--output-format",
    "txt",
    "--output-dir",
    "{{OutputDir}}",
    "--output-template",
    "{filename}",
  ];
  const whisperArgs = [
    "-m",
    whisperModel,
    "-otxt",
    "-of",
    "{{OutputBase}}",
    "-nt",
    "{{MediaPath}}",
  ];
  const sherpaArgs = [
    `--tokens=${sherpaFiles[0]}`,
    `--encoder=${sherpaFiles[1]}`,
    `--decoder=${sherpaFiles[2]}`,
    `--joiner=${sherpaFiles[3]}`,
    "{{MediaPath}}",
  ];
  const pythonArgs = [
    "--model",
    "turbo",
    "--output_format",
    "txt",
    "--output_dir",
    "{{OutputDir}}",
    "--verbose",
    "False",
    "{{MediaPath}}",
  ];

  const candidates: LocalAudioCandidate[] = [
    {
      id: "parakeet-mlx",
      command: "parakeet-mlx",
      resolvedCommand: parakeetCommand ?? undefined,
      available: Boolean(parakeetCommand),
      ready: parakeetReady,
      capableBackend: parakeetReady ? "mlx" : undefined,
      evidence: parakeetReady
        ? "parakeet-mlx is an MLX runtime on Apple Silicon; device use is unobserved"
        : "parakeet-mlx acceleration is only supported on Apple Silicon",
      selected: false,
      reason: parakeetCommand
        ? parakeetReady
          ? undefined
          : "unsupported platform for MLX acceleration"
        : "command not found",
      entry: parakeetReady
        ? {
            type: "cli",
            command: "parakeet-mlx",
            args: parakeetArgs,
          }
        : undefined,
    },
    {
      id: "whisper-cli",
      command: "whisper-cli",
      resolvedCommand: whisperCommand ?? undefined,
      available: Boolean(whisperCommand),
      ready: whisperReady,
      ...whisperBackend,
      requestedBackend: resolveRequestedLocalAudioBackend({
        command: "whisper-cli",
        args: whisperArgs,
      }),
      observedBackend: getObservedBackend({ command: "whisper-cli", args: whisperArgs }),
      selected: false,
      reason: whisperCommand
        ? whisperReady
          ? undefined
          : "model file not found"
        : "command not found",
      entry: whisperReady
        ? {
            type: "cli",
            command: "whisper-cli",
            args: whisperArgs,
          }
        : undefined,
    },
    {
      id: "sherpa-onnx-offline",
      command: "sherpa-onnx-offline",
      resolvedCommand: sherpaCommand ?? undefined,
      available: Boolean(sherpaCommand),
      ready: sherpaReady,
      requestedBackend: "cpu",
      evidence: "OpenClaw auto args omit --provider, so sherpa-onnx uses its CPU default",
      selected: false,
      reason: sherpaCommand
        ? sherpaReady
          ? undefined
          : "SHERPA_ONNX_MODEL_DIR is missing required model files"
        : "command not found",
      entry: sherpaReady
        ? {
            type: "cli",
            command: "sherpa-onnx-offline",
            args: sherpaArgs,
          }
        : undefined,
    },
    {
      id: "whisper",
      command: "whisper",
      resolvedCommand: pythonCommand ?? undefined,
      available: Boolean(pythonCommand),
      ready: Boolean(pythonCommand),
      evidence: "Python Whisper chooses its runtime device when the model loads",
      selected: false,
      reason: pythonCommand ? undefined : "command not found",
      entry: pythonCommand
        ? {
            type: "cli",
            command: "whisper",
            args: pythonArgs,
          }
        : undefined,
    },
  ];
  candidates.sort((left, right) => rank(left) - rank(right));
  const selected = candidates.find((candidate) => candidate.ready && candidate.entry);
  if (selected) {
    selected.selected = true;
  }
  return {
    candidates,
    entries: candidates.flatMap((candidate) =>
      candidate.ready && candidate.entry ? [candidate.entry] : [],
    ),
    selected,
  };
}

export function formatLocalAudioSelection(selection: LocalAudioSelection): string | null {
  const selected = selection.selected;
  if (!selected) {
    return null;
  }
  const describeBackend = (candidate: LocalAudioCandidate) =>
    [
      candidate.capableBackend ? `capable=${candidate.capableBackend}` : null,
      candidate.requestedBackend ? `requested=${candidate.requestedBackend}` : null,
      `observed=${candidate.observedBackend ?? "unknown"}`,
    ]
      .filter(Boolean)
      .join(", ");
  const fallbacks = selection.candidates
    .filter((candidate) => candidate.ready && candidate !== selected)
    .map((candidate) => `${candidate.command} (${describeBackend(candidate)})`);
  return `${selected.command} (${describeBackend(selected)}); ${selected.evidence}${
    fallbacks.length > 0 ? `; fallbacks: ${fallbacks.join(", ")}` : ""
  }`;
}
