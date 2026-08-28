#!/usr/bin/env node

import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SECRET_FILE_MAX_BYTES, tryReadSecretFileSync } from "@openclaw/fs-safe/secret";
import { coerceErrorMessage as errorMessage } from "openclaw/plugin-sdk/error-runtime";
import { runCommandBuffered } from "openclaw/plugin-sdk/process-runtime";
import { resolveTrustedOnePasswordCli } from "./onepassword-op-path.js";
import { resolveOnePasswordSecretReference } from "./onepassword-secret-id.js";

const OP_READ_CONCURRENCY = 4;
const OP_READ_TIMEOUT_MS = 7_000;
const MAX_SECRET_REFS_PER_REQUEST = 32;
const MAX_SECRET_VALUE_BYTES = 64 * 1024;

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += String(chunk);
    });
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolve(input));
  });
}

function writeResponse(response) {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

function parseRequest(input) {
  const parsed = JSON.parse(input);
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.ids)) {
    throw new Error("invalid exec SecretRef request");
  }
  return {
    protocolVersion: 1,
    ids: parsed.ids.filter((id) => typeof id === "string" && id.length > 0),
  };
}

function resolveSecretReference(id) {
  return resolveOnePasswordSecretReference(id);
}

async function resolveOpCommand() {
  const command = process.env.CLAW_1PASSWORD_OP?.trim();
  if (command && !path.isAbsolute(command)) {
    throw new Error(`CLAW_1PASSWORD_OP must be an absolute path: ${command}`);
  }
  const resolved = await resolveTrustedOnePasswordCli({
    ...(command ? { configuredPath: command } : {}),
    pathEnv: process.env.PATH,
  });
  if (resolved) {
    return resolved;
  }
  throw new Error(
    "1Password CLI was not found. Install the official CLI or set CLAW_1PASSWORD_OP to its absolute path.",
  );
}

function opMissingMessage(command) {
  return `1Password CLI "${command}" is not installed or cannot be executed. Install the official 1Password CLI v2, and set CLAW_1PASSWORD_OP to its absolute path.`;
}

function resolveOsHome() {
  const home =
    process.platform === "win32"
      ? process.env.USERPROFILE?.trim() || process.env.HOME?.trim() || os.homedir()
      : process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || os.homedir();
  if (!home) {
    throw new Error("Unable to resolve the user home for the 1Password CLI.");
  }
  if (process.platform === "win32") {
    if (!path.win32.isAbsolute(home)) {
      throw new Error("The Windows user profile path for the 1Password CLI must be absolute.");
    }
    return path.win32.normalize(home);
  }
  return path.resolve(home);
}

function resolveOpenClawHome() {
  const explicit = process.env.OPENCLAW_HOME?.trim();
  if (!explicit) {
    return resolveOsHome();
  }
  if (explicit === "~" || explicit.startsWith("~/") || explicit.startsWith("~\\")) {
    return path.resolve(explicit.replace(/^~(?=$|[\\/])/u, () => resolveOsHome()));
  }
  return path.resolve(explicit);
}

function resolveStateDir() {
  const override = process.env.OPENCLAW_STATE_DIR?.trim();
  if (override) {
    if (override === "~" || override.startsWith("~/") || override.startsWith("~\\")) {
      return path.resolve(override.replace(/^~(?=$|[\\/])/u, () => resolveOpenClawHome()));
    }
    return path.resolve(override);
  }
  const home = resolveOpenClawHome();
  const profile = process.env.OPENCLAW_PROFILE?.trim();
  if (profile && profile.toLowerCase() !== "default") {
    // Keep the static resolver aligned with the root CLI profile contract without importing core.
    if (!/^[A-Za-z0-9_-]+$/u.test(profile)) {
      throw new Error("invalid OpenClaw profile name");
    }
    return path.join(home, `.openclaw-${profile}`);
  }
  const current = path.join(home, ".openclaw");
  const legacy = path.join(home, ".clawdbot");
  return fsSync.existsSync(current) || !fsSync.existsSync(legacy) ? current : legacy;
}

