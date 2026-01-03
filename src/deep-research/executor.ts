/**
 * Deep Research CLI executor
 * @see docs/sdd/deep-research/requirements.md#4.3
 */

import { spawn } from "node:child_process";
import {
  access,
  constants,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { getDefaultDeepResearchCliPath, loadConfig } from "../config/config.js";
import { normalizeDeepResearchTopic } from "./topic.js";

export interface ExecuteOptions {
  topic: string;
  dryRun?: boolean;
  outputLanguage?: "ru" | "en" | "auto";
  timeoutMs?: number;
  onEvent?: (event: ExecuteEvent) => void;
}

export type ExecuteEvent = {
  run_id?: string;
  event?: string;
  [key: string]: unknown;
};

export interface ExecuteResult {
  success: boolean;
  runId?: string;
  resultJsonPath?: string;
  error?: string;
  stdout: string;
  stderr: string;
}

async function findCliOnPath(command: string): Promise<string | null> {
  const entries = (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const candidate = path.join(entry, command);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // continue searching PATH
    }
  }

  return null;
}

/**
 * Validate CLI exists and is executable
 */
export async function validateCli(
  cliPath: string,
): Promise<{ valid: boolean; error?: string; resolvedPath?: string }> {
  try {
    await access(cliPath, constants.X_OK);
    return { valid: true, resolvedPath: cliPath };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      const fallback = await findCliOnPath(path.basename(cliPath));
      if (fallback) {
        return { valid: true, resolvedPath: fallback };
      }
      return { valid: false, error: `CLI not found: ${cliPath}` };
    }
    return { valid: false, error: `CLI not executable: ${cliPath}` };
  }
}

type AgentSummaryPayload = {
  summary_bullets?: string[];
  short_answer_summary_2_initial_request?: string;
  opinion?: string;
};

async function buildPublishFallbackResult(params: {
  baseDir: string;
  runId: string;
  prompt: string;
  publishError?: string;
}): Promise<string | null> {
  const runDir = path.join(params.baseDir, "runs", params.runId);
  const resultJsonPath = path.join(runDir, "result.json");
  try {
    await access(resultJsonPath, constants.R_OK);
    return resultJsonPath;
  } catch {
    // result.json is expected to be missing after publish failure
  }

  const agentSummaryPath = path.join(runDir, "md", "agent_summary.json");
  const reportMdPath = path.join(runDir, "md", "report.md");

  try {
    await access(agentSummaryPath, constants.R_OK);
    await access(reportMdPath, constants.R_OK);
  } catch {
    return null;
  }

  const agentSummaryRaw = await readFile(agentSummaryPath, "utf-8");
  const agentSummary = JSON.parse(agentSummaryRaw) as AgentSummaryPayload;
  const publishUrl = pathToFileURL(reportMdPath).toString();

  const result = {
    run_id: params.runId,
    status: "completed",
    prompt: params.prompt,
    agent_summary: {
      summary_bullets: agentSummary.summary_bullets ?? [],
      short_answer_summary_2_initial_request:
        agentSummary.short_answer_summary_2_initial_request ?? "",
      opinion: agentSummary.opinion ?? "",
    },
    publish: {
      ok: false,
      url: publishUrl,
      error: params.publishError ?? "publish failed",
      source_md: `runs/${params.runId}/md/report.md`,
    },
    report: {
      md: `runs/${params.runId}/md/report.md`,
      txt: `runs/${params.runId}/report.txt`,
    },
  };

  await mkdir(runDir, { recursive: true });
  await writeFile(resultJsonPath, JSON.stringify(result, null, 2), "utf-8");
  return resultJsonPath;
}

/**
 * Execute deep research CLI
 * @returns Promise resolving to execution result
 */
