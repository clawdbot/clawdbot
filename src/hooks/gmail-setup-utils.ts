import fs from "node:fs";
import path from "node:path";

import { hasBinary } from "../agents/skills.js";
import { runCommandWithTimeout, type SpawnResult } from "../process/exec.js";
import { resolveUserPath } from "../utils.js";
import { normalizeServePath } from "./gmail.js";

let cachedPythonPath: string | null | undefined;
const MAX_OUTPUT_CHARS = 800;

function trimOutput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length <= MAX_OUTPUT_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_OUTPUT_CHARS)}…`;
}

function formatCommandFailure(command: string, result: SpawnResult): string {
  const code = result.code ?? "null";
  const signal = result.signal ? `, signal=${result.signal}` : "";
  const killed = result.killed ? ", killed=true" : "";
  const stderr = trimOutput(result.stderr);
  const stdout = trimOutput(result.stdout);
  const lines = [`${command} failed (code=${code}${signal}${killed})`];
  if (stderr) lines.push(`stderr: ${stderr}`);
  if (stdout) lines.push(`stdout: ${stdout}`);
  return lines.join("\n");
}

function formatCommandResult(command: string, result: SpawnResult): string {
  const code = result.code ?? "null";
  const signal = result.signal ? `, signal=${result.signal}` : "";
  const killed = result.killed ? ", killed=true" : "";
  const stderr = trimOutput(result.stderr);
  const stdout = trimOutput(result.stdout);
  const lines = [`${command} exited (code=${code}${signal}${killed})`];
  if (stderr) lines.push(`stderr: ${stderr}`);
  if (stdout) lines.push(`stdout: ${stdout}`);
  return lines.join("\n");
}

function formatJsonParseFailure(
  command: string,
  result: SpawnResult,
  err: unknown,
): string {
  const reason = err instanceof Error ? err.message : String(err);
  return `${command} returned invalid JSON: ${reason}\n${formatCommandResult(
    command,
    result,
  )}`;
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

function findExecutablesOnPath(bins: string[]): string[] {
  const pathEnv = process.env.PATH ?? "";
  const parts = pathEnv.split(path.delimiter).filter(Boolean);
  const seen = new Set<string>();
  const matches: string[] = [];
  for (const part of parts) {
    for (const bin of bins) {
      const candidate = path.join(part, bin);
      if (seen.has(candidate)) continue;
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        matches.push(candidate);
        seen.add(candidate);
      } catch {
        // keep scanning
      }
    }
  }
  return matches;
}

function ensurePathIncludes(dirPath: string, position: "append" | "prepend") {
  const pathEnv = process.env.PATH ?? "";
  const parts = pathEnv.split(path.delimiter).filter(Boolean);
  if (parts.includes(dirPath)) return;
  const next =
    position === "prepend" ? [dirPath, ...parts] : [...parts, dirPath];
  process.env.PATH = next.join(path.delimiter);
}

function ensureGcloudOnPath(): boolean {
  if (hasBinary("gcloud")) return true;
  const candidates = [
    "/opt/homebrew/share/google-cloud-sdk/bin/gcloud",
    "/usr/local/share/google-cloud-sdk/bin/gcloud",
    "/opt/homebrew/Caskroom/google-cloud-sdk/latest/google-cloud-sdk/bin/gcloud",
    "/usr/local/Caskroom/google-cloud-sdk/latest/google-cloud-sdk/bin/gcloud",
  ];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      ensurePathIncludes(path.dirname(candidate), "append");
      return true;
    } catch {
      // keep scanning
    }
  }
  return false;
}

export async function resolvePythonExecutablePath(): Promise<
  string | undefined
> {
  if (cachedPythonPath !== undefined) {
    return cachedPythonPath ?? undefined;
  }
  const candidates = findExecutablesOnPath(["python3", "python"]);
  for (const candidate of candidates) {
    const res = await runCommandWithTimeout(
      [
        candidate,
        "-c",
        "import os, sys; print(os.path.realpath(sys.executable))",
      ],
      { timeoutMs: 2_000 },
    );
    if (res.code !== 0) continue;
    const resolved = res.stdout.trim().split(/\s+/)[0];
    if (!resolved) continue;
    try {
      fs.accessSync(resolved, fs.constants.X_OK);
      cachedPythonPath = resolved;
      return resolved;
    } catch {
      // keep scanning
    }
  }
  cachedPythonPath = null;
  return undefined;
}

async function gcloudEnv(): Promise<NodeJS.ProcessEnv | undefined> {
  if (process.env.CLOUDSDK_PYTHON) return undefined;
  const pythonPath = await resolvePythonExecutablePath();
  if (!pythonPath) return undefined;
  return { CLOUDSDK_PYTHON: pythonPath };
}

async function runGcloudCommand(
  args: string[],
  timeoutMs: number,
): Promise<Awaited<ReturnType<typeof runCommandWithTimeout>>> {
  return await runCommandWithTimeout(["gcloud", ...args], {
    timeoutMs,
    env: await gcloudEnv(),
  });
}

export async function ensureDependency(bin: string, brewArgs: string[]) {
  if (bin === "gcloud" && ensureGcloudOnPath()) return;
  if (hasBinary(bin)) return;
  if (process.platform !== "darwin") {
    throw new Error(`${bin} not installed; install it and retry`);
  }
  if (!hasBinary("brew")) {
    throw new Error("Homebrew not installed (install brew and retry)");
  }
  const brewEnv = bin === "gcloud" ? await gcloudEnv() : undefined;
  const result = await runCommandWithTimeout(["brew", "install", ...brewArgs], {
    timeoutMs: 600_000,
    env: brewEnv,
  });
  if (result.code !== 0) {
    throw new Error(
      `brew install failed for ${bin}: ${result.stderr || result.stdout}`,
    );
  }
  if (!hasBinary(bin)) {
    throw new Error(`${bin} still not available after brew install`);
  }
}

export async function ensureGcloudAuth() {
  const res = await runGcloudCommand(
    ["auth", "list", "--filter", "status:ACTIVE", "--format", "value(account)"],
    30_000,
  );
  if (res.code === 0 && res.stdout.trim()) return;
  const login = await runGcloudCommand(["auth", "login"], 600_000);
  if (login.code !== 0) {
    throw new Error(login.stderr || "gcloud auth login failed");
  }
}

export async function runGcloud(args: string[]) {
  const result = await runGcloudCommand(args, 120_000);
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "gcloud command failed");
  }
  return result;
}

export async function ensureTopic(projectId: string, topicName: string) {
  const describe = await runGcloudCommand(
    ["pubsub", "topics", "describe", topicName, "--project", projectId],
    30_000,
  );
  if (describe.code === 0) return;
  await runGcloud([
    "pubsub",
    "topics",
    "create",
    topicName,
    "--project",
    projectId,
  ]);
}

export async function ensureSubscription(
  projectId: string,
  subscription: string,
  topicName: string,
  pushEndpoint: string,
) {
  const describe = await runGcloudCommand(
    [
      "pubsub",
      "subscriptions",
      "describe",
      subscription,
      "--project",
      projectId,
    ],
    30_000,
  );
  if (describe.code === 0) {
    await runGcloud([
      "pubsub",
      "subscriptions",
      "update",
      subscription,
      "--project",
      projectId,
      "--push-endpoint",
      pushEndpoint,
    ]);
    return;
  }
  await runGcloud([
    "pubsub",
    "subscriptions",
    "create",
    subscription,
    "--project",
    projectId,
    "--topic",
    topicName,
    "--push-endpoint",
    pushEndpoint,
  ]);
}

export async function ensureTailscaleEndpoint(params: {
  mode: "off" | "serve" | "funnel";
  path: string;
  port?: number;
  target?: string;
  token?: string;
}): Promise<string> {
  if (params.mode === "off") return "";

  const statusArgs = ["status", "--json"];
  const statusCommand = formatCommand("tailscale", statusArgs);
  const status = await runCommandWithTimeout(["tailscale", ...statusArgs], {
    timeoutMs: 30_000,
  });
  if (status.code !== 0) {
    throw new Error(formatCommandFailure(statusCommand, status));
  }
  let parsed: { Self?: { DNSName?: string } };
  try {
    parsed = JSON.parse(status.stdout) as { Self?: { DNSName?: string } };
  } catch (err) {
    throw new Error(formatJsonParseFailure(statusCommand, status, err));
  }
  const dnsName = parsed.Self?.DNSName?.replace(/\.$/, "");
  if (!dnsName) {
    throw new Error("tailscale DNS name missing; run tailscale up");
  }

  const target =
    typeof params.target === "string" && params.target.trim().length > 0
      ? params.target.trim()
      : params.port
        ? String(params.port)
        : "";
  if (!target) {
    throw new Error("tailscale target missing; set a port or target URL");
  }
  const pathArg = normalizeServePath(params.path);
  const funnelArgs = [
    params.mode,
    "--bg",
    "--set-path",
    pathArg,
    "--yes",
    target,
  ];
  const funnelCommand = formatCommand("tailscale", funnelArgs);
  const funnelResult = await runCommandWithTimeout(
    ["tailscale", ...funnelArgs],
    {
      timeoutMs: 30_000,
    },
  );
  if (funnelResult.code !== 0) {
    throw new Error(formatCommandFailure(funnelCommand, funnelResult));
  }

  const baseUrl = `https://${dnsName}${pathArg}`;
  // Funnel/serve strips pathArg before proxying; keep it only in the public URL.
  return params.token ? `${baseUrl}?token=${params.token}` : baseUrl;
}

