import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export type TelegramTestCredential = {
  environment: "test";
  groupId: string;
  schemaVersion: 1;
  sutBotId: string;
  sutToken: string;
  sutUsername: string;
  tdlibArchiveBase64: string;
  tdlibArchiveSha256: string;
  tdlibVersion: string;
  testerUserId: string;
};

export type RestoredTelegramTestCredential = TelegramTestCredential & {
  driverEnv: Record<string, string>;
  stateRoot: string;
  userDriverDir: string;
};

type TelegramTestApiProxy = {
  apiRoot: string;
  close(): Promise<void>;
};

type TelegramUserbotSkillRuntime = {
  createStateRoot(): string;
  parseCredential(value: unknown): TelegramTestCredential;
  restoreCredential(value: unknown, stateRoot: string): RestoredTelegramTestCredential;
  startApiProxy(): Promise<TelegramTestApiProxy>;
  userDriverPath: string;
};

export async function flushTelegramTestBotUpdates(apiRoot: string, token: string) {
  let offset = 0;
  for (;;) {
    const response = await fetch(`${apiRoot}/bot${token}/getUpdates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offset, timeout: 0, allowed_updates: ["message", "edited_message"] }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload: unknown = await response.json();
    if (
      !response.ok ||
      !isRecord(payload) ||
      payload.ok !== true ||
      !Array.isArray(payload.result)
    ) {
      throw new Error("Telegram Test Bot API getUpdates failed while draining stale updates.");
    }
    if (payload.result.length === 0) {
      return;
    }
    const last = payload.result.at(-1);
    if (!isRecord(last) || typeof last.update_id !== "number") {
      throw new Error("Telegram Test Bot API getUpdates returned an invalid update.");
    }
    offset = last.update_id + 1;
  }
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value) {
    throw new Error(`Telegram userbot runtime returned invalid ${key}.`);
  }
  return value;
}

function parseCredentialResult(value: unknown): TelegramTestCredential {
  if (!isRecord(value)) {
    throw new Error("Telegram userbot credential parser returned an invalid value.");
  }
  if (value.schemaVersion !== 1 || value.environment !== "test") {
    throw new Error("Telegram userbot credential parser returned an unsupported credential.");
  }
  return {
    schemaVersion: 1,
    environment: "test",
    groupId: requireString(value, "groupId"),
    sutToken: requireString(value, "sutToken"),
    sutUsername: requireString(value, "sutUsername"),
    sutBotId: requireString(value, "sutBotId"),
    testerUserId: requireString(value, "testerUserId"),
    tdlibArchiveBase64: requireString(value, "tdlibArchiveBase64"),
    tdlibArchiveSha256: requireString(value, "tdlibArchiveSha256"),
    tdlibVersion: requireString(value, "tdlibVersion"),
  };
}

function parseRestoredCredential(value: unknown): RestoredTelegramTestCredential {
  const credential = parseCredentialResult(value);
  if (!isRecord(value) || !isRecord(value.driverEnv)) {
    throw new Error("Telegram userbot credential restore returned invalid driverEnv.");
  }
  const driverEnv = Object.fromEntries(
    Object.entries(value.driverEnv).map(([key, entry]) => {
      if (typeof entry !== "string") {
        throw new Error(`Telegram userbot credential restore returned invalid ${key}.`);
      }
      return [key, entry];
    }),
  );
  return {
    ...credential,
    driverEnv,
    stateRoot: requireString(value, "stateRoot"),
    userDriverDir: requireString(value, "userDriverDir"),
  };
}

export async function loadTelegramUserbotSkillRuntime(params?: {
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
}): Promise<TelegramUserbotSkillRuntime> {
  const env = params?.env ?? process.env;
  const repoRoot = params?.repoRoot ?? process.cwd();
  const skillDir = path.resolve(
    env.TELEGRAM_E2E_SKILL_DIR?.trim() ||
      path.join(repoRoot, ".agents", "skills", "telegram-e2e-userbot"),
  );
  const credentialPath = path.join(skillDir, "scripts", "telegram-test-credential.mjs");
  const proxyPath = path.join(skillDir, "scripts", "telegram-test-api-proxy.mjs");
  const userDriverPath = path.join(skillDir, "scripts", "user-driver.py");
  for (const requiredPath of [credentialPath, proxyPath, userDriverPath]) {
    if (!fs.statSync(requiredPath, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(
        `Telegram userbot skill is missing ${path.relative(skillDir, requiredPath)}.`,
      );
    }
  }
  const [credentialModuleValue, proxyModuleValue]: unknown[] = await Promise.all([
    import(pathToFileURL(credentialPath).href),
    import(pathToFileURL(proxyPath).href),
  ]);
  if (!isRecord(credentialModuleValue) || !isRecord(proxyModuleValue)) {
    throw new Error("Telegram userbot skill modules did not load.");
  }
  const parseCredential = credentialModuleValue.parseTelegramTestCredential;
  const restoreCredential = credentialModuleValue.restoreTelegramTestCredential;
  const startApiProxy = proxyModuleValue.startTelegramTestApiProxy;
  if (
    typeof parseCredential !== "function" ||
    typeof restoreCredential !== "function" ||
    typeof startApiProxy !== "function"
  ) {
    throw new Error("Telegram userbot skill does not expose its runtime helpers.");
  }
  return {
    userDriverPath,
    createStateRoot: () => fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-qa-telegram-")),
    parseCredential(value) {
      return parseCredentialResult(Reflect.apply(parseCredential, undefined, [value]));
    },
    restoreCredential(value, stateRoot) {
      return parseRestoredCredential(
        Reflect.apply(restoreCredential, undefined, [value, stateRoot]),
      );
    },
    async startApiProxy() {
      const value: unknown = await Reflect.apply(startApiProxy, undefined, []);
      if (
        !isRecord(value) ||
        typeof value.apiRoot !== "string" ||
        typeof value.close !== "function"
      ) {
        throw new Error("Telegram userbot Test Bot API proxy returned an invalid runtime.");
      }
      return {
        apiRoot: value.apiRoot,
        async close() {
          await Reflect.apply(value.close, value, []);
        },
      };
    },
  };
}
