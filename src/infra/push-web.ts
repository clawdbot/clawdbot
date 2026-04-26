import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import webPush from "web-push";
import { resolveStateDir } from "../config/paths.js";
import { createAsyncLock, readJsonFile, writeJsonAtomic } from "./json-files.js";

// --- Types ---

export type WebPushSubscription = {
  subscriptionId: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAtMs: number;
  updatedAtMs: number;
};

export type WebPushRegistrationState = {
  subscriptionsByEndpointHash: Record<string, WebPushSubscription>;
};

export type VapidKeyPair = {
  publicKey: string;
  privateKey: string;
  subject: string;
};

export type WebPushSendResult = {
  ok: boolean;
  subscriptionId: string;
  statusCode?: number;
  error?: string;
};

// --- Constants ---

const WEB_PUSH_STATE_FILENAME = "push/web-push-subscriptions.json";
const VAPID_KEYS_FILENAME = "push/vapid-keys.json";
const MAX_ENDPOINT_LENGTH = 2048;
const MAX_KEY_LENGTH = 512;
const DEFAULT_VAPID_SUBJECT = "mailto:openclaw@localhost";

const withLock = createAsyncLock();

// --- Helpers ---

function resolveWebPushStatePath(baseDir?: string): string {
  const root = baseDir ?? resolveStateDir();
  return path.join(root, WEB_PUSH_STATE_FILENAME);
}

function resolveVapidKeysPath(baseDir?: string): string {
  const root = baseDir ?? resolveStateDir();
  return path.join(root, VAPID_KEYS_FILENAME);
}

function hashEndpoint(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex").slice(0, 32);
}

function isValidEndpoint(endpoint: string): boolean {
  if (!endpoint || endpoint.length > MAX_ENDPOINT_LENGTH) {
    return false;
  }
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

function isValidKey(key: string): boolean {
  return typeof key === "string" && key.length > 0 && key.length <= MAX_KEY_LENGTH;
}

// --- State persistence ---

async function loadState(baseDir?: string): Promise<WebPushRegistrationState> {
  const filePath = resolveWebPushStatePath(baseDir);
  const state = await readJsonFile<WebPushRegistrationState>(filePath);
  return state ?? { subscriptionsByEndpointHash: {} };
}

async function persistState(state: WebPushRegistrationState, baseDir?: string): Promise<void> {
  const filePath = resolveWebPushStatePath(baseDir);
  await writeJsonAtomic(filePath, state, { trailingNewline: true });
}

// --- VAPID keys ---

export async function resolveVapidKeys(baseDir?: string): Promise<VapidKeyPair> {
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

  // Fall back to persisted keys, generating on first use under a lock to
  // prevent concurrent bootstraps from writing different keypairs.
  return await withLock(async () => {
    const filePath = resolveVapidKeysPath(baseDir);
    const existing = await readJsonFile<VapidKeyPair>(filePath);
    if (existing?.publicKey && existing?.privateKey) {
      return {
        publicKey: existing.publicKey,
        privateKey: existing.privateKey,
        // Env var always wins so operators can change subject without deleting vapid-keys.json.
        subject: resolveVapidSubjectFromEnv(),
      };
    }

    const keys = webPush.generateVAPIDKeys();
    const pair: VapidKeyPair = {
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      subject: resolveVapidSubjectFromEnv(),
    };
    await writeJsonAtomic(filePath, pair, { trailingNewline: true });
    return pair;
  });
}

function resolveVapidSubjectFromEnv(): string {
  return process.env.OPENCLAW_VAPID_SUBJECT || DEFAULT_VAPID_SUBJECT;
}

export function resolveVapidPublicKeyFromEnv(): string | undefined {
  return process.env.OPENCLAW_VAPID_PUBLIC_KEY || undefined;
}

export function resolveVapidPrivateKeyFromEnv(): string | undefined {
  return process.env.OPENCLAW_VAPID_PRIVATE_KEY || undefined;
}

// --- Subscription CRUD ---

export type RegisterWebPushParams = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  baseDir?: string;
};

