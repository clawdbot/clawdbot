import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";

const execFileAsync = promisify(execFile);

export type CronListCliResult = {
  jobs?: Array<{
    id?: string;
    name?: string;
    sessionTarget?: string;
    agentId?: string | null;
    sessionKey?: string | null;
    payload?: { kind?: string; text?: string; message?: string };
  }>;
};

export type CronListJob = NonNullable<CronListCliResult["jobs"]>[number];

export type LiveCronProbeSpec = {
  nonce: string;
  name: string;
  message: string;
  at: string;
  argsJson: string;
};

export function isClaudeLikeLiveAgent(raw: string): boolean {
  const normalized = normalizeOptionalLowercaseString(raw);
  return normalized === "claude" || normalized === "claude-cli";
}

export function assertLiveImageProbeReply(text: string): void {
  const normalized = normalizeOptionalLowercaseString(text);
  if (normalized !== "cat" && !/(^|[^a-z])cat[.!?`'")\]]*$/.test(normalized ?? "")) {
    throw new Error(`image probe expected 'cat', got: ${normalized}`);
  }
}

export function createLiveCronProbeSpec(
  params: {
    agentId?: string;
    sessionKey?: string;
  } = {},
): LiveCronProbeSpec {
  const nonce = randomBytes(3).toString("hex").toUpperCase();
  const normalizedNonce = normalizeOptionalLowercaseString(nonce) ?? "";
  const name = `live-mcp-${normalizedNonce}`;
  const message = `probe-${normalizedNonce}`;
  const at = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const argsJson = JSON.stringify({
    action: "add",
    job: {
      name,
      schedule: { kind: "at", at },
      payload: { kind: "agentTurn", message },
      sessionTarget: params.sessionKey ? `session:${params.sessionKey}` : "current",
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      enabled: true,
    },
  });
  return { nonce, name, message, at, argsJson };
}

export function buildLiveCronProbeMessage(params: {
  agent: string;
  argsJson: string;
  attempt: number;
  exactReply: string;
}): string {
  const claudeLike = isClaudeLikeLiveAgent(params.agent);
  if (params.attempt === 0) {
    return (
      "Use the OpenClaw MCP tool `openclaw-tools/cron` (server `openclaw-tools`, tool `cron`). " +
      `Call it with JSON arguments ${params.argsJson}. ` +
      "Preserve the JSON exactly, including job.sessionTarget and job.sessionKey; do not omit, rename, or flatten those fields. " +
      "Do the actual tool call; I will verify externally with the OpenClaw cron CLI. " +
      `After the cron job is created, reply exactly: ${params.exactReply}`
    );
  }
  if (claudeLike) {
    return (
      "Retry the OpenClaw MCP tool `openclaw-tools/cron` now. " +
      `Use these exact JSON arguments: ${params.argsJson}. ` +
      "Preserve job.sessionTarget and job.sessionKey exactly as provided. " +
      `If the cron job is created, reply exactly: ${params.exactReply}. ` +
      "If the tool call is cancelled, the job is not created, or you cannot confirm creation, " +
      "reply briefly saying that and ask me to retry. No markdown. " +
      "I will verify externally with the OpenClaw cron CLI."
    );
  }
  return (
    "Your previous OpenClaw cron MCP tool call was cancelled before the job was created. " +
    "Retry the OpenClaw MCP tool `openclaw-tools/cron` now. " +
    `Use these exact JSON arguments: ${params.argsJson}. ` +
    "Preserve job.sessionTarget and job.sessionKey exactly as provided. " +
    `If the cron job is created, reply exactly: ${params.exactReply}. ` +
    "If the tool call is cancelled, the job is not created, or you cannot confirm creation, " +
    "reply briefly saying that and ask me to retry. No markdown. " +
    "I will verify externally with the OpenClaw cron CLI."
  );
}

export async function runOpenClawCliJson<T>(args: string[], env: NodeJS.ProcessEnv): Promise<T> {
  const childEnv = { ...env };
  delete childEnv.VITEST;
  delete childEnv.VITEST_MODE;
  delete childEnv.VITEST_POOL_ID;
  delete childEnv.VITEST_WORKER_ID;
  const { stdout, stderr } = await execFileAsync(process.execPath, ["openclaw.mjs", ...args], {
    cwd: process.cwd(),
    env: childEnv,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(
      [
        `openclaw ${args.join(" ")} produced no JSON stdout`,
        stderr.trim() ? `stderr: ${stderr.trim()}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch (error) {
    throw new Error(
      [
        `openclaw ${args.join(" ")} returned invalid JSON`,
        `stdout: ${trimmed}`,
        stderr.trim() ? `stderr: ${stderr.trim()}` : undefined,
        error instanceof Error ? `cause: ${error.message}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
      { cause: error },
    );
  }
}

export async function assertCronJobVisibleViaCli(params: {
  port: number;
  token: string;
  env: NodeJS.ProcessEnv;
  expectedName: string;
  expectedMessage: string;
}): Promise<CronListJob | undefined> {
  const cronList = await runOpenClawCliJson<CronListCliResult>(
    [
      "cron",
      "list",
      "--all",
      "--json",
      "--url",
      `ws://127.0.0.1:${params.port}`,
      "--token",
      params.token,
    ],
    params.env,
  );
  return (
    cronList.jobs?.find((job) => job.name === params.expectedName) ??
    cronList.jobs?.find((job) => job.payload?.message === params.expectedMessage)
  );
}

export function assertCronJobMatches(params: {
  job: CronListJob;
  expectedName: string;
  expectedMessage: string;
  expectedSessionKey: string;
  expectedAgentId?: string;
}) {
  if (params.job.name !== params.expectedName) {
    throw new Error(`cron job name mismatch: ${params.job.name ?? "<missing>"}`);
  }
  if (params.job.payload?.kind !== "agentTurn") {
    throw new Error(`cron payload kind mismatch: ${params.job.payload?.kind ?? "<missing>"}`);
  }
  if (params.job.payload?.message !== params.expectedMessage) {
    throw new Error(`cron payload message mismatch: ${params.job.payload?.message ?? "<missing>"}`);
  }
  const expectedAgentId = params.expectedAgentId ?? "dev";
  if (params.job.agentId !== expectedAgentId) {
    throw new Error(`cron agentId mismatch: ${params.job.agentId ?? "<missing>"}`);
  }
  if (params.job.sessionKey !== params.expectedSessionKey) {
    throw new Error(`cron sessionKey mismatch: ${params.job.sessionKey ?? "<missing>"}`);
  }
  if (params.job.sessionTarget !== `session:${params.expectedSessionKey}`) {
    throw new Error(`cron sessionTarget mismatch: ${params.job.sessionTarget ?? "<missing>"}`);
  }
}
