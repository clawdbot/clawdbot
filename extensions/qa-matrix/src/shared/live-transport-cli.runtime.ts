import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { resolveRepoRelativeOutputDir } from "../cli-paths.js";
import type { QaProviderMode } from "../run-config.js";
import { normalizeQaProviderMode } from "../run-config.js";
import type { LiveTransportQaCommandOptions } from "./live-transport-cli.js";

export function resolveLiveTransportQaRunOptions(
  opts: LiveTransportQaCommandOptions,
): LiveTransportQaCommandOptions & {
  outputDir: string;
  repoRoot: string;
  providerMode: QaProviderMode;
} {
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  const outputDir =
    resolveRepoRelativeOutputDir(repoRoot, opts.outputDir) ??
    path.join(repoRoot, ".artifacts", "qa-e2e", `matrix-${Date.now().toString(36)}`);
  return {
    repoRoot,
    outputDir,
    providerMode:
      opts.providerMode === undefined
        ? "live-frontier"
        : normalizeQaProviderMode(opts.providerMode),
    primaryModel: opts.primaryModel,
    alternateModel: opts.alternateModel,
    fastMode: opts.fastMode,
    scenarioIds: opts.scenarioIds,
    sutAccountId: opts.sutAccountId,
    credentialSource: opts.credentialSource?.trim(),
    credentialRole: opts.credentialRole?.trim(),
  };
}

export function printLiveTransportQaArtifacts(
  laneLabel: string,
  artifacts: Record<string, string>,
) {
  for (const [label, filePath] of Object.entries(artifacts)) {
    process.stdout.write(`${laneLabel} ${label}: ${filePath}\n`);
  }
}

type ProcessWriteCallback = (err?: Error | null) => void;

export async function startLiveTransportQaOutputTee(params: {
  fileName: string;
  outputDir: string;
}) {
  await fsp.mkdir(params.outputDir, { recursive: true });
  const outputPath = path.join(params.outputDir, params.fileName);
  const output = fs.createWriteStream(outputPath, {
    encoding: "utf8",
    flags: "a",
    mode: 0o600,
  });
  let outputError: Error | null = null;
  output.on("error", (error) => {
    outputError ??= error;
  });
  const originalStdoutWrite = Reflect.get(process.stdout, "write");
  const originalStderrWrite = Reflect.get(process.stderr, "write");
  const boundStdoutWrite = originalStdoutWrite.bind(process.stdout);
  const boundStderrWrite = originalStderrWrite.bind(process.stderr);
  let stopped = false;

  const tee = (originalWrite: typeof process.stdout.write) =>
    function writeWithTee(
      this: NodeJS.WriteStream,
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ProcessWriteCallback,
      callback?: ProcessWriteCallback,
    ) {
      if (!stopped && !outputError) {
        output.write(chunk);
      }
      return Reflect.apply(originalWrite, this, [chunk, encodingOrCallback, callback]) as boolean;
    };

  process.stdout.write = tee(boundStdoutWrite) as typeof process.stdout.write;
  process.stderr.write = tee(boundStderrWrite) as typeof process.stderr.write;

  return {
    outputPath,
    async stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
      if (outputError) {
        throw outputError;
      }
      await new Promise<void>((resolve, reject) => {
        output.once("error", reject);
        output.end(resolve);
      });
      if (outputError) {
        throw outputError;
      }
    },
  };
}
