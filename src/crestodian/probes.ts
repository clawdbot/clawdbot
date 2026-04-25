import { spawn } from "node:child_process";

export type LocalCommandProbe = {
  command: string;
  found: boolean;
  version?: string;
  error?: string;
};

export async function probeLocalCommand(
  command: string,
  args: string[] = ["--version"],
  opts: { timeoutMs?: number } = {},
): Promise<LocalCommandProbe> {
  const timeoutMs = opts.timeoutMs ?? 1_500;
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (result: LocalCommandProbe) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ command, found: true, error: `timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      finish({
        command,
        found: err.code !== "ENOENT",
        error: err.code === "ENOENT" ? "not found" : err.message,
      });
    });
    child.on("close", (code) => {
      const text = `${stdout}\n${stderr}`.trim().split(/\r?\n/)[0]?.trim();
      finish({
        command,
        found: code === 0 || Boolean(text),
        version: text || undefined,
        error: code === 0 ? undefined : `exited ${String(code)}`,
      });
    });
  });
}

export async function probeGatewayUrl(
  url: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ reachable: boolean; url: string; error?: string }> {
  const httpUrl = url.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
  const healthUrl = new URL("/healthz", httpUrl).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 900);
  try {
    const response = await fetch(healthUrl, {
      method: "GET",
      signal: controller.signal,
    });
    return { reachable: response.ok, url, error: response.ok ? undefined : response.statusText };
  } catch (err) {
    return {
      reachable: false,
      url,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}
