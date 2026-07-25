import { randomUUID } from "node:crypto";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type {
  SessionDiscussionInfo,
  SessionDiscussionProvider,
} from "openclaw/plugin-sdk/session-discussion";
import { listClickClackAccountIds, resolveClickClackAccount } from "../accounts.js";
import {
  createClickClackClient,
  isClickClackChannelNameConflict,
  type ClickClackClient,
} from "../http-client.js";
import type { CoreConfig, ResolvedClickClackAccount } from "../types.js";
import {
  clearDiscussionBindingGeneration,
  listPendingDiscussionOpens,
  type PendingDiscussionOpen,
} from "./binding-generation.js";
import {
  getClickClackDiscussionBindingStore,
  bindingMatchesSessionIncarnation,
  type ClickClackDiscussionBinding,
  type ClickClackDiscussionBindingStore,
} from "./binding-store.js";
import {
  discussionAccounts,
  normalizedServerBaseUrl,
  resolveDiscussionBindingAccount,
  type DiscussionBindingAccountResolution,
} from "./eligibility.js";
import { getClickClackDiscussionInstallationId } from "./installation.js";
import { discussionCredentialFingerprint, resolveDiscussionLabel } from "./naming.js";
import {
  clearClickClackDiscussionChannelRevoked,
  isClickClackDiscussionChannelRevoked,
  markClickClackDiscussionChannelIdentityRevoked,
  markClickClackDiscussionChannelRevoked,
} from "./revoked-channel-store.js";
import {
  assertChannelPatch,
  assertManagedChannelListContract,
  controlSessionUrl,
  openClickClackDiscussionBinding,
  resolveAvailableChannelName,
} from "./service-open.js";

const RECONCILE_INTERVAL_MS = 60_000;
const CHANNEL_NAME_MUTATION_ATTEMPTS = 4;

type DiscussionServiceOptions = {
  clientFactory?: (account: ResolvedClickClackAccount) => ClickClackClient;
  installationId?: string;
  bindingGenerationFactory?: () => string;
  startTimer?: boolean;
};

type DiscussionBindingUseResolution = DiscussionBindingAccountResolution | { state: "retargeted" };

function discussionInfoForBinding(
  binding: ClickClackDiscussionBinding,
  account: ResolvedClickClackAccount,
): SessionDiscussionInfo {
  const baseUrl = normalizedServerBaseUrl(account);
  return {
    state: "open",
    embedUrl: `${baseUrl}/embed/channel/${encodeURIComponent(binding.workspaceRouteId)}/${encodeURIComponent(binding.channelRouteId)}`,
    openUrl: `${baseUrl}/app/${encodeURIComponent(binding.workspaceRouteId)}/${encodeURIComponent(binding.channelRouteId)}`,
  };
}

