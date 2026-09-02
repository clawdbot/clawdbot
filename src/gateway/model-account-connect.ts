import { randomUUID } from "node:crypto";
import type {
  UsersAuthConnectResult,
  UsersAuthConnectStartResult,
  UsersAuthConnectStatusResult,
  UsersListModelAccountsResult,
  UsersSelectModelAccountResult,
} from "../../packages/gateway-protocol/src/schema/users.js";
import type {
  AuthProfileCredential,
  OAuthCredential,
  TokenCredential,
} from "../agents/auth-profiles/types.js";
import {
  startOAuthLoopbackCallbackServer,
  type OAuthLoopbackCallbackServer,
} from "../infra/oauth-loopback-callback.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { loadActivatedBundledPluginPublicSurfaceModuleSync } from "../plugin-sdk/facade-runtime.js";
import { parseOAuthAuthorizationInput } from "../plugin-sdk/provider-oauth-runtime.js";
import {
  connectUserModelAccount,
  listUserModelAccounts,
  listUserProfileAuthLinks,
  readUserModelAccountSummary,
  setUserProfileAuthLink,
} from "../state/user-model-accounts.js";
import type { ModelAccountConnectAction } from "./model-account-authority.js";

type AuthorizationResult =
  | {
      status: "authorized";
      credential: OAuthCredential;
      matchesCredential: (existing: AuthProfileCredential) => boolean;
    }
  | { status: "failed"; reason: "exchange" | "identity" };
type ModelAccountAuthorization = {
  url: string;
  state: string;
  redirectUri: string;
  exchange: (code: string, signal: AbortSignal) => Promise<AuthorizationResult>;
};
type OperationStatus =
  | Exclude<UsersAuthConnectStatusResult, { status: "connected" }>
  | { status: "connected"; authProfileId: string };
type TerminalResult = Exclude<OperationStatus, { status: "pending" | "exchanging" }>;
type LiveOperation = {
  action: ModelAccountConnectAction;
  abort: AbortController;
  timeout: NodeJS.Timeout;
} & (
  | { phase: "starting" }
  | { phase: "pending"; authorization: ModelAccountAuthorization }
  | { phase: "exchanging"; result: Promise<OperationStatus> }
);
type ConnectOperation = {
  id: string;
  owner: string;
  provider: string;
  expiresAtMs: number;
  callback?: OAuthLoopbackCallbackServer;
  state: LiveOperation | { phase: "terminal"; result: TerminalResult };
};

const CONNECT_TTL_MS = 15 * 60 * 1_000;
const MAX_ACTIVE_CONNECTS = 8;
const MAX_RETAINED_CONNECTS = 64;

export class ModelAccountConnectAuthorityError extends Error {
  constructor() {
    super("This account action requires a current authorized connection; reconnect and try again.");
  }
}

export class ModelAccountConnectInputError extends Error {
  constructor(
    message = "That redirect does not match this sign-in; paste the full URL from the localhost tab.",
  ) {
    super(message);
  }
}

