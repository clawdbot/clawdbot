// Stores and verifies web push subscriptions and delivery payloads.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expectDefined, normalizeOptionalString } from "@openclaw/normalization-core";
import { resolveStateDir } from "../config/paths.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import {
  createWebPushVapidKeyPair,
  deleteWebPushSubscriptionByEndpoint,
  deleteWebPushSubscriptionIfCurrent,
  hashWebPushEndpoint,
  insertVapidKeyPairIfAbsent,
  isValidWebPushEndpoint,
  isValidWebPushKey,
  listWebPushSubscriptions,
  readPersistedVapidKeyPair,
  upsertWebPushSubscription,
  DEFAULT_WEB_PUSH_VAPID_SUBJECT,
  type VapidKeyPair,
  type WebPushSubscription,
} from "./push-web-store.js";

// --- Types ---

type WebPushSendResult = {
  ok: boolean;
  subscriptionId: string;
  statusCode?: number;
  error?: string;
};

// --- Constants ---

const LEGACY_WEB_PUSH_PATHS = ["push/web-push-subscriptions.json", "push/vapid-keys.json"] as const;

// Bound the number of concurrent web push sends so a large subscriber list
// cannot fan out into an unbounded thundering herd of HTTP requests.
const WEB_PUSH_SEND_CONCURRENCY = 12;

type WebPushRuntime = typeof import("web-push");
type WebPushRuntimeModule = WebPushRuntime & { default?: WebPushRuntime };

const loadWebPushRuntime = createLazyRuntimeModule(() =>
  import("web-push").then((mod: WebPushRuntimeModule) => mod.default ?? mod),
);

function legacyWebPushPathMayExist(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    // Only a definite absence permits creating a new signing identity.
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

// Production callers run under the Gateway's lifetime state/config lock. Doctor must
// acquire those same locks before claiming legacy files, so this check remains stable
// through the following SQLite operation or asynchronous delivery fan-out.
function assertLegacyWebPushMigrationComplete(baseDir?: string): void {
  const stateDir = baseDir ?? resolveStateDir();
  const pendingLegacyPath = LEGACY_WEB_PUSH_PATHS.find((relativePath) => {
    const sourcePath = path.join(stateDir, relativePath);
    return (
      legacyWebPushPathMayExist(sourcePath) ||
      legacyWebPushPathMayExist(`${sourcePath}.doctor-importing`)
    );
  });
  if (pendingLegacyPath) {
    throw new Error(
      `legacy Web Push state requires migration; run \`openclaw doctor --fix\` before using Web Push`,
    );
  }
}

// --- VAPID keys ---

export async function resolveVapidKeys(baseDir?: string): Promise<VapidKeyPair> {
  assertLegacyWebPushMigrationComplete(baseDir);

  // Env vars take precedence — allows operators to share a stable VAPID
  // identity across multiple gateway instances.
  const envPublic = resolveVapidPublicKeyFromEnv();
  const envPrivate = resolveVapidPrivateKeyFromEnv();
  if (envPublic && envPrivate) {
    return {
      publicKey: envPublic,
      privateKey: envPrivate,
      subject: resolveVapidSubjectFromEnv(),
    };
  }

  const existing = readPersistedVapidKeyPair(baseDir);
  if (existing) {
    return { ...existing, subject: resolveVapidSubjectFromEnv() };
  }

  // Generation can race across gateway processes. SQLite selects one durable
  // identity, then every contender returns that committed keypair.
  const webPush = await loadWebPushRuntime();
  const keys = webPush.generateVAPIDKeys();
  const pair = insertVapidKeyPairIfAbsent({
    candidate: createWebPushVapidKeyPair(
      keys.publicKey,
      keys.privateKey,
      resolveVapidSubjectFromEnv(),
    ),
    nowMs: Date.now(),
    stateDir: baseDir,
  });
  return { ...pair, subject: resolveVapidSubjectFromEnv() };
}

function resolveVapidSubjectFromEnv(): string {
  return (
    normalizeOptionalString(process.env.OPENCLAW_VAPID_SUBJECT) ?? DEFAULT_WEB_PUSH_VAPID_SUBJECT
  );
}

function resolveVapidPublicKeyFromEnv(): string | undefined {
  return normalizeOptionalString(process.env.OPENCLAW_VAPID_PUBLIC_KEY);
}

function resolveVapidPrivateKeyFromEnv(): string | undefined {
  return normalizeOptionalString(process.env.OPENCLAW_VAPID_PRIVATE_KEY);
}

// --- Subscription CRUD ---

type RegisterWebPushParams = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  baseDir?: string;
};

