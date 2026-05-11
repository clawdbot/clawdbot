#!/usr/bin/env -S node --import tsx

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import {
  TELEGRAM_USER_QA_CREDENTIAL_KIND,
  parseTelegramUserQaCredentialPayload,
} from "../../extensions/qa-lab/runtime-api.js";

type JsonObject = Record<string, unknown>;

const DEFAULT_USER_DRIVER_DIR = "~/.codex/skills/custom/telegram-e2e-bot-to-bot/user-driver";
const DEFAULT_BOT_CREDENTIALS_FILE =
  "~/.codex/skills/custom/telegram-e2e-bot-to-bot/credentials.local.json";
const DEFAULT_CONVEX_ENV_FILE = "~/.codex/skills/custom/telegram-e2e-bot-to-bot/convex.local.env";
const CHUNKED_PAYLOAD_MARKER = "__openclawQaCredentialPayloadChunksV1";

function usage(): never {
  throw new Error(
    [
      "Usage:",
      "  node --import tsx scripts/e2e/telegram-user-credential.ts export (--desktop-tdata-dir <path> | --desktop-tdata-archive <tdata.tgz>) --output <payload.json>",
      "  node --import tsx scripts/e2e/telegram-user-credential.ts restore --payload-file <payload.json> --user-driver-dir <path> --desktop-workdir <path>",
      "  node --import tsx scripts/e2e/telegram-user-credential.ts lease-restore --user-driver-dir <path> --desktop-workdir <path> --lease-file <lease.json> [--payload-output <payload.json>] [--env-file <path>]",
      "  node --import tsx scripts/e2e/telegram-user-credential.ts release --lease-file <lease.json> [--env-file <path>]",
    ].join("\n"),
  );
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node --import tsx scripts/e2e/telegram-user-credential.ts export (--desktop-tdata-dir <path> | --desktop-tdata-archive <tdata.tgz>) --output <payload.json>",
      "  node --import tsx scripts/e2e/telegram-user-credential.ts restore --payload-file <payload.json> --user-driver-dir <path> --desktop-workdir <path>",
      "  node --import tsx scripts/e2e/telegram-user-credential.ts lease-restore --user-driver-dir <path> --desktop-workdir <path> --lease-file <lease.json> [--payload-output <payload.json>] [--env-file <path>]",
      "  node --import tsx scripts/e2e/telegram-user-credential.ts release --lease-file <lease.json> [--env-file <path>]",
    ].join("\n"),
  );
}

function expandHome(path: string) {
  if (path === "~") {
    return process.env.HOME || path;
  }
  if (path.startsWith("~/")) {
    return `${process.env.HOME || "~"}${path.slice(1)}`;
  }
  return path;
}

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const command = args[0] || usage();
  if (command === "--help" || command === "-h") {
    printUsage();
    process.exit(0);
  }
  const opts = new Map<string, string>();
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] === "--") {
      continue;
    }
    const key = args[index];
    if (!key.startsWith("--")) {
      usage();
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      usage();
    }
    opts.set(key.slice(2), value);
    index += 1;
  }
  return { command, opts };
}

async function readJson(path: string): Promise<JsonObject> {
  try {
    return JSON.parse(await readFile(expandHome(path), "utf8")) as JsonObject;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function fileExists(path: string) {
  return readFile(expandHome(path))
    .then(() => true)
    .catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return false;
      }
      throw error;
    });
}

