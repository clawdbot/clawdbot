// Qa Lab plugin module owns sanitized gateway debug artifacts and temp cleanup.
import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { ensureRepoBoundDirectory } from "./cli-paths.js";
import { redactQaGatewayDebugText } from "./gateway-log-redaction.js";

async function writeSanitizedQaGatewayDebugLog(params: { sourcePath: string; targetPath: string }) {
  const contents = await fs.readFile(params.sourcePath, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  });
  await fs.writeFile(params.targetPath, redactQaGatewayDebugText(contents), "utf8");
}

async function clearQaGatewayArtifactDir(dir: string) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    await fs.rm(path.join(dir, entry.name), { recursive: true, force: true });
  }
}

export async function cleanupQaGatewayTempRoots(params: {
  tempRoot: string;
  stagedBundledPluginsRoot?: string | null;
}) {
  const errors: Error[] = [];
  for (const [label, root] of [
    ["tempRoot", params.tempRoot],
    ["stagedBundledPluginsRoot", params.stagedBundledPluginsRoot],
  ] as const) {
    if (!root) {
      continue;
    }
    try {
      await fs.rm(root, { recursive: true, force: true });
    } catch (error) {
      // Attempt both roots; retain only bounded, redacted diagnostics, since raw
      // filesystem errors can expose credentials in paths or nested causes.
      const details = sliceUtf16Safe(redactQaGatewayDebugText(formatErrorMessage(error)), 0, 2_048);
      errors.push(new Error(`${label}: ${details}`));
    }
  }
  if (errors.length) {
    throw new AggregateError(
      errors,
      `qa gateway temp-root cleanup failed: ${errors.map((error) => error.message).join("; ")}`,
    );
  }
}

export async function preserveQaGatewayDebugArtifacts(params: {
  preserveToDir: string;
  stdoutLogPath: string;
  stderrLogPath: string;
  tempRoot: string;
  repoRoot?: string;
}) {
  const preserveToDir = params.repoRoot
    ? await ensureRepoBoundDirectory(
        params.repoRoot,
        params.preserveToDir,
        "QA gateway artifact directory",
        {
          mode: 0o700,
        },
      )
    : params.preserveToDir;
  await fs.mkdir(preserveToDir, { recursive: true, mode: 0o700 });
  await clearQaGatewayArtifactDir(preserveToDir);
  await Promise.all([
    writeSanitizedQaGatewayDebugLog({
      sourcePath: params.stdoutLogPath,
      targetPath: path.join(preserveToDir, "gateway.stdout.log"),
    }),
    writeSanitizedQaGatewayDebugLog({
      sourcePath: params.stderrLogPath,
      targetPath: path.join(preserveToDir, "gateway.stderr.log"),
    }),
  ]);
  await fs.writeFile(
    path.join(preserveToDir, "README.txt"),
    [
      "Only sanitized gateway debug artifacts are preserved here.",
      "The full QA gateway runtime was not copied because it may contain credentials or auth tokens.",
      "Original runtime temp root omitted because local temp paths can identify the runner.",
      "",
    ].join("\n"),
    "utf8",
  );
}