export async function registerWebPushSubscription(
  params: RegisterWebPushParams,
): Promise<WebPushSubscription> {
  const { endpoint, keys, baseDir } = params;

  if (!isValidWebPushEndpoint(endpoint)) {
    throw new Error("invalid push subscription endpoint: must be an HTTPS URL under 2048 chars");
  }
  if (!isValidWebPushKey(keys.p256dh) || !isValidWebPushKey(keys.auth)) {
    throw new Error("invalid push subscription keys: must be non-empty strings under 512 chars");
  }
  assertLegacyWebPushMigrationComplete(baseDir);

  return upsertWebPushSubscription({
    endpointHash: hashWebPushEndpoint(endpoint),
    endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
    candidateSubscriptionId: randomUUID(),
    nowMs: Date.now(),
    stateDir: baseDir,
  });
}

export async function clearWebPushSubscriptionByEndpoint(
  endpoint: string,
  baseDir?: string,
): Promise<boolean> {
  assertLegacyWebPushMigrationComplete(baseDir);
  return deleteWebPushSubscriptionByEndpoint({
    endpointHash: hashWebPushEndpoint(endpoint),
    endpoint,
    stateDir: baseDir,
  });
}

// --- Sending ---

type WebPushPayload = {
  title: string;
  body?: string;
  tag?: string;
  url?: string;
};

async function sendPreparedWebPushNotification(
  webPush: WebPushRuntime,
  subscription: WebPushSubscription,
  payload: WebPushPayload,
  vapidKeys: VapidKeyPair,
): Promise<WebPushSendResult> {
  const pushSubscription = {
    endpoint: subscription.endpoint,
    keys: {
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
    },
  };

  try {
    // Pass VAPID details per send instead of mutating shared global state via
    // setVapidDetails. Concurrent broadcasts then cannot clobber each other's
    // signing identity, and a single send never races another send's setup.
    const result = await webPush.sendNotification(pushSubscription, JSON.stringify(payload), {
      vapidDetails: {
        subject: vapidKeys.subject,
        publicKey: vapidKeys.publicKey,
        privateKey: vapidKeys.privateKey,
      },
    });
    return {
      ok: true,
      subscriptionId: subscription.subscriptionId,
      statusCode: result.statusCode,
    };
  } catch (err: unknown) {
    const statusCode =
      typeof err === "object" && err !== null && "statusCode" in err
        ? (err as { statusCode: number }).statusCode
        : undefined;
    const message =
      typeof err === "object" && err !== null && "message" in err
        ? (err as { message: string }).message
        : "unknown error";
    return {
      ok: false,
      subscriptionId: subscription.subscriptionId,
      statusCode,
      error: message,
    };
  }
}

export async function broadcastWebPush(
  payload: WebPushPayload,
  baseDir?: string,
): Promise<WebPushSendResult[]> {
  assertLegacyWebPushMigrationComplete(baseDir);
  const subscriptions = listWebPushSubscriptions(baseDir);
  if (subscriptions.length === 0) {
    return [];
  }

  const vapidKeys = await resolveVapidKeys(baseDir);
  const webPush = await loadWebPushRuntime();

  // Fan out through a bounded worker pool so a large subscriber list does not
  // open an unbounded number of concurrent push endpoints at once. Each send
  // carries its own VAPID details, so workers never mutate shared state.
  const { results: mapped } = await runTasksWithConcurrency({
    tasks: subscriptions.map(
      (subscription) => () =>
        sendPreparedWebPushNotification(webPush, subscription, payload, vapidKeys),
    ),
    limit: WEB_PUSH_SEND_CONCURRENCY,
  });

  // Clean up expired subscriptions (HTTP 410 Gone or 404 Not Found) per Web Push spec.
  const expiredSubscriptions = mapped
    .map((result, i) => ({ result, sub: subscriptions[i] }))
    .filter(({ result }) => !result.ok && (result.statusCode === 410 || result.statusCode === 404))
    .map(({ sub }) => expectDefined(sub, "push web sub"));

  for (const subscription of expiredSubscriptions) {
    try {
      assertLegacyWebPushMigrationComplete(baseDir);
      deleteWebPushSubscriptionIfCurrent({
        endpointHash: hashWebPushEndpoint(subscription.endpoint),
        subscription,
        stateDir: baseDir,
      });
    } catch {
      // Delivery already completed. Cleanup stays best-effort so callers do not retry valid sends.
    }
  }

  return mapped;
}
