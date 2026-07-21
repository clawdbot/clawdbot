// Microsoft Foundry plugin module implements cli behavior.
import { execFileSync, spawn } from "node:child_process";
import { runExec } from "openclaw/plugin-sdk/process-runtime";
import {
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { AzAccessToken, AzAccount } from "./shared.js";
import { COGNITIVE_SERVICES_RESOURCE } from "./shared.js";

function summarizeAzErrorMessage(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  const normalized = trimmed.replace(/\s+/g, " ");
  if (/not recognized|enoent|spawn .* az/i.test(normalized)) {
    return "Azure CLI (az) is not installed or not on PATH.";
  }
  if (/az login/i.test(normalized) || /please run 'az login'/i.test(normalized)) {
    return "Azure CLI is not logged in. Run `az login --use-device-code`.";
  }
  if (
    /subscription/i.test(normalized) &&
    /could not be found|does not exist|no subscriptions/i.test(normalized)
  ) {
    return "Azure CLI could not find an accessible subscription. Check the selected subscription or tenant access.";
  }
  if (
    /tenant/i.test(normalized) &&
    /not found|invalid|doesn't exist|does not exist/i.test(normalized)
  ) {
    return "Azure CLI could not use that tenant. Verify the tenant ID or tenant domain and try `az login --tenant <tenant>`.";
  }
  if (/aadsts\d+/i.test(normalized)) {
    return "Azure login failed for the selected tenant. Re-run `az login --use-device-code` and confirm the tenant is correct.";
  }
  return truncateUtf16Safe(normalized, 300);
}

function buildAzCommandError(error: Error, stderr: string, stdout: string): Error {
  const details = summarizeAzErrorMessage(`${stderr ?? ""} ${stdout ?? ""}`);
  return new Error(details ? `${error.message}: ${details}` : error.message);
}

export function execAz(args: string[]): string {
  return (
    normalizeOptionalString(
      execFileSync("az", args, {
        encoding: "utf-8",
        timeout: 30_000,
        shell: process.platform === "win32",
      }),
    ) ?? ""
  );
}

async function execAzAsync(args: string[]): Promise<string> {
  try {
    const { stdout } = await runExec("az", args, { logOutput: false, timeoutMs: 30_000 });
    return normalizeStringifiedOptionalString(stdout) ?? "";
  } catch (error) {
    const commandError = error instanceof Error ? error : new Error(String(error));
    const output = error as { stderr?: unknown; stdout?: unknown };
    throw buildAzCommandError(
      commandError,
      typeof output.stderr === "string" ? output.stderr : "",
      typeof output.stdout === "string" ? output.stdout : "",
    );
  }
}

export function isAzCliInstalled(): boolean {
  try {
    execAz(["version", "--output", "none"]);
    return true;
  } catch {
    return false;
  }
}

export function getLoggedInAccount(): AzAccount | null {
  try {
    return parseAzJson(execAz(["account", "show", "--output", "json"]), "account") as AzAccount;
  } catch {
    return null;
  }
}

export function listSubscriptions(): AzAccount[] {
  try {
    const subs = parseAzJson(
      execAz(["account", "list", "--output", "json", "--all"]),
      "subscriptions",
    ) as AzAccount[];
    return subs.filter((sub) => sub.state === "Enabled");
  } catch {
    return [];
  }
}

function parseAzJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Azure CLI returned malformed ${label} JSON.`);
  }
}

type AccessTokenParams = {
  scope?: string;
  subscriptionId?: string;
  tenantId?: string;
};

function buildAccessTokenArgs(params?: AccessTokenParams): string[] {
  const args = ["account", "get-access-token"];
  if (params?.scope) {
    args.push("--scope", params.scope);
  } else {
    args.push("--resource", COGNITIVE_SERVICES_RESOURCE);
  }
  args.push("--output", "json");
  if (params?.subscriptionId) {
    args.push("--subscription", params.subscriptionId);
  } else if (params?.tenantId) {
    args.push("--tenant", params.tenantId);
  }
  return args;
}

export function getAccessTokenResult(params?: AccessTokenParams): AzAccessToken {
  return parseAzJson(execAz(buildAccessTokenArgs(params)), "access token") as AzAccessToken;
}

export async function getAccessTokenResultAsync(
  params?: AccessTokenParams,
): Promise<AzAccessToken> {
  return parseAzJson(
    await execAzAsync(buildAccessTokenArgs(params)),
    "access token",
  ) as AzAccessToken;
}

const AZ_LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export async function azLoginDeviceCode(): Promise<void> {
  return azLoginDeviceCodeWithOptions({});
}

export async function azLoginDeviceCodeWithOptions(params: {
  tenantId?: string;
  allowNoSubscriptions?: boolean;
}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const maxCapturedLoginOutputChars = 8_000;
    const args = [
      "login",
      "--use-device-code",
      ...(params.tenantId ? ["--tenant", params.tenantId] : []),
      ...(params.allowNoSubscriptions ? ["--allow-no-subscriptions"] : []),
    ];
    const child = spawn("az", args, {
      stdio: ["inherit", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    let timedOut = false;
    const loginTimer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, AZ_LOGIN_TIMEOUT_MS);
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    const appendBoundedChunk = (chunks: string[], text: string, len: number): number => {
      if (!text) {
        return len;
      }
      chunks.push(text);
      let total = len + text.length;
      while (total > maxCapturedLoginOutputChars && chunks.length > 0) {
        const removed = chunks.shift();
        total -= removed?.length ?? 0;
      }
      return total;
    };
    // Decode pipes statefully so a multibyte UTF-8 code point split across
    // chunk boundaries does not become U+FFFD in terminal output / error text.
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      const text = chunk;
      stdoutLen = appendBoundedChunk(stdoutChunks, text, stdoutLen);
      process.stdout.write(text);
    });
    child.stderr?.on("data", (chunk: string) => {
      const text = chunk;
      stderrLen = appendBoundedChunk(stderrChunks, text, stderrLen);
      process.stderr.write(text);
    });
    child.on("close", (code) => {
      clearTimeout(loginTimer);
      if (timedOut) {
        reject(new Error("az login timed out after 5 minutes"));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      const output = normalizeOptionalString([...stderrChunks, ...stdoutChunks].join("")) ?? "";
      reject(
        new Error(
          output
            ? `az login exited with code ${code}: ${output}`
            : `az login exited with code ${code}`,
        ),
      );
    });
    child.on("error", (err) => {
      clearTimeout(loginTimer);
      reject(err);
    });
  });
}