function discussionRecordJson(value: string): string {
  return JSON.stringify(value).replace(
    /[\u0085\u2028\u2029]/gu,
    (separator) => `\\u${separator.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export class ClickClackDiscussionService {
  readonly provider: SessionDiscussionProvider;
  readonly #runtime: PluginRuntime;
  readonly #store: ClickClackDiscussionBindingStore;
  readonly #clientFactory: (account: ResolvedClickClackAccount) => ClickClackClient;
  readonly #installationId: string;
  readonly #bindingGenerationFactory: () => string;
  readonly #timersEnabled: boolean;
  readonly #sessionLocks = new Map<string, Promise<unknown>>();
  #channelMutationLock: Promise<unknown> = Promise.resolve();
  #timer: ReturnType<typeof setInterval> | undefined;
  #reconcileAllPromise: Promise<void> | undefined;

  constructor(runtime: PluginRuntime, options: DiscussionServiceOptions = {}) {
    this.#runtime = runtime;
    this.#store = getClickClackDiscussionBindingStore(runtime);
    this.#clientFactory =
      options.clientFactory ??
      ((account) => createClickClackClient({ baseUrl: account.apiEndpoint, token: account.token }));
    this.#installationId = options.installationId ?? getClickClackDiscussionInstallationId(runtime);
    this.#bindingGenerationFactory = options.bindingGenerationFactory ?? randomUUID;
    this.#timersEnabled = options.startTimer !== false;
    this.provider = {
      id: "clickclack",
      info: async ({ sessionKey }) => await this.info(sessionKey),
      open: async ({ sessionKey }) => await this.open(sessionKey),
    };
    if (this.#timersEnabled) {
      this.#ensureTimer();
    }
  }

  hasEnabledAccount(): boolean {
    return discussionAccounts(this.#currentConfig()).length === 1;
  }

  async info(sessionKey: string): Promise<SessionDiscussionInfo> {
    return await this.#withSessionLock(sessionKey, async () => {
      const accounts = discussionAccounts(this.#currentConfig());
      if (accounts.length !== 1) {
        return { state: "none" };
      }
      const existing = this.#store.get(sessionKey);
      if (existing) {
        const resolved = await this.#resolveBindingForUse(existing);
        if (resolved.state === "retargeted") {
          this.#revokeAndDeleteBinding(sessionKey, existing);
          return { state: "available" };
        }
        if (resolved.state === "stale") {
          await this.#releaseStaleBinding(sessionKey, existing);
          return { state: "available" };
        }
        if (resolved.state !== "active") {
          return { state: "none" };
        }
        this.#finalizePendingBinding(sessionKey, existing);
        await this.#reconcileBinding(sessionKey, existing, resolved.account);
        const current = this.#store.get(sessionKey);
        if (!current) {
          return { state: this.hasEnabledAccount() ? "available" : "none" };
        }
        return discussionInfoForBinding(current, resolved.account);
      }
      return { state: "available" };
    });
  }

  async open(sessionKey: string): Promise<SessionDiscussionInfo> {
    return await this.#withSessionLock(sessionKey, async () => {
      const accounts = discussionAccounts(this.#currentConfig());
      if (accounts.length > 1) {
        throw new Error("ClickClack discussions require exactly one enabled discussion account");
      }
      const account = accounts[0];
      if (!account) {
        return { state: "none" };
      }
      const existing = this.#store.get(sessionKey);
      if (existing) {
        const resolved = await this.#resolveBindingForUse(existing);
        if (resolved.state === "retargeted") {
          this.#revokeAndDeleteBinding(sessionKey, existing);
        } else if (resolved.state === "stale") {
          await this.#releaseStaleBinding(sessionKey, existing);
        } else if (resolved.state === "active") {
          this.#finalizePendingBinding(sessionKey, existing);
          await this.#reconcileBinding(sessionKey, existing, resolved.account);
          const current = this.#store.get(sessionKey);
          if (current) {
            return discussionInfoForBinding(current, resolved.account);
          }
        }
      }
      const binding = await openClickClackDiscussionBinding({
        runtime: this.#runtime,
        store: this.#store,
        account,
        clientFactory: this.#clientFactory,
        installationId: this.#installationId,
        bindingGenerationFactory: this.#bindingGenerationFactory,
        sessionKey,
        ensureTimer: () => this.#ensureTimer(),
        reconcilePendingOpen: async (pending) =>
          await this.#reconcilePendingOpen(pending, { allowRetry: false }),
        withChannelMutationLock: async (run) => await this.#withChannelMutationLock(run),
        finalizePendingBinding: (key, nextBinding) =>
          this.#finalizePendingBinding(key, nextBinding),
        warn: (message) => this.#logger().warn(message),
      });
      if (!binding) {
        return { state: "available" };
      }
      this.#ensureTimer();
      return discussionInfoForBinding(binding, account);
    });
  }

  async reconcile(sessionKey: string): Promise<void> {
    await this.#withSessionLock(sessionKey, async () => {
      const binding = this.#store.get(sessionKey);
      if (binding) {
        await this.#reconcileBinding(sessionKey, binding);
      }
    });
  }

  async reconcileAll(): Promise<void> {
    if (this.#reconcileAllPromise) {
      return await this.#reconcileAllPromise;
    }
    this.#reconcileAllPromise = (async () => {
      for (const { sessionKey } of this.#store.entries()) {
        try {
          await this.reconcile(sessionKey);
        } catch (error) {
          this.#logger().warn(`discussion reconcile failed for ${sessionKey}: ${String(error)}`);
        }
      }
      for (const pending of listPendingDiscussionOpens(this.#runtime)) {
        try {
          await this.#reconcilePendingOpen(pending);
        } catch (error) {
          this.#logger().warn(
            `discussion pending-open reconcile failed for ${pending.sessionKey}: ${String(error)}`,
          );
        }
      }
    })().finally(() => {
      this.#reconcileAllPromise = undefined;
    });
    return await this.#reconcileAllPromise;
  }

  async readLatestMessages(
    sessionKey: string,
    limit: number,
  ): Promise<{ binding?: ClickClackDiscussionBinding; text: string }> {
    const binding = this.#store.get(sessionKey);
    if (!binding) {
      return { text: "No discussion is bound to this session." };
    }
    const resolved = await this.#resolveBindingForUse(binding);
    if (resolved.state === "retargeted") {
      return { text: "No discussion is bound to this session." };
    }
    if (resolved.state === "stale") {
      return { text: "No discussion is bound to this session." };
    }
    if (resolved.state !== "active") {
      return { text: "No discussion is bound to this session." };
    }
    if (!bindingMatchesSessionIncarnation(this.#runtime, sessionKey, binding)) {
      return { text: "No discussion is bound to this session." };
    }
    if (
      isClickClackDiscussionChannelRevoked({
        runtime: this.#runtime,
        serverBaseUrl: binding.serverBaseUrl,
        channelId: binding.channelId,
      })
    ) {
      return { text: "No discussion is bound to this session." };
    }
    const history = await this.#clientFactory(resolved.account).latestChannelMessages(
      binding.channelId,
      limit,
    );
    const text = history.messages
      .map((message) => {
        const author =
          message.author?.display_name || message.author?.handle || message.author_id || "Unknown";
        return `timestamp=${discussionRecordJson(message.created_at)} [Author ${discussionRecordJson(author)} id=${discussionRecordJson(message.author_id)}] text=${discussionRecordJson(message.body)}`;
      })
      .join("\n");
    const truncationNote = history.truncated
      ? "\n[History scan reached its safety bound; older active threads may be omitted.]"
      : "";
    return {
      binding,
      text: text ? `${text}${truncationNote}` : "The bound discussion has no messages yet.",
    };
  }

  cleanup(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  async #reconcileBinding(
    sessionKey: string,
    binding: ClickClackDiscussionBinding,
    resolvedAccount?: ResolvedClickClackAccount,
  ): Promise<void> {
    this.#finalizePendingBinding(sessionKey, binding);
    if (
      isClickClackDiscussionChannelRevoked({
        runtime: this.#runtime,
        serverBaseUrl: binding.serverBaseUrl,
        channelId: binding.channelId,
      })
    ) {
      this.#store.delete(sessionKey);
      return;
    }
    const resolved = resolvedAccount
      ? ({ state: "active", account: resolvedAccount } as const)
      : await this.#resolveBindingForUse(binding);
    if (resolved.state === "retargeted") {
      this.#revokeAndDeleteBinding(sessionKey, binding);
      return;
    }
    if (resolved.state === "stale") {
      await this.#releaseStaleBinding(sessionKey, binding);
      return;
    }
    if (resolved.state !== "active") {
      return;
    }
    const account = resolved.account;
    if (!account.baseUrl || !account.token) {
      throw new Error(
        `ClickClack discussion account is no longer configured: ${binding.accountId}`,
      );
    }
    const entry = this.#runtime.agent.session.getSessionEntry({
      sessionKey,
      readConsistency: "latest",
    });
    if (entry && (!binding.sessionId || entry.sessionId !== binding.sessionId)) {
      await this.#archiveAndDeleteBinding(sessionKey, binding, account);
      return;
    }
    const archived = entry ? entry.archivedAt !== undefined : true;
    const deleted = entry === undefined;
    const label = entry ? resolveDiscussionLabel(entry.label, sessionKey) : binding.label;
    const section = entry?.category?.trim() || account.discussions.section;
    const externalUrl = controlSessionUrl(account.discussions.controlUrlBase, sessionKey) ?? "";
    const patch: {
      archived?: boolean;
      external_url?: string;
      name?: string;
      sidebar_section?: string;
    } = {};
    if (archived !== binding.archived) {
      patch.archived = archived;
    }
    const labelChanged = label !== binding.label;
    if (section !== binding.section) {
      patch.sidebar_section = section;
    }
    if (externalUrl !== binding.externalUrl) {
      patch.external_url = externalUrl;
    }
    if (Object.keys(patch).length === 0 && !labelChanged) {
      if (deleted) {
        this.#revokeAndDeleteBinding(sessionKey, binding);
      }
      return;
    }
    const client = this.#clientFactory(account);
    if (labelChanged) {
      await this.#withChannelMutationLock(async () => {
        for (let attempt = 0; attempt < CHANNEL_NAME_MUTATION_ATTEMPTS; attempt += 1) {
          patch.name = await resolveAvailableChannelName({
            client,
            workspaceId: binding.workspaceId,
            label,
            sessionKey,
            ownChannelId: binding.channelId,
          });
          try {
            const updated = await client.updateChannel(binding.channelId, patch);
            assertChannelPatch(updated, patch);
            return;
          } catch (error) {
            if (
              !isClickClackChannelNameConflict(error) ||
              attempt === CHANNEL_NAME_MUTATION_ATTEMPTS - 1
            ) {
              throw error;
            }
          }
        }
      });
    } else {
      const updated = await client.updateChannel(binding.channelId, patch);
      assertChannelPatch(updated, patch);
    }
    if (deleted) {
      this.#revokeAndDeleteBinding(sessionKey, binding);
      return;
    }
    this.#store.set(sessionKey, { ...binding, archived, externalUrl, label, section });
  }

  async #reconcilePendingOpen(
    pending: PendingDiscussionOpen,
    options: { allowRetry?: boolean } = {},
  ): Promise<void> {
    const currentBinding = this.#store.get(pending.sessionKey);
    if (currentBinding?.externalRef === pending.externalRef) {
      this.#finalizePendingBinding(pending.sessionKey, currentBinding);
      return;
    }
    const cfg = this.#currentConfig();
    const account = listClickClackAccountIds(cfg)
      .map((accountId) => resolveClickClackAccount({ cfg, accountId }))
      .find(
        (candidate) =>
          candidate.configured &&
          normalizedServerBaseUrl(candidate) === pending.serverBaseUrl &&
          discussionCredentialFingerprint(candidate.token) === pending.credentialFingerprint,
      );
    if (!account) {
      // Without the creating credential, keep the destination quarantined until
      // an operator restores access or explicitly cleans up the pending record.
      return;
    }
    const client = this.#clientFactory(account);
    const entry = this.#runtime.agent.session.getSessionEntry({
      sessionKey: pending.sessionKey,
      readConsistency: "latest",
    });
    const activeAccounts = discussionAccounts(cfg);
    const retryAccount = activeAccounts.length === 1 ? activeAccounts[0] : undefined;
    if (
      options.allowRetry !== false &&
      entry?.sessionId === pending.sessionId &&
      retryAccount &&
      normalizedServerBaseUrl(retryAccount) === pending.serverBaseUrl &&
      discussionCredentialFingerprint(retryAccount.token) === pending.credentialFingerprint
    ) {
      const retryClient = this.#clientFactory(retryAccount);
      const workspaces = await retryClient.workspaces();
      const configuredWorkspace = workspaces.find(
        (candidate) =>
          candidate.id === retryAccount.discussions.workspace ||
          candidate.slug === retryAccount.discussions.workspace ||
          candidate.name === retryAccount.discussions.workspace,
      );
      if (configuredWorkspace?.id === pending.workspaceId) {
        await this.open(pending.sessionKey);
        return;
      }
    }
    const channels = await client.channels(pending.workspaceId);
    assertManagedChannelListContract(channels);
    const channel = channels.find(
      (candidate) =>
        candidate.external_managed === true && candidate.external_ref === pending.externalRef,
    );
    if (channel) {
      markClickClackDiscussionChannelIdentityRevoked({
        runtime: this.#runtime,
        accountId: pending.accountId,
        serverBaseUrl: pending.serverBaseUrl,
        channelId: channel.id,
      });
      const updated = await client.updateChannel(channel.id, { archived: true });
      assertChannelPatch(updated, { archived: true });
    }
    clearDiscussionBindingGeneration({
      runtime: this.#runtime,
      sessionKey: pending.sessionKey,
      expectedGeneration: pending.generation,
    });
  }

  async #releaseStaleBinding(
    sessionKey: string,
    binding: ClickClackDiscussionBinding,
  ): Promise<void> {
    // Clear the durable interrupted-open reservation before releasing ownership.
    // A crash after this point can retry archival, but can never re-adopt the old channel.
    clearDiscussionBindingGeneration({ runtime: this.#runtime, sessionKey });
    const boundAccount = resolveClickClackAccount({
      cfg: this.#currentConfig(),
      accountId: binding.accountId,
    });
    if (
      !boundAccount.configured ||
      binding.serverBaseUrl !== normalizedServerBaseUrl(boundAccount) ||
      !binding.credentialFingerprint ||
      binding.credentialFingerprint !== discussionCredentialFingerprint(boundAccount.token)
    ) {
      this.#revokeAndDeleteBinding(sessionKey, binding);
      return;
    }
    // Eligibility checks revoke routing/tool authority immediately, while the
    // durable binding remains as the retry record until archival is verified.
    const updated = await this.#clientFactory(boundAccount).updateChannel(binding.channelId, {
      archived: true,
    });
    assertChannelPatch(updated, { archived: true });
    this.#revokeAndDeleteBinding(sessionKey, binding);
  }

  async #archiveAndDeleteBinding(
    sessionKey: string,
    binding: ClickClackDiscussionBinding,
    account: ResolvedClickClackAccount,
  ): Promise<void> {
    clearDiscussionBindingGeneration({ runtime: this.#runtime, sessionKey });
    const updated = await this.#clientFactory(account).updateChannel(binding.channelId, {
      archived: true,
    });
    assertChannelPatch(updated, { archived: true });
    this.#revokeAndDeleteBinding(sessionKey, binding);
  }

  #revokeAndDeleteBinding(sessionKey: string, binding: ClickClackDiscussionBinding): void {
    // Persist the reverse ownership evidence first. If that write fails, retain
    // the binding so inbound routing still fails closed.
    markClickClackDiscussionChannelRevoked(this.#runtime, binding);
    this.#store.delete(sessionKey);
  }

  #finalizePendingBinding(sessionKey: string, binding: ClickClackDiscussionBinding): void {
    const pending = listPendingDiscussionOpens(this.#runtime).find(
      (candidate) =>
        candidate.sessionKey === sessionKey && candidate.externalRef === binding.externalRef,
    );
    if (pending) {
      // A matching binding is the durable commit record. Clear the fail-closed
      // tombstone first, then the recovery reservation; every crash point can
      // replay this sequence without orphaning the remote channel.
      clearClickClackDiscussionChannelRevoked({
        runtime: this.#runtime,
        serverBaseUrl: binding.serverBaseUrl,
        channelId: binding.channelId,
      });
      clearDiscussionBindingGeneration({
        runtime: this.#runtime,
        sessionKey,
        expectedGeneration: pending.generation,
      });
    }
  }

  async #resolveBindingForUse(
    binding: ClickClackDiscussionBinding,
  ): Promise<DiscussionBindingUseResolution> {
    const resolved = resolveDiscussionBindingAccount(this.#currentConfig(), binding);
    if (resolved.state !== "active") {
      return resolved;
    }
    const workspaces = await this.#clientFactory(resolved.account).workspaces();
    const workspace = workspaces.find(
      (candidate) =>
        candidate.id === resolved.account.discussions.workspace ||
        candidate.slug === resolved.account.discussions.workspace ||
        candidate.name === resolved.account.discussions.workspace,
    );
    return workspace?.id === binding.workspaceId ? resolved : { state: "retargeted" };
  }

  #currentConfig(): CoreConfig {
    return this.#runtime.config.current() as CoreConfig;
  }

  #ensureTimer(): void {
    if (
      !this.#timersEnabled ||
      this.#timer ||
      (this.#store.entries().length === 0 && listPendingDiscussionOpens(this.#runtime).length === 0)
    ) {
      return;
    }
    // The plugin event facade does not expose sessions.changed, and gateway.request
    // has no subscriber connection to receive it. Reconcile only while bindings
    // or ambiguous creates exist, at a coarse cadence, so this is not a hot poll.
    this.#timer = setInterval(() => {
      void this.reconcileAll()
        .catch((error: unknown) => {
          this.#logger().warn(`discussion reconcile pass failed: ${String(error)}`);
        })
        .finally(() => {
          if (
            this.#store.entries().length === 0 &&
            listPendingDiscussionOpens(this.#runtime).length === 0 &&
            this.#timer
          ) {
            clearInterval(this.#timer);
            this.#timer = undefined;
          }
        });
    }, RECONCILE_INTERVAL_MS);
    this.#timer.unref?.();
  }

  #logger() {
    return this.#runtime.logging.getChildLogger({ plugin: "clickclack", feature: "discussions" });
  }

  async #withSessionLock<T>(sessionKey: string, run: () => Promise<T>): Promise<T> {
    const previous = this.#sessionLocks.get(sessionKey) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(run);
    this.#sessionLocks.set(sessionKey, current);
    try {
      return await current;
    } finally {
      if (this.#sessionLocks.get(sessionKey) === current) {
        this.#sessionLocks.delete(sessionKey);
      }
    }
  }

  async #withChannelMutationLock<T>(run: () => Promise<T>): Promise<T> {
    const current = this.#channelMutationLock.catch(() => undefined).then(run);
    this.#channelMutationLock = current;
    return await current;
  }
}