function readServiceAccountToken() {
  // Keep this child-process path aligned with the broker path in index.ts.
  // The resolver is a static asset and cannot import the plugin runtime.
  const tokenFile = path.join(
    resolveStateDir(),
    "credentials",
    "onepassword",
    "service-account-token",
  );
  try {
    const token = tryReadSecretFileSync(tokenFile, "1Password service account token", {
      maxBytes: DEFAULT_SECRET_FILE_MAX_BYTES,
      rejectHardlinks: false,
      rejectSymlink: true,
    });
    if (!token) {
      throw new Error("missing token file");
    }
    return token;
  } catch {
    throw new Error(
      "1Password service account token file is missing, empty, unsafe, or too large. Configure the onepassword plugin token file first.",
    );
  }
}

function opEnvironment(token) {
  // The managed resolver is non-interactive. Never let a host desktop integration turn a
  // Gateway secret read into an authorization or macOS App Data prompt.
  const home = resolveOsHome();
  const env = {
    HOME: home,
    OP_SERVICE_ACCOUNT_TOKEN: token,
    OP_BIOMETRIC_UNLOCK_ENABLED: "false",
    OP_LOAD_DESKTOP_APP_SETTINGS: "false",
  };
  if (process.platform !== "win32") {
    return env;
  }
  const readWindowsDirectory = (name, fallback) => {
    const value = process.env[name]?.trim() || fallback;
    if (!path.win32.isAbsolute(value)) {
      throw new Error(`The Windows ${name} path for the 1Password CLI must be absolute.`);
    }
    return path.win32.normalize(value);
  };
  const profileRoot = path.win32.parse(home).root;
  const localAppData = readWindowsDirectory(
    "LOCALAPPDATA",
    path.win32.join(home, "AppData", "Local"),
  );
  return {
    ...env,
    USERPROFILE: home,
    HOMEDRIVE: profileRoot.replace(/[\\/]$/u, ""),
    HOMEPATH: home.slice(Math.max(0, profileRoot.length - 1)),
    APPDATA: readWindowsDirectory("APPDATA", path.win32.join(home, "AppData", "Roaming")),
    LOCALAPPDATA: localAppData,
    TEMP: readWindowsDirectory("TEMP", path.win32.join(localAppData, "Temp")),
    TMP: readWindowsDirectory("TMP", path.win32.join(localAppData, "Temp")),
  };
}

async function runOpRead(opCommand, token, secretReference) {
  const result = await runCommandBuffered(
    [opCommand, "read", "--cache=false", "--no-newline", secretReference],
    {
      baseEnv: {},
      discardOutput: { stderr: true },
      env: opEnvironment(token),
      maxOutputBytes: { stdout: MAX_SECRET_VALUE_BYTES },
      timeoutMs: OP_READ_TIMEOUT_MS,
    },
  );
  if (result.termination === "error" && result.error?.code === "ENOENT") {
    throw new Error(opMissingMessage(opCommand));
  }
  if (result.termination === "timeout") {
    throw new Error(`op read timed out after ${OP_READ_TIMEOUT_MS}ms.`);
  }
  if (result.termination === "output-limit") {
    throw new Error("op read output exceeded the secret value limit.");
  }
  if (result.termination === "error") {
    throw new Error("op read could not be started.");
  }
  if (result.code !== 0) {
    throw new Error(`op read failed with exit code ${String(result.code)}.`);
  }
  return result.stdout.toString("utf8");
}

async function runWithConcurrency(values, limit, task) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(values.length, limit) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      await task(values[index]);
    }
  });
  await Promise.all(workers);
}

async function resolveFromOnePassword(ids) {
  const response = { protocolVersion: 1, values: {}, errors: {} };
  if (ids.length > MAX_SECRET_REFS_PER_REQUEST) {
    const message = `1Password SecretRef resolver supports at most ${MAX_SECRET_REFS_PER_REQUEST} references per request.`;
    for (const id of ids) {
      response.errors[id] = { message };
    }
    return response;
  }
  const opCommand = await resolveOpCommand();
  const token = readServiceAccountToken();
  await runWithConcurrency(ids, OP_READ_CONCURRENCY, async (id) => {
    try {
      response.values[id] = await runOpRead(opCommand, token, resolveSecretReference(id));
    } catch (error) {
      response.errors[id] = {
        message: errorMessage(error),
      };
    }
  });
  return response;
}

async function main() {
  const input = await readStdin();
  const request = parseRequest(input);
  writeResponse(await resolveFromOnePassword(request.ids));
}

main().catch(() => {
  process.stderr.write("1Password SecretRef resolver failed.\n");
  process.exitCode = 1;
});
