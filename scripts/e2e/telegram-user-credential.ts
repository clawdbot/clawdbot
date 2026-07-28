#!/usr/bin/env -S node --import tsx
// Telegram User Credential script supports OpenClaw repository automation.

import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fetchJsonWithTimeout, runCommand } from "./telegram-user-credential-io.ts";
import { expandHome, writePrivateJson } from "./telegram-user-credential-paths.ts";

type JsonObject = Record<string, unknown>;

const DEFAULT_USER_DRIVER_DIR = "~/.codex/skills/custom/telegram-e2e-bot-to-bot/user-driver";
const DEFAULT_BOT_CREDENTIALS_FILE =
  "~/.codex/skills/custom/telegram-e2e-bot-to-bot/credentials.local.json";
const DEFAULT_CONVEX_ENV_FILE = "~/.codex/skills/custom/telegram-e2e-bot-to-bot/convex.local.env";
const CHUNKED_PAYLOAD_MARKER = "__openclawQaCredentialPayloadChunksV1";
const TELEGRAM_USER_QA_CREDENTIAL_KIND = "telegram-user";
const SHA256_HEX_RE = /^[a-f0-9]{64}$/u;
const TELEGRAM_CHAT_ID_RE = /^-?\d+$/u;
const TELEGRAM_USER_ID_RE = /^\d+$/u;
const DEFAULT_CHUNKED_PAYLOAD_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_CHUNKED_PAYLOAD_MAX_CHUNKS = 4096;
const COMMAND_TIMEOUT_MS = optionalPositiveInteger(
  process.env.OPENCLAW_TELEGRAM_USER_CREDENTIAL_COMMAND_TIMEOUT_MS?.trim(),
  120_000,
  "OPENCLAW_TELEGRAM_USER_CREDENTIAL_COMMAND_TIMEOUT_MS",
);
const BROKER_TIMEOUT_MS = optionalPositiveInteger(
  process.env.OPENCLAW_TELEGRAM_USER_CREDENTIAL_BROKER_TIMEOUT_MS?.trim(),
  30_000,
  "OPENCLAW_TELEGRAM_USER_CREDENTIAL_BROKER_TIMEOUT_MS",
);
const CHUNKED_PAYLOAD_MAX_BYTES = optionalPositiveInteger(
  process.env.OPENCLAW_QA_CREDENTIAL_PAYLOAD_MAX_BYTES?.trim(),
  DEFAULT_CHUNKED_PAYLOAD_MAX_BYTES,
  "OPENCLAW_QA_CREDENTIAL_PAYLOAD_MAX_BYTES",
);
const CHUNKED_PAYLOAD_MAX_CHUNKS = optionalPositiveInteger(
  process.env.OPENCLAW_QA_CREDENTIAL_PAYLOAD_MAX_CHUNKS?.trim(),
  DEFAULT_CHUNKED_PAYLOAD_MAX_CHUNKS,
  "OPENCLAW_QA_CREDENTIAL_PAYLOAD_MAX_CHUNKS",
);

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
    if (!value || value.startsWith("-")) {
      usage();
    }
    opts.set(key.slice(2), value);
    index += 1;
  }
  return { command, opts };
}

async function readJson(pathCandidate: string): Promise<JsonObject> {
  try {
    return JSON.parse(await readFile(expandHome(pathCandidate), "utf8")) as JsonObject;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function fileExists(pathEntry: string) {
  return readFile(expandHome(pathEntry))
    .then(() => true)
    .catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return false;
      }
      throw error;
    });
}