export async function registerWebPushSubscription(
  params: RegisterWebPushParams,
): Promise<WebPushSubscription> {
  const { endpoint, keys, baseDir } = params;

  if (!isValidEndpoint(endpoint)) {
    throw new Error("invalid push subscription endpoint: must be an HTTPS URL under 2048 chars");
  }
  if (!isValidKey(keys.p256dh) || !isValidKey(keys.auth)) {
    throw new Error("invalid push subscription keys: must be non-empty strings under 512 chars");
  }

  return await withLock(async () => {
    const state = await loadState(baseDir);
    const hash = hashEndpoint(endpoint);
    const now = Date.now();

    const existing = state.subscriptionsByEndpointHash[hash];
    const subscription: WebPushSubscription = {
      subscriptionId: existing?.subscriptionId ?? randomUUID(),
      endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
      createdAtMs: existing?.createdAtMs ?? now,
      updatedAtMs: now,
    };

    state.subscriptionsByEndpointHash[hash] = subscription;
    await persistState(state, baseDir);
    return subscription;
  });
}

export async function loadWebPushSubscription(
  subscriptionId: string,
  baseDir?: string,
): Promise<WebPushSubscription | null> {
  const state = await loadState(baseDir);
  for (const sub of Object.values(state.subscriptionsByEndpointHash)) {
    if (sub.subscriptionId === subscriptionId) {
      return sub;
    }
  }
  return null;
}

export async function listWebPushSubscriptions(baseDir?: string): Promise<WebPushSubscription[]> {
  const state = await loadState(baseDir);
  return Object.values(state.subscriptionsByEndpointHash);
}

export async function clearWebPushSubscription(
  subscriptionId: string,
  baseDir?: string,
): Promise<boolean> {
  return await withLock(async () => {
    const state = await loadState(baseDir);
    for (const [hash, sub] of Object.entries(state.subscriptionsByEndpointHash)) {
      if (sub.subscriptionId === subscriptionId) {
        delete state.subscriptionsByEndpointHash[hash];
        await persistState(state, baseDir);
        return true;
      }
    }
    return false;
  });
}

export async function clearWebPushSubscriptionByEndpoint(
  endpoint: string,
  baseDir?: string,
): Promise<boolean> {
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const hash = hashEndpoint(endpoint);
    if (state.subscriptionsByEndpointHash[hash]) {
      delete state.subscriptionsByEndpointHash[hash];
      await persistState(state, baseDir);
      return true;
    }
    return false;
  });
}

// --- Sending ---

export type WebPushPayload = {
  title: string;
  body?: string;
  tag?: string;
  url?: string;
};

function applyVapidDetails(keys: VapidKeyPair): void {
  webPush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
}

export async function sendWebPushNotification(
  subscription: WebPushSubscription,
  payload: WebPushPayload,
  vapidKeys?: VapidKeyPair,
): Promise<WebPushSendResult> {
  const keys = vapidKeys ?? (await resolveVapidKeys());
  applyVapidDetails(keys);

  return sendPreparedWebPushNotification(subscription, payload);
}

async function sendPreparedWebPushNotification(
  subscription: WebPushSubscription,
  payload: WebPushPayload,
): Promise<WebPushSendResult> {
  const pushSubscription = {
    endpoint: subscription.endpoint,
    keys: {
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
    },
  };

  try {
    const result = await webPush.sendNotification(pushSubscription, JSON.stringify(payload));
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
  const subscriptions = await listWebPushSubscriptions(baseDir);
  if (subscriptions.length === 0) {
    return [];
  }

  const vapidKeys = await resolveVapidKeys(baseDir);

  // Set VAPID details once before fanning out concurrent sends.
  applyVapidDetails(vapidKeys);

  const results = await Promise.allSettled(
    subscriptions.map((sub) => sendPreparedWebPushNotification(sub, payload)),
  );

  const mapped = results.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : {
          ok: false,
          subscriptionId: subscriptions[i].subscriptionId,
          error: r.reason instanceof Error ? r.reason.message : "unknown error",
        },
  );

  // Clean up expired subscriptions (HTTP 410 Gone or 404 Not Found) per Web Push spec.
  const expiredEndpoints = mapped
    .map((result, i) => ({ result, sub: subscriptions[i] }))
    .filter(({ result }) => !result.ok && (result.statusCode === 410 || result.statusCode === 404))
    .map(({ sub }) => sub.endpoint);

  if (expiredEndpoints.length > 0) {
    await Promise.allSettled(
      expiredEndpoints.map((endpoint) => clearWebPushSubscriptionByEndpoint(endpoint, baseDir)),
    );
  }

  return mapped;
}
