import { randomRelayBase64Url } from "./relay-auth-v2-crypto.js";
import { ACCESS_MODE_ALL, parsePairingString } from "./relay-core.js";

const NATIVE_HOST_NAME = "ai.openclaw.browser_bootstrap";
const DISABLED_KEY = "nativeBootstrapDisabled";
const STATE_KEY = "nativeBootstrapState";
const FAILURE_KEY = "nativeBootstrapFailureCode";
const NATIVE_MESSAGE_TIMEOUT_MS = 30_000;
const NATIVE_MESSAGE_TIMEOUT = Symbol("native_message_timeout");
const RETRYABLE_HOST_ERRORS = [
  "native messaging host not found",
  "specified native messaging host not found",
  "failed to start native messaging host",
];

const FAILURE_CODES = new Set([
  "invalid_frame",
  "invalid_utf8",
  "invalid_request",
  "origin_forbidden",
  "manifest_invalid",
  "manual_required",
  "pairing_unavailable",
]);

function hasExactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function nativeResponse(value, nonce) {
  if (
    hasExactKeys(value, ["v", "ok", "nonce", "pairingString"]) &&
    value.v === 1 &&
    value.ok === true &&
    value.nonce === nonce &&
    typeof value.pairingString === "string"
  ) {
    const pairing = parsePairingString(value.pairingString);
    return pairing ? { kind: "success", pairing } : { kind: "malformed" };
  }
  if (
    hasExactKeys(value, ["v", "ok", "code"]) &&
    value.v === 1 &&
    value.ok === false &&
    FAILURE_CODES.has(value.code)
  ) {
    return { kind: "failure", code: value.code };
  }
  return { kind: "malformed" };
}

function isHostMissing(error) {
  const message = String(error?.message ?? error).toLowerCase();
  return RETRYABLE_HOST_ERRORS.some((candidate) => message.includes(candidate));
}

function sendNativeBootstrap(chromeApi, request) {
  return new Promise((resolve, reject) => {
    const port = chromeApi.runtime.connectNative(NATIVE_HOST_NAME);
    let settled = false;
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      port.disconnect();
      callback(value);
    };
    const timeoutId = setTimeout(
      () => finish(reject, NATIVE_MESSAGE_TIMEOUT),
      NATIVE_MESSAGE_TIMEOUT_MS,
    );
    port.onMessage.addListener((response) => finish(resolve, response));
    port.onDisconnect.addListener(() => {
      const message = chromeApi.runtime.lastError?.message;
      finish(reject, new Error(message || "Native messaging host disconnected."));
    });
    try {
      port.postMessage(request);
    } catch (error) {
      finish(reject, error);
    }
  });
}

const RELAY_ENSURE_STATUSES = new Set(["spawned", "running", "skipped"]);

/** Ask the native host to start the standalone relay daemon when nothing serves the relay port. */
export async function requestRelayEnsure(relayPort, chromeApi = chrome) {
  const nonce = randomRelayBase64Url(crypto, 16);
  let response;
  try {
    response = await sendNativeBootstrap(chromeApi, { v: 1, op: "ensure_relay", nonce, relayPort });
  } catch {
    return { status: "unavailable" };
  }
  if (
    hasExactKeys(response, ["v", "ok", "nonce", "relay"]) &&
    response.v === 1 &&
    response.ok === true &&
    response.nonce === nonce &&
    RELAY_ENSURE_STATUSES.has(response.relay)
  ) {
    return { status: response.relay };
  }
  return { status: "unavailable" };
}