async function readEnvFile(path: string) {
  if (!(await fileExists(path))) {
    return {};
  }
  const env: Record<string, string> = {};
  const text = await readFile(expandHome(path), "utf8");
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator < 1) {
      throw new Error(`Invalid env line in ${path}.`);
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed
      .slice(separator + 1)
      .trim()
      .replace(/^['"]|['"]$/gu, "");
    env[key] = value;
  }
  return env;
}

function requireString(source: JsonObject, key: string) {
  const value = source[key];
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  throw new Error(`Missing ${key}.`);
}

function optionalString(source: JsonObject, key: string) {
  const value = source[key];
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return undefined;
}

function optionalPositiveInteger(value: string | undefined, fallback: number) {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected positive integer, got ${value}.`);
  }
  return parsed;
}

async function fileSha256(path: string) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function tgzBase64(path: string) {
  return (await readFile(path)).toString("base64");
}

async function writePrivateJson(path: string, payload: JsonObject) {
  const expanded = expandHome(path);
  await mkdir(expanded.slice(0, expanded.lastIndexOf("/")), { recursive: true });
  await writeFile(expanded, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await chmodPrivate(expanded);
}

async function chmodPrivate(path: string) {
  await chmod(path, 0o600);
}

function runCommand(command: string, args: string[], cwd?: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      reject(new Error(`${command} ${args.join(" ")} failed with ${detail}\n${stdout}${stderr}`));
    });
  });
}

function joinBrokerEndpoint(siteUrl: string, endpoint: string) {
  const normalized = siteUrl.replace(/\/+$/u, "");
  return `${normalized}/qa-credentials/v1/${endpoint}`;
}

function assertBrokerSuccess(payload: JsonObject, action: string) {
  if (payload.status === "error") {
    throw new Error(
      `${action} failed: ${requireString(payload, "code")} ${optionalString(payload, "message") || ""}`.trim(),
    );
  }
  if (payload.status !== "ok") {
    throw new Error(`${action} returned an invalid response.`);
  }
}

async function postBroker(params: {
  action: string;
  body: JsonObject;
  siteUrl: string;
  token: string;
}) {
  const response = await fetch(joinBrokerEndpoint(params.siteUrl, params.action), {
    method: "POST",
    headers: {
      authorization: `Bearer ${params.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(params.body),
  });
  const payload = (await response.json()) as JsonObject;
  if (!response.ok) {
    assertBrokerSuccess(payload, params.action);
    throw new Error(`${params.action} failed with HTTP ${response.status}.`);
  }
  assertBrokerSuccess(payload, params.action);
  return payload;
}

