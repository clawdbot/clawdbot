import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type {
  PersonalGitHubStatus,
  UsersGitHubAuthorizePollResult,
  UsersGitHubAuthorizeStartResult,
} from "../../packages/gateway-protocol/src/schema/users.js";
import {
  refreshGitHubOAuthToken,
  type GitHubOAuthTokenPair,
} from "../agents/github-oauth-client.js";
import {
  createManagedGitHubProfileId,
  installManagedGitHubProfile,
  preparePersonalGitHubPublicationIdentity,
  refreshManagedGitHubProfile,
  removeManagedGitHubProfile,
  resolveManagedGitHubProfileDir,
  resolveManagedGitHubProfileRoot,
} from "../agents/github-tool-identity.js";
import { hasErrnoCode } from "../infra/errno.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import { withOpenClawStateLease } from "../state/openclaw-state-lease.js";
import {
  disconnectedUserGitHubConnection,
  disconnectUserGitHubConnection,
  listUserGitHubConnections,
  observeUserGitHubProfileRetirement,
  readUserGitHubConnection,
  resolvePersonalGitHubOwner,
  updateUserGitHubConnection,
  updateUserGitHubRefresh,
  type UserGitHubConnection,
  type UserGitHubConnected,
  type UserGitHubDevice,
} from "../state/user-github-connections.js";
import { assertGitHubCliAvailable } from "./github-cli-preflight.js";
import { pollGitHubDeviceFlow, startGitHubDeviceFlow } from "./github-oauth-device-flow.js";

export type PersonalGitHubAction = { owner: string; assertCurrent: () => void };
const profileDir = (profileId: string) =>
  resolveManagedGitHubProfileDir({ agentId: "", scope: "personal", profileId });
const withProfileLease = <T>(profileId: string, run: (assertOwned: () => void) => Promise<T>) =>
  withOpenClawStateLease(
    {
      scope: "personal-github-profile",
      key: profileId,
      database: { scope: "shared" },
      leaseMs: 60000,
      waitMs: 30000,
    },
    async (lease) => await run(() => lease.assertOwned()),
  );

function projectPending(pending: UserGitHubDevice): UsersGitHubAuthorizeStartResult {
  return {
    requestId: pending.requestId,
    userCode: pending.userCode,
    verificationUri: pending.verificationUri,
    expiresInMs: Math.max(0, pending.expiresAtMs - Date.now()),
    pollAfterMs: Math.max(1, Math.min(60000, pending.nextPollAtMs - Date.now())),
  };
}

export function personalGitHubStatus(action: PersonalGitHubAction): PersonalGitHubStatus {
  action.assertCurrent();
  let record: UserGitHubConnection | undefined;
  try {
    record = readUserGitHubConnection(action.owner);
  } catch {
    action.assertCurrent();
    return {
      state: "unavailable",
      generation: null,
      account: null,
      accessExpiresAtMs: null,
      refreshState: "failed",
      pending: null,
    };
  }
  const selection = record?.selection;
  const connected = selection?.kind === "connected" ? selection : undefined;
  return {
    state: connected ? "connected" : "disconnected",
    generation: record?.generation ?? null,
    account: connected ? { accountId: connected.accountId, login: connected.login } : null,
    accessExpiresAtMs: connected?.accessExpiresAtMs ?? null,
    refreshState: !connected
      ? "not_applicable"
      : connected.refresh
        ? "refreshing"
        : (connected.refreshFailure ??
          (connected.refreshExpiresAtMs <= Date.now() ? "expired" : "available")),
    pending:
      record?.pending?.kind === "device" && record.pending.expiresAtMs > Date.now()
        ? projectPending(record.pending)
        : null,
  };
}

