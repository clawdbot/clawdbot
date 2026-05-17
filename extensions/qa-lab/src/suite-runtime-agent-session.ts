import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { liveTurnTimeoutMs } from "./suite-runtime-agent-common.js";
import type {
  QaRawSessionStoreEntry,
  QaSkillStatusEntry,
  QaSuiteRuntimeEnv,
} from "./suite-runtime-types.js";

type QaGatewayCallEnv = Pick<
  QaSuiteRuntimeEnv,
  "gateway" | "primaryModel" | "alternateModel" | "providerMode"
>;

const SESSION_STORE_LOCK_RETRY_DELAYS_MS = [1_000, 3_000, 5_000] as const;

function isSessionStoreLockTimeout(error: unknown) {
  const text = formatErrorMessage(error);
  return (
    text.includes("OPENCLAW_SESSION_WRITE_LOCK_TIMEOUT") ||
    text.includes("SessionWriteLockTimeoutError") ||
    text.includes("session file locked")
  );
}

async function callGatewayWithSessionStoreLockRetry<T>(
  env: QaGatewayCallEnv,
  method: string,
  params: Record<string, unknown>,
  options: { timeoutMs: number },
) {
  for (let attempt = 0; attempt <= SESSION_STORE_LOCK_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return (await env.gateway.call(method, params, options)) as T;
    } catch (error) {
      if (
        !isSessionStoreLockTimeout(error) ||
        attempt === SESSION_STORE_LOCK_RETRY_DELAYS_MS.length
      ) {
        throw error;
      }
      await sleep(SESSION_STORE_LOCK_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw new Error(`${method} failed after session store lock retries`);
}

async function createSession(env: QaGatewayCallEnv, label: string, key?: string) {
  const created = await callGatewayWithSessionStoreLockRetry<{ key?: string }>(
    env,
    "sessions.create",
    {
      label,
      ...(key ? { key } : {}),
    },
    {
      timeoutMs: liveTurnTimeoutMs(env, 60_000),
    },
  );
  const sessionKey = created.key?.trim();
  if (!sessionKey) {
    throw new Error("sessions.create returned no key");
  }
  return sessionKey;
}

async function readEffectiveTools(env: QaGatewayCallEnv, sessionKey: string) {
  const payload = await callGatewayWithSessionStoreLockRetry<{
    groups?: Array<{ tools?: Array<{ id?: string }> }>;
  }>(
    env,
    "tools.effective",
    {
      sessionKey,
    },
    {
      timeoutMs: liveTurnTimeoutMs(env, 90_000),
    },
  );
  const ids = new Set<string>();
  for (const group of payload.groups ?? []) {
    for (const tool of group.tools ?? []) {
      if (tool.id?.trim()) {
        ids.add(tool.id.trim());
      }
    }
  }
  return ids;
}

async function readSkillStatus(env: QaGatewayCallEnv, agentId = "qa") {
  const payload = await callGatewayWithSessionStoreLockRetry<{
    skills?: QaSkillStatusEntry[];
  }>(
    env,
    "skills.status",
    {
      agentId,
    },
    {
      timeoutMs: liveTurnTimeoutMs(env, 45_000),
    },
  );
  return payload.skills ?? [];
}

async function readRawQaSessionStore(env: Pick<QaSuiteRuntimeEnv, "gateway">) {
  const storePath = path.join(
    env.gateway.tempRoot,
    "state",
    "agents",
    "qa",
    "sessions",
    "sessions.json",
  );
  try {
    const raw = await fs.readFile(storePath, "utf8");
    return JSON.parse(raw) as Record<string, QaRawSessionStoreEntry>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export { createSession, readEffectiveTools, readRawQaSessionStore, readSkillStatus };