async function readEnvFile(pathResult: string) {
  if (!(await fileExists(pathResult))) {
    return {};
  }
  const env: Record<string, string> = {};
  const text = await readFile(expandHome(pathResult), "utf8");
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator < 1) {
      throw new Error(`Invalid env line in ${pathResult}.`);
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

function optionalPositiveInteger(value: string | undefined, fallback: number, label = "value") {
  const text = value?.trim();
  if (!text) {
    return fallback;
  }
  if (!/^\d+$/u.test(text)) {
    throw new Error(`${label} must be a positive integer. Got: ${JSON.stringify(text)}.`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer. Got: ${JSON.stringify(text)}.`);
  }
  return parsed;
}

function throwCredentialPayloadError(message: string): never {
  throw new Error(message);
}

function requireTelegramUserPayloadString(payload: Record<string, unknown>, key: string): string {
  const raw = payload[key];
  if (typeof raw !== "string") {
    throwCredentialPayloadError(
      `Credential payload for kind "${TELEGRAM_USER_QA_CREDENTIAL_KIND}" must include "${key}" as a string.`,
    );
  }
  const value = raw.trim();
  if (!value) {
    throwCredentialPayloadError(
      `Credential payload for kind "${TELEGRAM_USER_QA_CREDENTIAL_KIND}" must include a non-empty "${key}" value.`,
    );
  }
  return value;
}

function parseTelegramUserQaCredentialPayload(payload: Record<string, unknown>): JsonObject {
  const groupId = requireTelegramUserPayloadString(payload, "groupId");
  if (!TELEGRAM_CHAT_ID_RE.test(groupId)) {
    throwCredentialPayloadError(
      'Credential payload for kind "telegram-user" must include a numeric "groupId" string.',
    );
  }
  const testerUserId = requireTelegramUserPayloadString(payload, "testerUserId");
  if (!TELEGRAM_USER_ID_RE.test(testerUserId)) {
    throwCredentialPayloadError(
      'Credential payload for kind "telegram-user" must include a numeric "testerUserId" string.',
    );
  }
  const telegramApiId = requireTelegramUserPayloadString(payload, "telegramApiId");
  if (!TELEGRAM_USER_ID_RE.test(telegramApiId)) {
    throwCredentialPayloadError(
      'Credential payload for kind "telegram-user" must include a numeric "telegramApiId" string.',
    );
  }
  const tdlibArchiveSha256 = requireTelegramUserPayloadString(
    payload,
    "tdlibArchiveSha256",
  ).toLowerCase();
  const desktopTdataArchiveSha256 = requireTelegramUserPayloadString(
    payload,
    "desktopTdataArchiveSha256",
  ).toLowerCase();
  if (!SHA256_HEX_RE.test(tdlibArchiveSha256)) {
    throwCredentialPayloadError(
      'Credential payload for kind "telegram-user" must include "tdlibArchiveSha256" as a SHA-256 hex string.',
    );
  }
  if (!SHA256_HEX_RE.test(desktopTdataArchiveSha256)) {
    throwCredentialPayloadError(
      'Credential payload for kind "telegram-user" must include "desktopTdataArchiveSha256" as a SHA-256 hex string.',
    );
  }

  return {
    groupId,
    sutToken: requireTelegramUserPayloadString(payload, "sutToken"),
    testerUserId,
    testerUsername: requireTelegramUserPayloadString(payload, "testerUsername"),
    telegramApiId,
    telegramApiHash: requireTelegramUserPayloadString(payload, "telegramApiHash"),
    tdlibDatabaseEncryptionKey: requireTelegramUserPayloadString(
      payload,
      "tdlibDatabaseEncryptionKey",
    ),
    tdlibArchiveBase64: requireTelegramUserPayloadString(payload, "tdlibArchiveBase64"),
    tdlibArchiveSha256,
    desktopTdataArchiveBase64: requireTelegramUserPayloadString(
      payload,
      "desktopTdataArchiveBase64",
    ),
    desktopTdataArchiveSha256,
  };
}

async function fileSha256(pathValue: string) {
  return createHash("sha256")
    .update(await readFile(pathValue))
    .digest("hex");
}

async function tgzBase64(pathLocal: string) {
  return (await readFile(pathLocal)).toString("base64");
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
  const { payload, response } = await fetchJsonWithTimeout({
    url: joinBrokerEndpoint(params.siteUrl, params.action),
    label: `credential broker ${params.action}`,
    timeoutMs: BROKER_TIMEOUT_MS,
    init: {
      method: "POST",
      headers: {
        authorization: `Bearer ${params.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(params.body),
    },
  });
  if (!response.ok) {
    assertBrokerSuccess(payload, params.action);
    throw new Error(`${params.action} failed with HTTP ${response.status}.`);
  }
  assertBrokerSuccess(payload, params.action);
  return payload;
}

export function buildTelegramUserCredentialOwnerId() {
  return `telegram-user-${randomUUID()}`;
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
      "OPENCLAW_QA_CREDENTIAL_LEASE_TTL_MS",
    ),
    heartbeatIntervalMs: optionalPositiveInteger(
      opts.get("heartbeat-interval-ms") ||
        process.env.OPENCLAW_QA_CREDENTIAL_HEARTBEAT_INTERVAL_MS?.trim() ||
        fileEnv.OPENCLAW_QA_CREDENTIAL_HEARTBEAT_INTERVAL_MS,
      30_000,
      "OPENCLAW_QA_CREDENTIAL_HEARTBEAT_INTERVAL_MS",
    ),
    ownerId:
      opts.get("owner-id") ||
      process.env.OPENCLAW_QA_CREDENTIAL_OWNER_ID?.trim() ||
      buildTelegramUserCredentialOwnerId(),
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
  if (record.chunkCount > CHUNKED_PAYLOAD_MAX_CHUNKS) {
    throw new Error(`Chunked payload marker exceeds ${CHUNKED_PAYLOAD_MAX_CHUNKS} chunks.`);
  }
  if (
    typeof record.byteLength !== "number" ||
    !Number.isInteger(record.byteLength) ||
    record.byteLength < 0
  ) {
    throw new Error("Chunked payload marker has invalid byteLength.");
  }
  if (record.byteLength > CHUNKED_PAYLOAD_MAX_BYTES) {
    throw new Error(`Chunked payload marker exceeds ${CHUNKED_PAYLOAD_MAX_BYTES} bytes.`);
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
  let serializedBytes = 0;
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
    const data = requireString(chunk, "data");
    serializedBytes += Buffer.byteLength(data, "utf8");
    if (serializedBytes > marker.byteLength) {
      throw new Error("Chunked payload exceeded declared byteLength.");
    }
    chunks.push(data);
  }
  const serialized = chunks.join("");
  if (serializedBytes !== marker.byteLength) {
    throw new Error("Chunked payload length mismatch.");
  }
  return parseTelegramUserQaCredentialPayload(JSON.parse(serialized));
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

  const tempRoot = await mkdtemp(path.join(tmpdir(), "openclaw-telegram-user-credential-"));
  const tdlibArchive = path.join(tempRoot, "tdlib.tgz");
  const desktopArchive = path.join(tempRoot, "desktop-tdata.tgz");
  try {
    await runCommand("tar", ["-C", userDriverDir, "-czf", tdlibArchive, "db", "files"], undefined, {
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    if (desktopTdataArchiveInput) {
      await copyFile(expandHome(desktopTdataArchiveInput), desktopArchive);
    } else {
      await runCommand(
        "tar",
        [
          "-C",
          path.dirname(expandHome(desktopTdataDir!)),
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
        ],
        undefined,
        { timeoutMs: COMMAND_TIMEOUT_MS },
      );
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
  const tempRoot = await mkdtemp(path.join(tmpdir(), "openclaw-telegram-user-restore-"));
  const tdlibArchive = path.join(tempRoot, "tdlib.tgz");
  const desktopArchive = path.join(tempRoot, "desktop-tdata.tgz");
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

    await runCommand("tar", ["-C", expandHome(userDriverDir), "-xzf", tdlibArchive], undefined, {
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    await runCommand("tar", ["-C", expandHome(desktopWorkdir), "-xzf", desktopArchive], undefined, {
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
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

async function main(argv = process.argv) {
  const { command, opts } = parseArgs(argv);
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

export { hydratePayloadFromLease, optionalPositiveInteger, parseArgs, parseChunkedPayloadMarker };
