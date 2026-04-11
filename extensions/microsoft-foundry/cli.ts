import { execFile, execFileSync, spawn } from "node:child_process";
import {
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
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
  return normalized.slice(0, 300);
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

export async function execAzAsync(args: string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile(
      "az",
      args,
      {
        encoding: "utf-8",
        timeout: 30_000,
        shell: process.platform === "win32",
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(buildAzCommandError(error, stderr ?? "", stdout ?? ""));
          return;
        }
        resolve(normalizeStringifiedOptionalString(stdout) ?? "");
      },
    );
  });
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
    return JSON.parse(execAz(["account", "show", "--output", "json"])) as AzAccount;
  } catch {
    return null;
  }
}

export function listSubscriptions(): AzAccount[] {
  try {
    const subs = JSON.parse(
      execAz(["account", "list", "--output", "json", "--all"]),
    ) as AzAccount[];
    return subs.filter((sub) => sub.state === "Enabled");
  } catch {
    return [];
  }
}

type AccessTokenParams = {
  subscriptionId?: string;
  tenantId?: string;
};

function buildAccessTokenArgs(params?: AccessTokenParams): string[] {
  const args = [
    "account",
    "get-access-token",
    "--resource",
    COGNITIVE_SERVICES_RESOURCE,
    "--output",
    "json",
  ];
  if (params?.subscriptionId) {
    args.push("--subscription", params.subscriptionId);
  } else if (params?.tenantId) {
    args.push("--tenant", params.tenantId);
  }
  return args;
}

export function getAccessTokenResult(params?: AccessTokenParams): AzAccessToken {
  return JSON.parse(execAz(buildAccessTokenArgs(params))) as AzAccessToken;
}

export async function getAccessTokenResultAsync(
  params?: AccessTokenParams,
): Promise<AzAccessToken> {
  return JSON.parse(await execAzAsync(buildAccessTokenArgs(params))) as AzAccessToken;
}

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
    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      stdoutLen = appendBoundedChunk(stdoutChunks, text, stdoutLen);
      process.stdout.write(text);
    });
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      stderrLen = appendBoundedChunk(stderrChunks, text, stderrLen);
      process.stderr.write(text);
    });
    child.on("close", (code) => {
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
    child.on("error", reject);
  });
}