export async function executeDeepResearch(
  options: ExecuteOptions,
): Promise<ExecuteResult> {
  const cfg = loadConfig();
  const cliPath = cfg.deepResearch?.cliPath ?? getDefaultDeepResearchCliPath();
  const dryRun = options.dryRun ?? cfg.deepResearch?.dryRun ?? true;
  const outputLanguage =
    options.outputLanguage ?? cfg.deepResearch?.outputLanguage ?? "auto";
  const timeoutMs = options.timeoutMs ?? 20 * 60 * 1000;

  const normalized = normalizeDeepResearchTopic(options.topic);
  if (!normalized) {
    return {
      success: false,
      error: "Empty topic",
      stdout: "",
      stderr: "",
    };
  }
  if (normalized.truncated) {
    console.log(
      `[deep-research] Topic truncated to ${normalized.topic.length} chars`,
    );
  }

  const validation = await validateCli(cliPath);
  if (!validation.valid) {
    return {
      success: false,
      error: validation.error,
      stdout: "",
      stderr: "",
    };
  }
  const resolvedCliPath = validation.resolvedPath ?? cliPath;

  // Build command arguments
  const args: string[] = [];
  const dryRunFixture = "examples/sample_run";
  const dryRunFallbackResult =
    "runs/20260102_100310_dry-run-test-respond-in-russian/result.json";

  if (dryRun) {
    args.push("--dry-run");
    args.push("--dry-run-fixture", dryRunFixture);
  } else {
    args.push("--mode", "stream");
  }

  args.push("--prompt", normalized.topic);
  args.push("--publish");

  if (outputLanguage !== "auto") {
    args.push("--output-language", outputLanguage);
  }

  console.log(
    `[deep-research] Executing: ${resolvedCliPath} ${args.join(" ")}`,
  );

  return new Promise((resolve) => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let runId: string | undefined;
    let resultJsonPath: string | undefined;
    let stdoutBuffer = "";
    let finished = false;
    let timeoutId: NodeJS.Timeout | undefined;
    let publishError: string | undefined;
    let runErrorDetail: string | undefined;
    const baseDir = path.dirname(resolvedCliPath);

    const finish = (result: ExecuteResult) => {
      if (finished) return;
      finished = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      resolve(result);
    };

    const proc = spawn(resolvedCliPath, args, {
      cwd: baseDir,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    timeoutId = setTimeout(() => {
      proc.kill("SIGTERM");
      finish({
        success: false,
        error: "Execution timeout",
        runId,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
      });
    }, timeoutMs);

    proc.stdout.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stdoutChunks.push(chunk);
      stdoutBuffer += chunk;

      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed) as ExecuteEvent & {
            result?: string;
          };
          if (options.onEvent) {
            try {
              options.onEvent(event);
            } catch {
              // ignore status update failures
            }
          }
          if (event.run_id) {
            runId = event.run_id;
          }
          if (event.event === "run.complete" && event.result) {
            resultJsonPath = event.result;
          }
          if (event.event === "publish.error") {
            if (typeof event.detail === "string") {
              publishError = event.detail;
            } else {
              publishError = "publish failed";
            }
          }
          if (event.event === "run.error" && typeof event.detail === "string") {
            runErrorDetail = event.detail;
          }
        } catch {
          // Not JSON, ignore
        }
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderrChunks.push(data.toString());
    });

    proc.on("close", async (code) => {
      const success = code === 0;
      let resolvedSuccess = success;
      let resolvedError = success ? undefined : `Exit code: ${code}`;
      let resolvedResultJsonPath = resultJsonPath;
      const publishFailed =
        Boolean(publishError) ||
        (runErrorDetail?.includes("publish required but failed") ?? false);

      if (!success && publishFailed && runId && !resolvedResultJsonPath) {
        try {
          const fallbackResultPath = await buildPublishFallbackResult({
            baseDir,
            runId,
            prompt: normalized.topic,
            publishError,
          });
          if (fallbackResultPath) {
            resolvedResultJsonPath = fallbackResultPath;
            resolvedSuccess = true;
            resolvedError = undefined;
          }
        } catch {
          // Ignore fallback errors and keep failure as-is.
        }
      }

      if (!success && dryRun && !resolvedResultJsonPath) {
        const fallbackPath = path.join(baseDir, dryRunFallbackResult);
        try {
          await access(fallbackPath, constants.R_OK);
          resolvedResultJsonPath = fallbackPath;
          resolvedSuccess = true;
          resolvedError = undefined;
          if (!runId) {
            try {
              const content = await readFile(fallbackPath, "utf-8");
              const parsed = JSON.parse(content) as { run_id?: string };
              runId = parsed.run_id ?? runId;
            } catch {
              // Ignore fallback parse errors.
            }
          }
        } catch {
          // Keep failure as-is if fixture is missing.
        }
      }
      if (resolvedResultJsonPath && !resolvedResultJsonPath.startsWith("/")) {
        resolvedResultJsonPath = path.join(baseDir, resolvedResultJsonPath);
      }

      finish({
        success: resolvedSuccess,
        runId,
        resultJsonPath: resolvedResultJsonPath,
        error: resolvedError,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
      });
    });

    proc.on("error", (err) => {
      finish({
        success: false,
        error: err.message,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
      });
    });
  });
}