async function resolvePersonalGitHubStatus(
  action: PersonalGitHubAction,
): Promise<PersonalGitHubStatus> {
  const status = personalGitHubStatus(action);
  if (status.state !== "connected") {
    return status;
  }
  const record = readUserGitHubConnection(action.owner);
  if (record?.selection.kind !== "connected") {
    return { ...status, state: "unavailable" };
  }
  const assertCurrent = () => {
    action.assertCurrent();
    if (readUserGitHubConnection(action.owner)?.generation !== record.generation) {
      throw new Error("My GitHub connection changed; reload its status.");
    }
  };
  try {
    // Receipts use the durable selection above; live status must additionally
    // prove the selected profile can authenticate without borrowing native auth.
    await preparePersonalGitHubPublicationIdentity({
      profileId: record.selection.profileId,
      accountId: record.selection.accountId,
      assertCurrent,
    });
    assertCurrent();
    return status;
  } catch {
    assertCurrent();
    return { ...status, state: "unavailable" };
  }
}

function requirePending(
  record: UserGitHubConnection | undefined,
  generation: string,
  requestId: string,
): UserGitHubConnection & { pending: NonNullable<UserGitHubConnection["pending"]> } {
  if (
    !record?.pending ||
    record.generation !== generation ||
    record.pending.requestId !== requestId ||
    record.pending.expiresAtMs <= Date.now()
  ) {
    throw new Error("My GitHub authorization changed or expired; start again.");
  }
  return { ...record, pending: record.pending };
}

function rotatedSelection(
  selection: UserGitHubConnected,
  tokens: GitHubOAuthTokenPair,
  receivedAtMs: number,
): UserGitHubConnected {
  return {
    ...selection,
    refreshToken: tokens.refreshToken,
    scopes: tokens.scopes,
    accessExpiresAtMs: receivedAtMs + tokens.expiresInSeconds * 1000,
    refreshExpiresAtMs: receivedAtMs + tokens.refreshTokenExpiresInSeconds * 1000,
    refreshFailure: undefined,
  };
}