/** One Gateway lifetime owns pending authorizations, cancellation, and their recorded outcomes. */
export function createModelAccountConnectService(options: { onChanged?: () => void } = {}) {
  const operations = new Map<string, ConnectOperation>();
  const callbacks = new Set<Promise<void>>();
  const closingCallbacks = new Set<Promise<void>>();
  let stopped = false;

  const track = (set: Set<Promise<void>>, promise: Promise<void>) => {
    const tracked: Promise<void> = promise
      .catch(() => undefined)
      .finally(() => set.delete(tracked));
    set.add(tracked);
  };
  const finish = (operation: ConnectOperation, result: TerminalResult): TerminalResult => {
    if (operation.state.phase === "terminal") {
      return operation.state.result;
    }
    const live = operation.state;
    operation.state = { phase: "terminal", result };
    clearTimeout(live.timeout);
    // Revoke the operation before aborting its I/O: late provider and callback
    // continuations must observe the terminal result, never regain write authority.
    live.abort.abort();
    if (operation.callback) {
      track(closingCallbacks, operation.callback.close());
      delete operation.callback;
    }
    return result;
  };
  const snapshot = (operation: ConnectOperation): OperationStatus => {
    if (operation.state.phase === "terminal") {
      return operation.state.result;
    }
    if (operation.expiresAtMs <= Date.now()) {
      return finish(operation, { status: "expired" });
    }
    try {
      operation.state.action.assertCurrent();
    } catch {
      return finish(operation, { status: "failed", reason: "authority" });
    }
    return { status: operation.state.phase === "exchanging" ? "exchanging" : "pending" };
  };
  const assertRunning = (action: ModelAccountConnectAction) => {
    if (stopped) {
      throw new ModelAccountConnectAuthorityError();
    }
    action.assertCurrent();
  };
  const projectResult = (
    action: ModelAccountConnectAction,
    operation: ConnectOperation,
    result: OperationStatus = snapshot(operation),
  ): UsersAuthConnectStatusResult => {
    if (result.status !== "connected") {
      return result;
    }
    // Retain what this operation committed, but read current links at the
    // authorized response boundary so replay cannot undo a newer link change.
    assertRunning(action);
    return { ...result, links: listUserProfileAuthLinks(operation.owner) };
  };
  const assertLive = (operation: ConnectOperation) => {
    if (
      stopped ||
      operations.get(operation.id) !== operation ||
      !["pending", "exchanging"].includes(snapshot(operation).status)
    ) {
      throw new ModelAccountConnectAuthorityError();
    }
  };
  const findOperation = (action: ModelAccountConnectAction, connectId: string) => {
    assertRunning(action);
    const operation = operations.get(connectId);
    return operation?.owner === action.owner ? operation : undefined;
  };
  const supersede = (owner: string, provider: string) => {
    for (const operation of operations.values()) {
      if (operation.owner === owner && operation.provider === provider) {
        finish(operation, { status: "cancelled" });
      }
    }
  };

  const exchange = (
    operation: ConnectOperation,
    code: string,
    completingAction?: ModelAccountConnectAction,
  ): Promise<OperationStatus> => {
    const current = snapshot(operation);
    if (operation.state.phase !== "pending") {
      return operation.state.phase === "exchanging"
        ? operation.state.result
        : Promise.resolve(current);
    }
    const pending = operation.state;
    const assertCurrent = () => {
      assertLive(operation);
      completingAction?.assertCurrent();
    };
    const result = Promise.resolve().then(async (): Promise<OperationStatus> => {
      let failure: "exchange" | "unavailable" = "exchange";
      try {
        assertCurrent();
        const authorized = await pending.authorization.exchange(code, pending.abort.signal);
        assertCurrent();
        if (authorized.status === "failed") {
          return finish(operation, authorized);
        }
        failure = "unavailable";
        // Persistence calls this same guard inside its synchronous transaction.
        // No await separates the committed link from its recorded connected outcome.
        const connected = connectUserModelAccount({
          ownerProfileId: operation.owner,
          credential: authorized.credential,
          matchesCredential: authorized.matchesCredential,
          assertCurrent,
        });
        const outcome = finish(operation, {
          status: "connected",
          authProfileId: connected.authProfileId,
        });
        options.onChanged?.();
        return outcome;
      } catch (error) {
        const observed = snapshot(operation);
        if (observed.status !== "pending" && observed.status !== "exchanging") {
          return observed;
        }
        return finish(operation, {
          status: "failed",
          reason: error instanceof ModelAccountConnectAuthorityError ? "authority" : failure,
        });
      }
    });
    operation.state = { ...pending, phase: "exchanging", result };
    return result;
  };

  return {
    list(action: ModelAccountConnectAction, cursor?: string): UsersListModelAccountsResult {
      assertRunning(action);
      return {
        profileId: action.owner,
        ...listUserModelAccounts({ profileId: action.owner, cursor }),
        links: listUserProfileAuthLinks(action.owner),
      };
    },
    select(
      action: ModelAccountConnectAction,
      authProfileId: string,
    ): UsersSelectModelAccountResult {
      assertRunning(action);
      const account = readUserModelAccountSummary({ profileId: action.owner, authProfileId });
      if (!account) {
        throw new ModelAccountConnectInputError(
          "Select an account from your personal model account list, or connect it first.",
        );
      }
      const links = setUserProfileAuthLink({
        profileId: action.owner,
        provider: account.provider,
        authProfileId,
        assertCurrent: () => assertRunning(action),
      });
      supersede(action.owner, account.provider);
      options.onChanged?.();
      return { links };
    },
    async start(
      action: ModelAccountConnectAction,
      provider: string,
    ): Promise<UsersAuthConnectStartResult> {
      assertRunning(action);
      for (const operation of operations.values()) {
        snapshot(operation);
      }
      supersede(action.owner, provider);
      const active = [...operations.values()].filter(({ state }) => state.phase !== "terminal");
      if (active.length >= MAX_ACTIVE_CONNECTS) {
        throw new Error("Too many model-account sign-ins are in progress; try again shortly.");
      }
      for (const [id, operation] of operations) {
        if (operations.size < MAX_RETAINED_CONNECTS) {
          break;
        }
        if (operation.state.phase === "terminal") {
          operations.delete(id);
        }
      }
      const id = randomUUID();
      const timeout = setTimeout(() => finish(operation, { status: "expired" }), CONNECT_TTL_MS);
      const operation: ConnectOperation = {
        id,
        owner: action.owner,
        provider,
        expiresAtMs: Date.now() + CONNECT_TTL_MS,
        state: {
          phase: "starting",
          action,
          abort: new AbortController(),
          timeout,
        },
      };
      timeout.unref();
      operations.set(id, operation);
      try {
        // A replaced flow may still be releasing the provider's fixed callback port.
        await Promise.allSettled(closingCallbacks);
        assertLive(operation);
        const facade = loadActivatedBundledPluginPublicSurfaceModuleSync<{
          createModelAccountAuthorization: () => Promise<ModelAccountAuthorization>;
        }>({ dirName: provider, artifactBasename: "api.js" });
        const authorization = await facade.createModelAccountAuthorization();
        assertLive(operation);
        if (operation.state.phase !== "starting") {
          throw new ModelAccountConnectAuthorityError();
        }
        operation.state = { ...operation.state, phase: "pending", authorization };
        let autoCallback = false;
        try {
          operation.callback = await startOAuthLoopbackCallbackServer({
            redirectUrl: authorization.redirectUri,
            expectedState: authorization.state,
            timeoutMs: operation.expiresAtMs - Date.now(),
            signal: operation.state.abort.signal,
            renderSuccess: () => ({
              body: "Authorization received. Return to your OpenClaw profile to see the connection result.",
              contentType: "text/plain; charset=utf-8",
            }),
          });
          autoCallback = true;
          track(
            callbacks,
            operation.callback
              .waitForCallback()
              .then((callback) => {
                if (callback.type === "authorization_code") {
                  registerSecretValueForRedaction(callback.code);
                  void exchange(operation, callback.code).catch(() => {
                    finish(operation, { status: "failed", reason: "unavailable" });
                  });
                } else {
                  finish(operation, { status: "failed", reason: "exchange" });
                }
              })
              .catch(() => {
                snapshot(operation);
                finish(operation, { status: "failed", reason: "unavailable" });
              }),
          );
        } catch {
          // A CLI or another sign-in can own the fixed loopback port. The exact
          // pending operation remains completable through the documented paste route.
        }
        assertLive(operation);
        return {
          connectId: id,
          url: authorization.url,
          expiresAtMs: operation.expiresAtMs,
          autoCallback,
        };
      } catch (error) {
        snapshot(operation);
        finish(operation, {
          status: "failed",
          reason: error instanceof ModelAccountConnectAuthorityError ? "authority" : "unavailable",
        });
        throw error;
      }
    },
    status(action: ModelAccountConnectAction, connectId: string): UsersAuthConnectStatusResult {
      const operation = findOperation(action, connectId);
      return operation ? projectResult(action, operation) : { status: "expired" };
    },
    cancel(action: ModelAccountConnectAction, connectId: string): UsersAuthConnectStatusResult {
      const operation = findOperation(action, connectId);
      if (!operation) {
        return { status: "expired" };
      }
      snapshot(operation);
      return projectResult(action, operation, finish(operation, { status: "cancelled" }));
    },
    supersede,
    async complete(
      action: ModelAccountConnectAction,
      connectId: string,
      redirectInput: string,
    ): Promise<UsersAuthConnectStatusResult> {
      const operation = findOperation(action, connectId);
      if (!operation) {
        return { status: "expired" };
      }
      const result = snapshot(operation);
      if (operation.state.phase !== "pending") {
        return projectResult(action, operation, result);
      }
      const parsed = parseOAuthAuthorizationInput(redirectInput);
      if (!parsed.code || parsed.state !== operation.state.authorization.state) {
        throw new ModelAccountConnectInputError();
      }
      registerSecretValueForRedaction(parsed.code);
      return projectResult(action, operation, await exchange(operation, parsed.code, action));
    },
    token(
      action: ModelAccountConnectAction,
      credential: TokenCredential & { token: string },
    ): UsersAuthConnectResult {
      const assertCurrent = () => assertRunning(action);
      assertCurrent();
      const connected = connectUserModelAccount({
        ownerProfileId: action.owner,
        credential,
        // An opaque token cannot prove that a changed value belongs to the
        // same account. Keep older session pins on their original credential.
        matchesCredential: (existing) =>
          existing.type === "token" &&
          existing.provider === credential.provider &&
          existing.token === credential.token,
        assertCurrent,
      });
      supersede(action.owner, credential.provider);
      options.onChanged?.();
      return connected;
    },
    async stop(): Promise<void> {
      stopped = true;
      for (const operation of operations.values()) {
        finish(operation, { status: "cancelled" });
      }
      // Remote exchange may ignore abort; its closed operation can no longer
      // commit. Shutdown drains local sockets, never waits on that remote I/O.
      await Promise.allSettled([...callbacks, ...closingCallbacks]);
      operations.clear();
    },
  };
}