export async function resolveProjectIdFromGogCredentials(): Promise<
  string | null
> {
  const candidates = gogCredentialsPaths();
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const raw = fs.readFileSync(candidate, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const clientId = extractGogClientId(parsed);
      const projectNumber = extractProjectNumber(clientId);
      if (!projectNumber) continue;
      const res = await runGcloudCommand(
        [
          "projects",
          "list",
          "--filter",
          `projectNumber=${projectNumber}`,
          "--format",
          "value(projectId)",
        ],
        30_000,
      );
      if (res.code !== 0) continue;
      const projectId = res.stdout.trim().split(/\s+/)[0];
      if (projectId) return projectId;
    } catch {
      // keep scanning
    }
  }
  return null;
}

function gogCredentialsPaths(): string[] {
  const paths: string[] = [];
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) {
    paths.push(path.join(xdg, "gogcli", "credentials.json"));
  }
  paths.push(resolveUserPath("~/.config/gogcli/credentials.json"));
  if (process.platform === "darwin") {
    paths.push(
      resolveUserPath("~/Library/Application Support/gogcli/credentials.json"),
    );
  }
  return paths;
}

function extractGogClientId(parsed: Record<string, unknown>): string | null {
  const installed = parsed.installed as Record<string, unknown> | undefined;
  const web = parsed.web as Record<string, unknown> | undefined;
  const candidate =
    installed?.client_id || web?.client_id || parsed.client_id || "";
  return typeof candidate === "string" ? candidate : null;
}

function extractProjectNumber(clientId: string | null): string | null {
  if (!clientId) return null;
  const match = clientId.match(/^(\d+)-/);
  return match?.[1] ?? null;
}