/** Personal adapters share device transport and profile materialization with System/agent OAuth. */
export function createPersonalGitHubOAuthLifecycle() {
  const abort = new AbortController();
  const polls = new Map<string, Promise<UsersGitHubAuthorizePollResult>>();
  const refreshes = new Map<string, Promise<void>>();
  const rotated = new Map<
    string,
    {
      owner: string;
      profileId: string;
      operationId: string;
      tokens: GitHubOAuthTokenPair;
      receivedAtMs: number;
    }
  >();
  const retirements = new Set<string>();
  const cleanups = new Map<string, Promise<void>>();
  let stopped = false;
  let inspectedProfiles = false;
  const profileIsReferenced = (id: string) =>
    listUserGitHubConnections().some(
      ({ connection }) =>
        (connection.selection.kind === "connected" && connection.selection.profileId === id) ||
        (connection.pending?.kind === "device" && connection.pending.candidate?.profileId === id),
    );
  const assertRunning = () => {
    if (stopped) {
      throw new Error("GitHub authorization is stopping.");
    }
  };
  const retire = async (id: string) => {
    await getOrCreatePromise(
      cleanups,
      id,
      () =>
        withProfileLease(id, async (assertOwned) => {
          assertOwned();
          if (profileIsReferenced(id)) {
            return;
          }
          await removeManagedGitHubProfile(profileDir(id));
        }).then(
          () => {
            retirements.delete(id);
          },
          () => {
            retirements.add(id);
          },
        ),
      { evictOnSettled: true },
    );
  };
  const unobserve = observeUserGitHubProfileRetirement((ids) => {
    for (const id of ids) {
      retirements.add(id);
      void retire(id);
    }
  });
  const guard = (action: PersonalGitHubAction) => {
    assertRunning();
    action.assertCurrent();
  };

  const install = async (
    action: PersonalGitHubAction,
    generation: string,
    pending: UserGitHubDevice,
  ): Promise<UsersGitHubAuthorizePollResult> => {
    const candidate = pending.candidate;
    if (!candidate) {
      throw new Error("My GitHub authorization has no candidate.");
    }
    const assertCurrent = () => {
      guard(action);
      const record = requirePending(
        readUserGitHubConnection(action.owner),
        generation,
        pending.requestId,
      );
      if (
        record.pending.kind !== "device" ||
        record.pending.candidate?.profileId !== candidate.profileId
      ) {
        throw new Error("My GitHub authorization changed.");
      }
    };
    try {
      await withProfileLease(candidate.profileId, async (assertOwned) => {
        const assertInstall = () => {
          assertOwned();
          assertCurrent();
        };
        assertInstall();
        // A prior attempt may have materialized the inactive candidate before losing its response.
        await removeManagedGitHubProfile(profileDir(candidate.profileId));
        assertInstall();
        await installManagedGitHubProfile({
          profileDir: profileDir(candidate.profileId),
          token: candidate.tokens.accessToken,
          assertCurrent: assertInstall,
          commitConfig: async (account) => {
            updateUserGitHubConnection(
              action.owner,
              (current) => {
                const owned = requirePending(current, generation, pending.requestId);
                return {
                  ...owned,
                  generation: randomUUID(),
                  pending: undefined,
                  selection: {
                    kind: "connected",
                    profileId: candidate.profileId,
                    accountId: account.accountId,
                    login: account.login,
                    refreshToken: candidate.tokens.refreshToken,
                    scopes: candidate.tokens.scopes,
                    accessExpiresAtMs:
                      candidate.receivedAtMs + candidate.tokens.expiresInSeconds * 1000,
                    refreshExpiresAtMs:
                      candidate.receivedAtMs + candidate.tokens.refreshTokenExpiresInSeconds * 1000,
                  },
                };
              },
              assertInstall,
            );
          },
        });
      });
      guard(action);
      return { status: "success", personal: personalGitHubStatus(action) };
    } catch {
      guard(action);
      return { status: "failed", reason: "setup_failed" };
    }
  };

  const pollOnce = async (
    action: PersonalGitHubAction,
    initial: UserGitHubConnection,
    requestId: string,
  ): Promise<UsersGitHubAuthorizePollResult> => {
    const pending = initial.pending;
    if (!pending || pending.requestId !== requestId || pending.expiresAtMs <= Date.now()) {
      return { status: "expired" };
    }
    if (pending.kind === "starting") {
      return { status: "pending", retryAfterMs: 1000 };
    }
    if (pending.candidate) {
      return await install(action, initial.generation, pending);
    }
    const polled = await pollGitHubDeviceFlow(pending, abort.signal);
    guard(action);
    let next: UserGitHubConnection;
    try {
      next = updateUserGitHubConnection(
        action.owner,
        (current) => {
          const owned = requirePending(current, initial.generation, requestId);
          if (owned.pending.kind !== "device" || owned.pending.deviceCode !== pending.deviceCode) {
            throw new Error("My GitHub authorization changed.");
          }
          return {
            ...owned,
            pending:
              polled.kind === "terminal"
                ? undefined
                : {
                    ...owned.pending,
                    ...(polled.kind === "authorized"
                      ? {
                          candidate: {
                            receivedAtMs: Date.now(),
                            profileId: createManagedGitHubProfileId(),
                            tokens: polled.tokens,
                          },
                        }
                      : {
                          pollIntervalMs: polled.pollIntervalMs,
                          nextPollAtMs: polled.nextPollAtMs,
                        }),
                  },
          };
        },
        () => guard(action),
      );
    } catch {
      guard(action);
      return { status: "failed", reason: "identity_changed" };
    }
    if (polled.kind !== "authorized") {
      return polled.result;
    }
    if (next.pending?.kind !== "device") {
      throw new Error("My GitHub authorization changed.");
    }
    return await install(action, next.generation, next.pending);
  };

  const persistRotation = (pending: NonNullable<ReturnType<typeof rotated.get>>): boolean =>
    updateUserGitHubRefresh({
      ...pending,
      update: (selection) => ({
        ...rotatedSelection(selection, pending.tokens, pending.receivedAtMs),
        refresh: {
          operationId: pending.operationId,
          tokens: pending.tokens,
          receivedAtMs: pending.receivedAtMs,
        },
      }),
    });
  const materializeRefresh = async (
    owner: string,
    id: string,
    operationId: string,
    assertOwned: () => void,
  ): Promise<void> => {
    const readExact = () => {
      assertOwned();
      const canonical = resolvePersonalGitHubOwner(owner);
      const selection = canonical ? readUserGitHubConnection(canonical)?.selection : undefined;
      if (
        selection?.kind !== "connected" ||
        selection.profileId !== id ||
        selection.refresh?.operationId !== operationId ||
        !selection.refresh.tokens
      ) {
        throw new Error("My GitHub refresh ownership changed.");
      }
      return selection;
    };
    const current = readExact();
    const account = await refreshManagedGitHubProfile({
      profileDir: profileDir(id),
      token: current.refresh!.tokens!.accessToken,
      expectedAccountId: current.accountId,
      assertCurrent: () => {
        readExact();
      },
    });
    assertOwned();
    updateUserGitHubRefresh({
      owner,
      profileId: id,
      operationId,
      update: (selection) => ({
        ...selection,
        login: account.login,
        refresh: undefined,
        refreshFailure: undefined,
      }),
    });
  };

  const refresh = async (owner: string): Promise<void> => {
    assertRunning();
    const initial = readUserGitHubConnection(owner)?.selection;
    if (initial?.kind !== "connected") {
      return;
    }
    const id = initial.profileId;
    await getOrCreatePromise(
      refreshes,
      id,
      () =>
        withProfileLease(id, async (assertOwned) => {
          const memory = rotated.get(id);
          if (memory) {
            if (!persistRotation(memory)) {
              rotated.delete(id);
              return;
            }
            rotated.delete(id);
          }
          const record = readUserGitHubConnection(owner);
          const selection = record?.selection;
          if (!record || selection?.kind !== "connected" || selection.profileId !== id) {
            return;
          }
          if (selection.refresh?.tokens) {
            await materializeRefresh(owner, id, selection.refresh.operationId, assertOwned);
            return;
          }
          if (
            selection.refreshFailure === "expired" ||
            selection.refreshExpiresAtMs <= Date.now() ||
            (!selection.refresh && selection.accessExpiresAtMs > Date.now() + 600000)
          ) {
            return;
          }
          const operationId = selection.refresh?.operationId ?? randomUUID();
          updateUserGitHubConnection(
            owner,
            (current) => {
              if (
                current?.generation !== record.generation ||
                current.selection.kind !== "connected" ||
                current.selection.profileId !== id
              ) {
                throw new Error("My GitHub selection changed.");
              }
              return { ...current, selection: { ...current.selection, refresh: { operationId } } };
            },
            assertOwned,
          );
          let result;
          try {
            // Refresh rotates remote credentials: shutdown drains this bounded exchange, never aborts it.
            result = await refreshGitHubOAuthToken({
              refreshToken: selection.refreshToken,
            });
          } catch {
            updateUserGitHubRefresh({
              owner,
              profileId: id,
              operationId,
              update: (current) => ({ ...current, refresh: undefined, refreshFailure: "failed" }),
            });
            return;
          }
          if (result.status === "error") {
            updateUserGitHubRefresh({
              owner,
              profileId: id,
              operationId,
              update: (current) => ({
                ...current,
                refresh: undefined,
                refreshFailure: result.code === "bad_refresh_token" ? "expired" : "failed",
              }),
            });
            return;
          }
          // Persist remote rotation even if the initiating request closed or its profile merged.
          // The exact operation CAS fences disconnect/replacement; memory retries use that same CAS.
          const pending = {
            owner,
            profileId: id,
            operationId,
            tokens: result.tokens,
            receivedAtMs: Date.now(),
          };
          rotated.set(id, pending);
          if (!persistRotation(pending)) {
            rotated.delete(id);
            return;
          }
          rotated.delete(id);
          await materializeRefresh(owner, id, operationId, assertOwned);
        }),
      { evictOnSettled: true },
    );
  };

  let maintenance: Promise<void> | undefined;
  const runMaintenance = async (): Promise<void> => {
    if (!inspectedProfiles) {
      const root = resolveManagedGitHubProfileRoot({ agentId: "", scope: "personal" });
      const entries = await fs.readdir(root, { withFileTypes: true }).catch((error: unknown) => {
        if (hasErrnoCode(error, "ENOENT")) {
          return [];
        }
        throw error;
      });
      for (const entry of entries) {
        if (
          entry.isDirectory() &&
          /^ghp_[a-f0-9]{32}$/u.test(entry.name) &&
          !profileIsReferenced(entry.name)
        ) {
          retirements.add(entry.name);
        }
      }
      inspectedProfiles = true;
    }
    for (const pending of rotated.values()) {
      try {
        persistRotation(pending);
        rotated.delete(pending.profileId);
      } catch {
        /* Keep the exact rotated pair for the next durable write. */
      }
    }
    for (const id of retirements) {
      await retire(id);
    }
    for (const { owner, connection } of listUserGitHubConnections()) {
      if (stopped) {
        break;
      }
      if (connection.pending && connection.pending.expiresAtMs <= Date.now()) {
        updateUserGitHubConnection(
          owner,
          (current) => {
            if (!current) {
              return disconnectedUserGitHubConnection();
            }
            return current.pending && current.pending.expiresAtMs <= Date.now()
              ? { ...current, pending: undefined }
              : current;
          },
          assertRunning,
        );
      }
      try {
        await refresh(owner);
      } catch {
        /* Exact pending recovery remains durable for retry. */
      }
    }
  };

  return {
    status: resolvePersonalGitHubStatus,
    async startAuthorization(
      action: PersonalGitHubAction,
    ): Promise<UsersGitHubAuthorizeStartResult> {
      guard(action);
      assertGitHubCliAvailable();
      const requestId = randomUUID();
      const createdAtMs = Date.now();
      const initial = updateUserGitHubConnection(
        action.owner,
        (current) => ({
          ...(current ?? disconnectedUserGitHubConnection()),
          pending: { kind: "starting", requestId, createdAtMs, expiresAtMs: createdAtMs + 900000 },
        }),
        () => guard(action),
      );
      const authorization = await startGitHubDeviceFlow(abort.signal);
      guard(action);
      if (authorization.expiresAtMs <= Date.now()) {
        throw new Error("My GitHub authorization expired while starting; start again.");
      }
      const next = updateUserGitHubConnection(
        action.owner,
        (current) => ({
          ...requirePending(current, initial.generation, requestId),
          pending: { ...authorization, kind: "device", requestId },
        }),
        () => guard(action),
      );
      if (next.pending?.kind !== "device") {
        throw new Error("My GitHub authorization changed.");
      }
      return projectPending(next.pending);
    },
    async pollAuthorization(
      action: PersonalGitHubAction,
      requestId: string,
    ): Promise<UsersGitHubAuthorizePollResult> {
      guard(action);
      const current = readUserGitHubConnection(action.owner);
      if (current?.pending?.requestId !== requestId) {
        return { status: "expired" };
      }
      const key = `${action.owner}\0${requestId}`;
      const result = await getOrCreatePromise(
        polls,
        key,
        () => pollOnce(action, current, requestId),
        { evictOnSettled: true },
      );
      guard(action);
      return result;
    },
    cancelAuthorization(action: PersonalGitHubAction, requestId: string): boolean {
      guard(action);
      const current = readUserGitHubConnection(action.owner);
      if (current?.pending?.requestId !== requestId) {
        return false;
      }
      updateUserGitHubConnection(
        action.owner,
        (record) => {
          if (!record || record.pending?.requestId !== requestId) {
            throw new Error("My GitHub authorization changed.");
          }
          return { ...record, pending: undefined };
        },
        () => guard(action),
      );
      return true;
    },
    disconnect(action: PersonalGitHubAction): void {
      guard(action);
      disconnectUserGitHubConnection(action.owner, () => guard(action));
    },
    refresh,
    maintain(): Promise<void> {
      if (stopped) {
        return Promise.resolve();
      }
      maintenance ??= runMaintenance().finally(() => {
        maintenance = undefined;
      });
      return maintenance;
    },
    async stop(): Promise<void> {
      stopped = true;
      abort.abort();
      unobserve();
      await Promise.allSettled([
        ...(maintenance ? [maintenance] : []),
        ...polls.values(),
        ...refreshes.values(),
        ...cleanups.values(),
      ]);
      for (const pending of rotated.values()) {
        try {
          persistRotation(pending);
        } catch {
          /* In-memory rotation remains owned until process exit. */
        }
      }
    },
  };
}