/** Own coalescing, retry policy, opt-out, and late-response revocation. */
export function createNativeBootstrapController({ chromeApi = chrome, getPairing, applyPairing }) {
  let inFlight = null;
  let disabledNow = false;
  let generation = 0;

  async function readState() {
    const stored = await chromeApi.storage.local.get([DISABLED_KEY, STATE_KEY, FAILURE_KEY]);
    disabledNow ||= stored[DISABLED_KEY] === true;
    return {
      disabled: disabledNow,
      state:
        stored[STATE_KEY] === "ready" ||
        stored[STATE_KEY] === "retrying" ||
        stored[STATE_KEY] === "manual_required" ||
        stored[STATE_KEY] === "disabled"
          ? stored[STATE_KEY]
          : "waiting",
      failureCode: typeof stored[FAILURE_KEY] === "string" ? stored[FAILURE_KEY] : "",
    };
  }

  async function writeState(state, failureCode = "") {
    await chromeApi.storage.local.set({
      [STATE_KEY]: state,
      ...(failureCode ? { [FAILURE_KEY]: failureCode } : {}),
    });
    if (!failureCode) {
      await chromeApi.storage.local.remove([FAILURE_KEY]);
    }
  }

  async function attempt() {
    if (inFlight) {
      return await inFlight;
    }
    const ownedGeneration = generation;
    inFlight = (async () => {
      const pairing = await getPairing();
      if (pairing?.relayUrl) {
        await writeState("ready");
        return { status: "existing" };
      }
      const state = await readState();
      if (disabledNow) {
        return { status: "disabled" };
      }
      if (state.state === "manual_required") {
        return { status: "manual_required", code: state.failureCode };
      }
      const nonce = randomRelayBase64Url(crypto, 16);
      let response;
      try {
        response = await sendNativeBootstrap(chromeApi, {
          v: 1,
          op: "bootstrap",
          nonce,
        });
      } catch (error) {
        if (error === NATIVE_MESSAGE_TIMEOUT || isHostMissing(error)) {
          const code = error === NATIVE_MESSAGE_TIMEOUT ? "native_host_timeout" : "host_not_found";
          await writeState("retrying", code);
          return { status: "retrying", code };
        }
        await writeState("manual_required", "native_host_error");
        return { status: "manual_required", code: "native_host_error" };
      }
      if (ownedGeneration !== generation || disabledNow) {
        return { status: "superseded" };
      }
      const parsed = nativeResponse(response, nonce);
      if (parsed.kind === "malformed") {
        await writeState("manual_required", "malformed_response");
        return { status: "manual_required", code: "malformed_response" };
      }
      if (parsed.kind === "failure") {
        const retrying = parsed.code === "pairing_unavailable";
        await writeState(retrying ? "retrying" : "manual_required", parsed.code);
        return { status: retrying ? "retrying" : "manual_required", code: parsed.code };
      }
      const current = await getPairing();
      if (current?.relayUrl || ownedGeneration !== generation || disabledNow) {
        return { status: "superseded" };
      }
      const applied = await applyPairing({
        pairing: parsed.pairing,
        accessMode: ACCESS_MODE_ALL,
        source: "native",
        generation: ownedGeneration,
      });
      if (!applied?.ok) {
        if (applied?.existing) {
          return { status: "existing" };
        }
        await writeState("manual_required", "pairing_rejected");
        return { status: "manual_required", code: "pairing_rejected" };
      }
      await writeState("ready");
      return { status: "paired" };
    })().finally(() => {
      inFlight = null;
    });
    return await inFlight;
  }

  function disableSynchronously() {
    disabledNow = true;
    generation += 1;
    return chromeApi.storage.local.set({
      [DISABLED_KEY]: true,
      [STATE_KEY]: "disabled",
    });
  }

  async function enable({ attemptNow = true } = {}) {
    disabledNow = false;
    generation += 1;
    await chromeApi.storage.local.remove([DISABLED_KEY, STATE_KEY, FAILURE_KEY]);
    return attemptNow ? await attempt() : { status: "enabled" };
  }

  async function status() {
    const pairing = await getPairing();
    const state = await readState();
    return {
      disabled: state.disabled,
      state: pairing?.relayUrl ? "ready" : state.state,
      ...(state.failureCode ? { failureCode: state.failureCode } : {}),
    };
  }

  return { attempt, disableSynchronously, enable, status };
}

const COPILOT_LOCAL_KEYS = [
  "copilotSessionRegistryV1",
  "copilotDeviceIdentitiesV1",
  "copilotDeviceTokensV1",
];
const COPILOT_SESSION_KEYS = ["copilotBrowserInstanceV1", "copilotPanelBindingsV1"];
const RETIRED_COPILOT_CUSTODY_BLOCKED_KEY = "retiredCopilotCustodyBlockedV1";

function canClearRetiredCopilotRegistry(value) {
  return (
    hasExactKeys(value, ["sessions", "pendingArchives"]) &&
    value.sessions !== null &&
    typeof value.sessions === "object" &&
    !Array.isArray(value.sessions) &&
    Object.keys(value.sessions).length === 0 &&
    Array.isArray(value.pendingArchives) &&
    value.pendingArchives.length === 0
  );
}

/** Explicitly discard every retired copilot key. */
export async function discardRetiredCopilotState(chromeApi = chrome) {
  await chromeApi.storage.local.set({ [RETIRED_COPILOT_CUSTODY_BLOCKED_KEY]: true });
  await chromeApi.storage.session.remove(COPILOT_SESSION_KEYS);
  await chromeApi.storage.local.remove(COPILOT_LOCAL_KEYS);
  await chromeApi.storage.local.remove([RETIRED_COPILOT_CUSTODY_BLOCKED_KEY]);
}

/** Clear harmless retired state, or preserve custody and fail closed. */
export async function prepareRetiredCopilotState(chromeApi = chrome) {
  let stored;
  try {
    stored = await chromeApi.storage.local.get([
      RETIRED_COPILOT_CUSTODY_BLOCKED_KEY,
      COPILOT_LOCAL_KEYS[0],
    ]);
  } catch {
    return { blocked: true };
  }
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) {
    return { blocked: true };
  }
  if (Object.hasOwn(stored, RETIRED_COPILOT_CUSTODY_BLOCKED_KEY)) {
    return { blocked: true };
  }
  if (
    Object.hasOwn(stored, COPILOT_LOCAL_KEYS[0]) &&
    !canClearRetiredCopilotRegistry(stored[COPILOT_LOCAL_KEYS[0]])
  ) {
    return { blocked: true };
  }
  try {
    await discardRetiredCopilotState(chromeApi);
  } catch {
    return { blocked: true };
  }
  return { blocked: false };
}