async function resolveConvexLeaseConfig(opts: Map<string, string>) {
  const envFile = opts.get("env-file") || DEFAULT_CONVEX_ENV_FILE;
  const fileEnv = await readEnvFile(envFile);
  const siteUrl =
    opts.get("site-url") ||
    process.env.OPENCLAW_QA_CONVEX_SITE_URL?.trim() ||
    fileEnv.OPENCLAW_QA_CONVEX_SITE_URL;
  const token =
    opts.get("ci-secret") ||
    process.env.OPENCLAW_QA_CONVEX_SECRET_CI?.trim() ||
    fileEnv.OPENCLAW_QA_CONVEX_SECRET_CI;
  if (!siteUrl) {
    throw new Error("Missing OPENCLAW_QA_CONVEX_SITE_URL.");
  }
  if (!token) {
    throw new Error("Missing OPENCLAW_QA_CONVEX_SECRET_CI.");
  }
  return {
    siteUrl,
    token,
    leaseTtlMs: optionalPositiveInteger(
      opts.get("lease-ttl-ms") ||
        process.env.OPENCLAW_QA_CREDENTIAL_LEASE_TTL_MS?.trim() ||
        fileEnv.OPENCLAW_QA_CREDENTIAL_LEASE_TTL_MS,
      20 * 60 * 1_000,
    ),
    heartbeatIntervalMs: optionalPositiveInteger(
      opts.get("heartbeat-interval-ms") ||
        process.env.OPENCLAW_QA_CREDENTIAL_HEARTBEAT_INTERVAL_MS?.trim() ||
        fileEnv.OPENCLAW_QA_CREDENTIAL_HEARTBEAT_INTERVAL_MS,
      30_000,
    ),
    ownerId:
      opts.get("owner-id") ||
      process.env.OPENCLAW_QA_CREDENTIAL_OWNER_ID?.trim() ||
      `telegram-user-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
  };
}

function parseChunkedPayloadMarker(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (record[CHUNKED_PAYLOAD_MARKER] !== true) {
    return null;
  }
  if (
    typeof record.chunkCount !== "number" ||
    !Number.isInteger(record.chunkCount) ||
    record.chunkCount < 1
  ) {
    throw new Error("Chunked payload marker has invalid chunkCount.");
  }
  if (
    typeof record.byteLength !== "number" ||
    !Number.isInteger(record.byteLength) ||
    record.byteLength < 0
  ) {
    throw new Error("Chunked payload marker has invalid byteLength.");
  }
  return {
    chunkCount: record.chunkCount,
    byteLength: record.byteLength,
  };
}

async function hydratePayloadFromLease(params: {
  acquired: JsonObject;
  ownerId: string;
  siteUrl: string;
  token: string;
}) {
  const marker = parseChunkedPayloadMarker(params.acquired.payload);
  if (!marker) {
    return params.acquired.payload as JsonObject;
  }
  const credentialId = requireString(params.acquired, "credentialId");
  const leaseToken = requireString(params.acquired, "leaseToken");
  const chunks: string[] = [];
  for (let index = 0; index < marker.chunkCount; index += 1) {
    const chunk = await postBroker({
      action: "payload-chunk",
      siteUrl: params.siteUrl,
      token: params.token,
      body: {
        kind: TELEGRAM_USER_QA_CREDENTIAL_KIND,
        ownerId: params.ownerId,
        actorRole: "ci",
        credentialId,
        leaseToken,
        index,
      },
    });
    chunks.push(requireString(chunk, "data"));
  }
  const serialized = chunks.join("");
  if (serialized.length !== marker.byteLength) {
    throw new Error("Chunked payload length mismatch.");
  }
  return parseTelegramUserQaCredentialPayload(JSON.parse(serialized)) as JsonObject;
}

async function createTelegramUserPayload(opts: Map<string, string>) {
  const userDriverDir = expandHome(opts.get("user-driver-dir") || DEFAULT_USER_DRIVER_DIR);
  const botCredentialsFile = expandHome(
    opts.get("bot-credentials-file") || DEFAULT_BOT_CREDENTIALS_FILE,
  );
  const desktopTdataDir = opts.get("desktop-tdata-dir");
  const desktopTdataArchiveInput = opts.get("desktop-tdata-archive");
  const output = opts.get("output");
  if (
    (!desktopTdataDir && !desktopTdataArchiveInput) ||
    (desktopTdataDir && desktopTdataArchiveInput) ||
    !output
  ) {
    usage();
  }

  const config = await readJson(`${userDriverDir}/config.local.json`);
  const botCredentials = await readJson(botCredentialsFile);
  const sutToken =
    process.env.OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN?.trim() ||
    process.env.TELEGRAM_E2E_SUT_BOT_TOKEN?.trim() ||
    (typeof botCredentials.sutBotToken === "string" ? botCredentials.sutBotToken.trim() : "") ||
    (typeof botCredentials.botAToken === "string" ? botCredentials.botAToken.trim() : "") ||
    (typeof botCredentials.BOTA === "string" ? botCredentials.BOTA.trim() : "");
  if (!sutToken) {
    throw new Error("Missing SUT token in env or bot credentials file.");
  }

  const groupId =
    process.env.OPENCLAW_QA_TELEGRAM_GROUP_ID?.trim() ||
    process.env.TELEGRAM_E2E_GROUP_ID?.trim() ||
    (typeof config.defaultChatId === "string" ? config.defaultChatId.trim() : "") ||
    (typeof botCredentials.groupId === "string" ? botCredentials.groupId.trim() : "");
  if (!groupId) {
    throw new Error("Missing group id in env, user-driver config, or bot credentials file.");
  }

  const tempRoot = `/tmp/openclaw-telegram-user-credential-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  const tdlibArchive = `${tempRoot}/tdlib.tgz`;
  const desktopArchive = `${tempRoot}/desktop-tdata.tgz`;
  await mkdir(tempRoot, { recursive: true });
  try {
    await runCommand("tar", ["-C", userDriverDir, "-czf", tdlibArchive, "db", "files"]);
    if (desktopTdataArchiveInput) {
      await copyFile(expandHome(desktopTdataArchiveInput), desktopArchive);
    } else {
      await runCommand("tar", [
        "-C",
        `${expandHome(desktopTdataDir!)}/..`,
        "--exclude",
        "tdata/countries",
        "--exclude",
        "tdata/dictionaries",
        "--exclude",
        "tdata/dumps",
        "--exclude",
        "tdata/emoji",
        "--exclude",
        "tdata/user_data",
        "--exclude",
        "tdata/working",
        "-czf",
        desktopArchive,
        "tdata",
      ]);
    }

    const payload = parseTelegramUserQaCredentialPayload({
      groupId,
      sutToken,
      testerUserId: requireString(config, "testerUserId"),
      testerUsername: requireString(config, "testerUsername"),
      telegramApiId: requireString(config, "apiId"),
      telegramApiHash: requireString(config, "apiHash"),
      tdlibDatabaseEncryptionKey: requireString(config, "databaseEncryptionKey"),
      tdlibArchiveBase64: await tgzBase64(tdlibArchive),
      tdlibArchiveSha256: await fileSha256(tdlibArchive),
      desktopTdataArchiveBase64: await tgzBase64(desktopArchive),
      desktopTdataArchiveSha256: await fileSha256(desktopArchive),
    });
    await writePrivateJson(output, payload);
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
}

async function restoreTelegramUserPayloadFromFile(opts: Map<string, string>) {
  const payloadFile = opts.get("payload-file");
  if (!payloadFile) {
    usage();
  }
  await restoreTelegramUserPayload({
    payload: await readJson(payloadFile),
    userDriverDir: opts.get("user-driver-dir"),
    desktopWorkdir: opts.get("desktop-workdir"),
  });
}

async function restoreTelegramUserPayload(params: {
  payload: JsonObject;
  userDriverDir: string | undefined;
  desktopWorkdir: string | undefined;
}) {
  const userDriverDir = params.userDriverDir;
  const desktopWorkdir = params.desktopWorkdir;
  if (!userDriverDir || !desktopWorkdir) {
    usage();
  }
  const payload = parseTelegramUserQaCredentialPayload(params.payload);
  const tempRoot = `/tmp/openclaw-telegram-user-restore-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  const tdlibArchive = `${tempRoot}/tdlib.tgz`;
  const desktopArchive = `${tempRoot}/desktop-tdata.tgz`;
  await mkdir(tempRoot, { recursive: true });
  await mkdir(expandHome(userDriverDir), { recursive: true });
  await mkdir(expandHome(desktopWorkdir), { recursive: true });
  try {
    await writeFile(
      tdlibArchive,
      Buffer.from(requireString(payload, "tdlibArchiveBase64"), "base64"),
    );
    await writeFile(
      desktopArchive,
      Buffer.from(requireString(payload, "desktopTdataArchiveBase64"), "base64"),
    );
    if ((await fileSha256(tdlibArchive)) !== requireString(payload, "tdlibArchiveSha256")) {
      throw new Error("TDLib archive SHA-256 mismatch.");
    }
    if (
      (await fileSha256(desktopArchive)) !== requireString(payload, "desktopTdataArchiveSha256")
    ) {
      throw new Error("Telegram Desktop archive SHA-256 mismatch.");
    }

    await runCommand("tar", ["-C", expandHome(userDriverDir), "-xzf", tdlibArchive]);
    await runCommand("tar", ["-C", expandHome(desktopWorkdir), "-xzf", desktopArchive]);
    await writePrivateJson(`${expandHome(userDriverDir)}/config.local.json`, {
      apiId: Number(requireString(payload, "telegramApiId")),
      apiHash: requireString(payload, "telegramApiHash"),
      databaseEncryptionKey: requireString(payload, "tdlibDatabaseEncryptionKey"),
      defaultChatId: requireString(payload, "groupId"),
      testerUserId: Number(requireString(payload, "testerUserId")),
      testerUsername: requireString(payload, "testerUsername"),
    });
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
}

async function leaseAndRestoreTelegramUser(opts: Map<string, string>) {
  const userDriverDir = opts.get("user-driver-dir");
  const desktopWorkdir = opts.get("desktop-workdir");
  const leaseFile = opts.get("lease-file");
  const payloadOutput = opts.get("payload-output");
  if (!userDriverDir || !desktopWorkdir || !leaseFile) {
    usage();
  }
  const config = await resolveConvexLeaseConfig(opts);
  const acquired = await postBroker({
    action: "acquire",
    siteUrl: config.siteUrl,
    token: config.token,
    body: {
      kind: TELEGRAM_USER_QA_CREDENTIAL_KIND,
      ownerId: config.ownerId,
      actorRole: "ci",
      leaseTtlMs: config.leaseTtlMs,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
    },
  });
  const lease = {
    siteUrl: config.siteUrl,
    kind: TELEGRAM_USER_QA_CREDENTIAL_KIND,
    ownerId: config.ownerId,
    actorRole: "ci",
    credentialId: requireString(acquired, "credentialId"),
    leaseToken: requireString(acquired, "leaseToken"),
  };

  try {
    const payload = await hydratePayloadFromLease({
      acquired,
      siteUrl: config.siteUrl,
      token: config.token,
      ownerId: config.ownerId,
    });
    await restoreTelegramUserPayload({ payload, userDriverDir, desktopWorkdir });
    await writePrivateJson(leaseFile, lease);
    if (payloadOutput) {
      await writePrivateJson(payloadOutput, payload);
    }
    console.log(
      JSON.stringify(
        {
          status: "ok",
          credentialId: lease.credentialId,
          ownerId: lease.ownerId,
          leaseFile,
          userDriverDir,
          desktopWorkdir,
          testerUserId: requireString(payload, "testerUserId"),
          testerUsername: requireString(payload, "testerUsername"),
          groupId: requireString(payload, "groupId"),
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await releaseTelegramUserLeaseBody({
      siteUrl: lease.siteUrl,
      token: config.token,
      lease,
    });
    throw error;
  }
}

async function releaseTelegramUserLeaseBody(params: {
  siteUrl: string;
  token: string;
  lease: JsonObject;
}) {
  return postBroker({
    action: "release",
    siteUrl: params.siteUrl,
    token: params.token,
    body: {
      kind: requireString(params.lease, "kind"),
      ownerId: requireString(params.lease, "ownerId"),
      actorRole: requireString(params.lease, "actorRole"),
      credentialId: requireString(params.lease, "credentialId"),
      leaseToken: requireString(params.lease, "leaseToken"),
    },
  });
}

async function releaseTelegramUserLease(opts: Map<string, string>) {
  const leaseFile = opts.get("lease-file");
  if (!leaseFile) {
    usage();
  }
  const config = await resolveConvexLeaseConfig(opts);
  const lease = await readJson(leaseFile);
  await releaseTelegramUserLeaseBody({
    siteUrl: config.siteUrl,
    token: config.token,
    lease,
  });
  await unlink(expandHome(leaseFile)).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  });
  console.log(
    JSON.stringify({ status: "ok", credentialId: requireString(lease, "credentialId") }, null, 2),
  );
}

const { command, opts } = parseArgs(process.argv);
if (command === "export") {
  await createTelegramUserPayload(opts);
} else if (command === "restore") {
  await restoreTelegramUserPayloadFromFile(opts);
} else if (command === "lease-restore") {
  await leaseAndRestoreTelegramUser(opts);
} else if (command === "release") {
  await releaseTelegramUserLease(opts);
} else {
  usage();
}
