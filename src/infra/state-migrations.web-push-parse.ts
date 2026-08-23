// Parsing for the retired Web Push JSON stores: raw legacy file contents in,
// validated domain shapes out. Doctor-only, split from
// state-migrations.web-push.ts which owns detection/claiming/DB import.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  createWebPushVapidKeyPair,
  hashWebPushEndpoint,
  isValidWebPushEndpoint,
  isValidWebPushKey,
  DEFAULT_WEB_PUSH_VAPID_SUBJECT,
  type VapidKeyPair,
  type WebPushSubscription,
} from "./push-web-store.js";

const SUBSCRIPTION_STORE_KEYS = new Set(["subscriptionsByEndpointHash"]);
const SUBSCRIPTION_KEYS = new Set([
  "subscriptionId",
  "endpoint",
  "keys",
  "createdAtMs",
  "updatedAtMs",
]);
const PUSH_KEYS = new Set(["p256dh", "auth"]);
const VAPID_KEYS = new Set(["publicKey", "privateKey", "subject"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
) {
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) {
    throw new Error(`${label} has unexpected field ${unexpected}`);
  }
}

export function parseLegacySubscriptions(raw: string): Map<string, WebPushSubscription> {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || !isRecord(parsed.subscriptionsByEndpointHash)) {
    throw new Error("legacy Web Push subscriptions must be an object");
  }
  assertOnlyKeys(parsed, SUBSCRIPTION_STORE_KEYS, "legacy Web Push subscriptions store");

  const subscriptions = new Map<string, WebPushSubscription>();
  const subscriptionIds = new Set<string>();
  for (const [endpointHash, rawSubscription] of Object.entries(
    parsed.subscriptionsByEndpointHash,
  )) {
    if (!isRecord(rawSubscription) || !isRecord(rawSubscription.keys)) {
      throw new Error("legacy Web Push subscription is not an object");
    }
    assertOnlyKeys(rawSubscription, SUBSCRIPTION_KEYS, "legacy Web Push subscription");
    assertOnlyKeys(rawSubscription.keys, PUSH_KEYS, "legacy Web Push subscription keys");
    const { subscriptionId, endpoint, createdAtMs, updatedAtMs } = rawSubscription;
    const p256dh = rawSubscription.keys.p256dh;
    const auth = rawSubscription.keys.auth;
    if (
      typeof subscriptionId !== "string" ||
      !UUID_RE.test(subscriptionId) ||
      typeof endpoint !== "string" ||
      !isValidWebPushEndpoint(endpoint) ||
      hashWebPushEndpoint(endpoint) !== endpointHash ||
      !isValidWebPushKey(p256dh) ||
      !isValidWebPushKey(auth) ||
      typeof createdAtMs !== "number" ||
      !Number.isSafeInteger(createdAtMs) ||
      createdAtMs < 0 ||
      typeof updatedAtMs !== "number" ||
      !Number.isSafeInteger(updatedAtMs) ||
      updatedAtMs < createdAtMs
    ) {
      throw new Error("legacy Web Push subscription is invalid");
    }
    if (subscriptionIds.has(subscriptionId)) {
      throw new Error("legacy Web Push subscriptions contain a duplicate subscription id");
    }
    subscriptionIds.add(subscriptionId);
    subscriptions.set(endpointHash, {
      subscriptionId,
      endpoint,
      keys: { p256dh, auth },
      createdAtMs,
      updatedAtMs,
    });
  }
  return subscriptions;
}

export function parseLegacyVapidKeys(raw: string, env: NodeJS.ProcessEnv): VapidKeyPair {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("legacy Web Push VAPID keys must be an object");
  }
  assertOnlyKeys(parsed, VAPID_KEYS, "legacy Web Push VAPID keys");
  if (parsed.subject !== undefined && typeof parsed.subject !== "string") {
    throw new Error("legacy Web Push VAPID keys are invalid");
  }
  const subject =
    normalizeOptionalString(parsed.subject) ??
    normalizeOptionalString(env.OPENCLAW_VAPID_SUBJECT) ??
    DEFAULT_WEB_PUSH_VAPID_SUBJECT;
  if (
    !isValidWebPushKey(parsed.publicKey) ||
    !isValidWebPushKey(parsed.privateKey) ||
    subject.length > 512
  ) {
    throw new Error("legacy Web Push VAPID keys are invalid");
  }
  return createWebPushVapidKeyPair(parsed.publicKey, parsed.privateKey, subject);
}
