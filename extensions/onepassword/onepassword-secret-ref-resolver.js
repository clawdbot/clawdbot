#!/usr/bin/env node

import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveTrustedOnePasswordCli } from "./onepassword-op-path.js";
import { resolveOnePasswordSecretReference } from "./onepassword-secret-id.js";

const OP_READ_CONCURRENCY = 4;
const OP_READ_TIMEOUT_MS = 7_000;
const MAX_REQUEST_IDS = 16;
const MAX_SECRET_VALUE_BYTES = 64 * 1024;
const MAX_TOKEN_BYTES = 16 * 1024;

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
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
  if (parsed.ids.length > MAX_REQUEST_IDS) {
    throw new Error(`1Password SecretRef requests support at most ${MAX_REQUEST_IDS} ids.`);
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

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function resolveOsHome() {
  const home = process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || os.homedir();
  if (!home) {
    throw new Error("Unable to resolve the user home for the 1Password CLI.");
  }
  return path.resolve(home);
}

function resolveOpenClawHome() {
  const explicit = process.env.OPENCLAW_HOME?.trim();
  if (!explicit) {
    return resolveOsHome();
  }
  if (explicit === "~" || explicit.startsWith("~/") || explicit.startsWith("~\\")) {
    return path.resolve(explicit.replace(/^~(?=$|[\\/])/u, resolveOsHome()));
  }
  return path.resolve(explicit);
}

function resolveStateDir() {
  const override = process.env.OPENCLAW_STATE_DIR?.trim();
  if (override) {
    if (override === "~" || override.startsWith("~/") || override.startsWith("~\\")) {
      return path.resolve(override.replace(/^~(?=$|[\\/])/u, resolveOpenClawHome()));
    }
    return path.resolve(override);
  }
  const home = resolveOpenClawHome();
  const current = path.join(home, ".openclaw");
  const legacy = path.join(home, ".clawdbot");
  return fsSync.existsSync(current) || !fsSync.existsSync(legacy) ? current : legacy;
}

async function readServiceAccountToken() {
  // Keep this child-process path aligned with the broker path in index.ts.
  // The resolver is a static asset and cannot import the plugin runtime.
  const tokenFile = path.join(
    resolveStateDir(),
    "credentials",
    "onepassword",
    "service-account-token",
  );
  let handle;
  try {
    const linkStat = await fs.lstat(tokenFile);
    if (linkStat.isSymbolicLink()) {
      throw new Error("symlinked token file");
    }
    handle = await fs.open(
      tokenFile,
      fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW ?? 0),
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_TOKEN_BYTES) {
      throw new Error("invalid token file");
    }
    const token = (await handle.readFile("utf8")).trim();
    if (!token) {
      throw new Error("empty token file");
    }
    return token;
  } catch {
    throw new Error(
      "1Password service account token file is missing, empty, unsafe, or too large. Configure the onepassword plugin token file first.",
    );
  } finally {
    await handle?.close();
  }
}

function opEnvironment(token) {
  // The managed resolver is non-interactive. Never let a host desktop integration turn a
  // Gateway secret read into an authorization or macOS App Data prompt.
  return {
    HOME: resolveOsHome(),
    OP_SERVICE_ACCOUNT_TOKEN: token,
    OP_BIOMETRIC_UNLOCK_ENABLED: "false",
    OP_LOAD_DESKTOP_APP_SETTINGS: "false",
  };
}

function runOpRead(opCommand, token, secretReference) {
  return new Promise((resolve, reject) => {
    const child = spawn(opCommand, ["read", "--no-newline", secretReference], {
      env: opEnvironment(token),
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    let stdoutBytes = 0;
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      result();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(`op read timed out after ${OP_READ_TIMEOUT_MS}ms.`)));
    }, OP_READ_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk, "utf8");
      if (stdoutBytes > MAX_SECRET_VALUE_BYTES) {
        child.kill();
        finish(() => reject(new Error("op read output exceeded the secret value limit.")));
        return;
      }
      stdout += chunk;
    });
    child.on("error", (error) => {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        finish(() => reject(new Error(opMissingMessage(opCommand))));
        return;
      }
      finish(() => reject(error instanceof Error ? error : new Error(String(error))));
    });
    child.on("close", (code) => {
      if (code === 0) {
        finish(() => resolve(stdout));
        return;
      }
      finish(() => reject(new Error(`op read failed with exit code ${String(code)}.`)));
    });
  });
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
  const [opCommand, token] = await Promise.all([resolveOpCommand(), readServiceAccountToken()]);
  const response = { protocolVersion: 1, values: {}, errors: {} };
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

main().catch((/** @type {unknown} */ error) => {
  const message = errorMessage(error);
  writeResponse({
    protocolVersion: 1,
    values: {},
    errors: {
      request: { message },
    },
  });
});
