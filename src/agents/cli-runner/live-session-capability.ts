import type {
  CliBackendLiveSessionCapability,
  CliBackendLiveSessionHandle,
} from "../../plugins/cli-backend.types.js";
import { resolveAdmittedRunActiveAssertion } from "../admitted-run-context.js";
import { FailoverError, resolveFailoverStatus } from "../failover-error.js";
import {
  beginCliLiveSessionCreate,
  buildCliLiveSessionKey,
  ensureCliLiveSessionCapacity,
  finishCliLiveSessionCreate,
  getCliLiveSession,
  registerCliLiveSession,
  removeCliLiveSession,
} from "./cli-live-session-registry.js";
import { buildCliLiveSessionFingerprint } from "./live-session-fingerprint.js";
import type { PreparedCliRunContext } from "./types.js";

type PrivateLiveCapture = {
  token: string;
  captureKey: string;
  revoke: () => void;
};

const processCaptures = new WeakMap<CliBackendLiveSessionHandle, PrivateLiveCapture>();

function requiredLiveSessionError(params: {
  context: PreparedCliRunContext;
  code: "cli_live_session_changed" | "cli_live_session_missing";
}): FailoverError {
  return new FailoverError("Managed CLI live session is no longer reusable.", {
    reason: "session_expired",
    provider: params.context.params.provider,
    model: params.context.modelId,
    status: resolveFailoverStatus("session_expired"),
    code: params.code,
  });
}

/** Creates host-owned lifecycle authority without exposing process bearer material to plugins. */
export function createCliLiveSessionCapability(params: {
  context: PreparedCliRunContext;
  argv: readonly string[];
  env: Record<string, string>;
  captureKey?: string;
  beginCapture: (captureKey: string | undefined) => void;
  abortSignal: AbortSignal;
  requiredGeneration?: string;
  claimResources?: () => (() => Promise<void>) | undefined;
}): CliBackendLiveSessionCapability {
  const ownerKey = buildCliLiveSessionKey(params.context);
  const fingerprint = buildCliLiveSessionFingerprint({
    context: params.context,
    argv: params.argv,
    env: params.env,
  });
  const grant = params.context.preparedBackend.mcpClientGrantCapture;
  if (Boolean(grant) !== Boolean(params.captureKey)) {
    throw new Error("CLI live process and current turn disagree about MCP capture ownership.");
  }

  const assertActive = () => {
    const assertion = resolveAdmittedRunActiveAssertion(
      params.context.params.admittedRunContext,
      params.abortSignal,
    );
    if (!assertion) {
      throw new Error("CLI live session turn is no longer active.");
    }
    assertion();
  };

  const requireRegisteredHandle = (handle: CliBackendLiveSessionHandle) => {
    assertActive();
    if (
      handle.key !== ownerKey ||
      handle.fingerprint !== fingerprint ||
      getCliLiveSession(ownerKey) !== handle
    ) {
      throw new Error("CLI live session no longer belongs to this admitted run.");
    }
    const requiredGeneration = params.requiredGeneration;
    if (requiredGeneration && requiredGeneration !== handle.generation) {
      throw requiredLiveSessionError({
        context: params.context,
        code: "cli_live_session_changed",
      });
    }
  };

  return Object.freeze({
    ownerKey,
    fingerprint,
    current: () => {
      assertActive();
      const handle = getCliLiveSession(ownerKey);
      const requiredGeneration = params.requiredGeneration;
      if (requiredGeneration && handle?.generation !== requiredGeneration) {
        throw requiredLiveSessionError({
          context: params.context,
          code: handle ? "cli_live_session_changed" : "cli_live_session_missing",
        });
      }
      return handle;
    },
    register: (handle) => {
      assertActive();
      if (params.requiredGeneration) {
        throw requiredLiveSessionError({
          context: params.context,
          code: "cli_live_session_changed",
        });
      }
      if (
        handle.key !== ownerKey ||
        handle.fingerprint !== fingerprint ||
        handle.providerId !== params.context.backendResolved.id ||
        handle.modelId !== params.context.normalizedModel ||
        !handle.generation.trim() ||
        getCliLiveSession(ownerKey)
      ) {
        throw new Error("CLI live session registration does not match its admitted owner.");
      }
      ensureCliLiveSessionCapacity(ownerKey, params.context);
      const pending = beginCliLiveSessionCreate(ownerKey, handle.generation);
      try {
        registerCliLiveSession(handle, pending, params.claimResources?.());
        if (getCliLiveSession(ownerKey) !== handle) {
          throw new Error("CLI live session closed before host registration completed.");
        }
        if (grant && params.captureKey) {
          processCaptures.set(handle, {
            token: grant.transportToken,
            captureKey: params.captureKey,
            revoke: grant.revokeProcessToken,
          });
        }
      } finally {
        finishCliLiveSessionCreate(ownerKey, pending);
      }
    },
    activate: (handle) => {
      requireRegisteredHandle(handle);
      const capture = processCaptures.get(handle);
      if (Boolean(capture) !== Boolean(grant)) {
        throw new Error("CLI live session MCP topology changed across admitted turns.");
      }
      if (capture && grant) {
        // Transfer the exact current admission before activating the original
        // child capture header; copied bearers never carry authority alone.
        grant.adoptProcessToken(capture.token);
        requireRegisteredHandle(handle);
        params.beginCapture(capture.captureKey);
      }
    },
    remove: (handle) => {
      if (getCliLiveSession(ownerKey) !== handle) {
        return;
      }
      processCaptures.get(handle)?.revoke();
      processCaptures.delete(handle);
      removeCliLiveSession(handle);
    },
  });
}
