import { randomUUID } from "node:crypto";
import type { OpenClawPluginGatewayEvents, PluginRuntime } from "openclaw/plugin-sdk/core";
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
  clearPendingDiscussionOpen,
  clearDiscussionBindingGeneration,
  listPendingDiscussionOpens,
  type PendingDiscussionOpen,
} from "./binding-generation.js";
import { DetachedDiscussionBindingRetention } from "./binding-retention.js";
import {
  attachBindingToCurrentActiveSession,
  getClickClackDiscussionBindingStore,
  MAX_RETAINED_DETACHED_DISCUSSION_BINDINGS,
  type ClickClackDiscussionBinding,
  type ClickClackDiscussionBindingStore,
} from "./binding-store.js";
import { controlSessionUrl } from "./control-session-url.js";
import {
  discussionAccounts,
  discussionInfoForBinding,
  normalizedServerBaseUrl,
  resolveDiscussionBindingAccount,
  type DiscussionBindingAccountResolution,
} from "./eligibility.js";
import { formatDiscussionHistory } from "./history-format.js";
import { getClickClackDiscussionInstallationId } from "./installation.js";
import {
  discussionCredentialFingerprint,
  fallbackDiscussionLabel,
  resolveDiscussionLabel,
  truncateDiscussionDisplayTitle,
} from "./naming.js";
import { DiscussionReconcileScheduler } from "./reconcile-scheduler.js";
import {
  clearClickClackDiscussionChannelRevoked,
  isClickClackDiscussionChannelRevoked,
  markClickClackDiscussionChannelIdentityRevoked,
  markClickClackDiscussionChannelRevoked,
} from "./revoked-channel-store.js";
import {
  assertChannelPatch,
  assertManagedChannelListContract,
  openClickClackDiscussionBinding,
  resolveAvailableChannelName,
} from "./service-open.js";

const RECONCILE_INTERVAL_MS = 60_000;
const CHANNEL_NAME_MUTATION_ATTEMPTS = 4;
type DiscussionServiceOptions = {
  clientFactory?: (account: ResolvedClickClackAccount) => ClickClackClient;
  installationId?: string;
  bindingGenerationFactory?: () => string;
  gatewayEvents?: Pick<OpenClawPluginGatewayEvents, "onSessionsChanged">;
  startTimer?: boolean;
  maxRetainedDetachedBindings?: number;
};

type DiscussionBindingUseResolution = DiscussionBindingAccountResolution | { state: "retargeted" };

export class ClickClackDiscussionService {
  readonly provider: SessionDiscussionProvider;
  readonly #runtime: PluginRuntime;
  readonly #store: ClickClackDiscussionBindingStore;
  readonly #clientFactory: (account: ResolvedClickClackAccount) => ClickClackClient;
  readonly #installationId: string;
  readonly #bindingGenerationFactory: () => string;
  readonly #detachedBindings: DetachedDiscussionBindingRetention;
  readonly #timersEnabled: boolean;
  readonly #sessionLocks = new Map<string, Promise<unknown>>();
  readonly #reconcileScheduler = new DiscussionReconcileScheduler({
    shouldSchedule: (sessionKey) =>
      !this.#closed &&
      (this.#store.get(sessionKey) !== undefined ||
        listPendingDiscussionOpens(this.#runtime).some(
          (pending) => pending.sessionKey === sessionKey,
        )),
    run: async (sessionKey) => await this.reconcile(sessionKey),
    warn: (message) => this.#logger().warn(message),
  });
  #channelMutationLock: Promise<unknown> = Promise.resolve();
  #timer: ReturnType<typeof setInterval> | undefined;
  #reconcileAllPromise: Promise<void> | undefined;
  #unsubscribeSessionsChanged: (() => void) | undefined;
  #closed = false;

  constructor(runtime: PluginRuntime, options: DiscussionServiceOptions = {}) {
    this.#runtime = runtime;
    this.#store = getClickClackDiscussionBindingStore(runtime);
    this.#clientFactory =
      options.clientFactory ??
      ((account) => createClickClackClient({ baseUrl: account.apiEndpoint, token: account.token }));
    this.#installationId = options.installationId ?? getClickClackDiscussionInstallationId(runtime);
    this.#bindingGenerationFactory = options.bindingGenerationFactory ?? randomUUID;
    this.#detachedBindings = new DetachedDiscussionBindingRetention({
      runtime,
      store: this.#store,
      maxRetained: options.maxRetainedDetachedBindings ?? MAX_RETAINED_DETACHED_DISCUSSION_BINDINGS,
    });
    this.#timersEnabled = options.startTimer !== false;
    this.provider = {
      id: "clickclack",
      info: async ({ sessionKey }) => await this.info(sessionKey),
      open: async ({ sessionKey }) => await this.open(sessionKey),
    };
    // Activation (event subscription + catch-up reconciles) belongs to the
    // registered service lifecycle via bindGatewayEvents; construction alone
    // must not touch remote channels. Tests may inject events for immediacy.
    if (options.gatewayEvents) {
      this.bindGatewayEvents(options.gatewayEvents);
    }
    if (this.#timersEnabled) {
      this.#ensureTimer();
    }
  }

  bindGatewayEvents(
    gatewayEvents: Pick<OpenClawPluginGatewayEvents, "onSessionsChanged"> | undefined,
  ): void {
    // Service (re)start reactivates regardless of capability: a broadcaster-less
    // runtime must still recover its fallback poll after a stop/start cycle.
    // Only cleanup() closes the service.
    this.#unsubscribeSessionsChanged?.();
    this.#closed = false;
    this.#reconcileScheduler.supersede();
    this.#unsubscribeSessionsChanged = gatewayEvents?.onSessionsChanged((event) => {
      this.#reconcileScheduler.schedule(event.sessionKey);
    });
    for (const sessionKey of this.#listReconcileSessionKeys()) {
      this.#reconcileScheduler.schedule(sessionKey, 0);
    }
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
      let binding: ClickClackDiscussionBinding | undefined;
      try {
        binding = await openClickClackDiscussionBinding({
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
          ensureBindingCapacity: (key) => this.#detachedBindings.ensureCapacity(key),
          finalizePendingBinding: (key, nextBinding) =>
            this.#finalizePendingBinding(key, nextBinding),
          warn: (message) => this.#logger().warn(message),
        });
      } finally {
        this.#ensureTimer();
      }
      if (!binding) {
        return { state: "available" };
      }
      return discussionInfoForBinding(binding, account);
    });
  }

  async reconcile(sessionKey: string): Promise<void> {
    try {
      await this.#withSessionLock(sessionKey, async () => {
        const binding = this.#store.get(sessionKey);
        if (binding) {
          await this.#reconcileBinding(sessionKey, binding);
        }
      });
      const pending = listPendingDiscussionOpens(this.#runtime).find(
        (candidate) => candidate.sessionKey === sessionKey,
      );
      if (pending) {
        await this.#reconcilePendingOpen(pending);
      }
    } finally {
      this.#ensureTimer();
    }
  }

  async reconcileAll(): Promise<void> {
    if (this.#reconcileAllPromise) {
      return await this.#reconcileAllPromise;
    }
    this.#reconcileAllPromise = (async () => {
      for (const sessionKey of this.#listReconcileSessionKeys()) {
        try {
          await this.reconcile(sessionKey);
        } catch (error) {
          this.#logger().warn(`discussion reconcile failed for ${sessionKey}: ${String(error)}`);
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
    const attached = this.#refreshSessionAttachment(sessionKey, binding);
    if (!attached) {
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
      attached.channelId,
      limit,
    );
    const text = formatDiscussionHistory(history);
    return {
      binding: attached,
      text: text || "The bound discussion has no messages yet.",
    };
  }

  cleanup(): void {
    this.#closed = true;
    this.#unsubscribeSessionsChanged?.();
    this.#unsubscribeSessionsChanged = undefined;
    this.#reconcileScheduler.supersede();
    this.#reconcileScheduler.clear();
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
    const entry = this.#runtime.agent.session.getSessionEntry({
      sessionKey,
      readConsistency: "latest",
    });
    if (!entry) {
      this.#detachedBindings.mark(sessionKey, binding);
      return;
    }
    const activeBinding = this.#detachedBindings.clear(sessionKey, binding);
    if (!activeBinding) {
      return;
    }
    const resolved = resolvedAccount
      ? ({ state: "active", account: resolvedAccount } as const)
      : await this.#resolveBindingForUse(activeBinding);
    if (resolved.state === "retargeted") {
      this.#revokeAndDeleteBinding(sessionKey, activeBinding);
      return;
    }
    if (resolved.state === "stale") {
      await this.#releaseStaleBinding(sessionKey, activeBinding);
      return;
    }
    if (resolved.state !== "active") {
      return;
    }
    const account = resolved.account;
    if (!account.baseUrl || !account.token) {
      throw new Error(
        `ClickClack discussion account is no longer configured: ${activeBinding.accountId}`,
      );
    }
    if (entry.archivedAt !== undefined) {
      return;
    }
    const attached = this.#refreshSessionAttachment(sessionKey, activeBinding);
    if (!attached) {
      return;
    }
    const currentBinding = attached;
    const fallback = fallbackDiscussionLabel(sessionKey, currentBinding.agentId);
    const label = resolveDiscussionLabel(entry, sessionKey, currentBinding.agentId);
    const section = entry.category?.trim() || account.discussions.section;
    const externalUrl =
      controlSessionUrl(
        account.discussions.controlUrlBase,
        sessionKey,
        account.agentId ?? "main",
        this.#currentConfig().session?.mainKey,
        label,
      ) ?? "";
    const patch: {
      display_title?: string;
      external_url?: string;
      name?: string;
      sidebar_section?: string;
    } = {};
    const labelChanged = label !== currentBinding.label;
    const desiredDisplayTitle = label === fallback ? "" : truncateDiscussionDisplayTitle(label);
    const serverSupportsDisplayTitle = this.#store
      .entries()
      .some(
        ({ binding: candidate }) =>
          candidate.displayTitle !== undefined &&
          candidate.serverBaseUrl === currentBinding.serverBaseUrl &&
          candidate.accountId === currentBinding.accountId,
      );
    const shouldBackfillDisplayTitle =
      desiredDisplayTitle !== "" &&
      currentBinding.displayTitle !== desiredDisplayTitle &&
      serverSupportsDisplayTitle;
    if (labelChanged || shouldBackfillDisplayTitle) {
      patch.display_title = desiredDisplayTitle;
    }
    if (section !== currentBinding.section) {
      patch.sidebar_section = section;
    }
    if (externalUrl !== currentBinding.externalUrl) {
      patch.external_url = externalUrl;
    }
    if (Object.keys(patch).length === 0 && !labelChanged) {
      return;
    }
    const client = this.#clientFactory(account);
    let updated: Awaited<ReturnType<ClickClackClient["updateChannel"]>>;
    if (labelChanged) {
      updated = await this.#withChannelMutationLock(async () => {
        for (let attempt = 0; attempt < CHANNEL_NAME_MUTATION_ATTEMPTS; attempt += 1) {
          patch.name = await resolveAvailableChannelName({
            client,
            workspaceId: currentBinding.workspaceId,
            label,
            sessionKey,
            agentId: currentBinding.agentId,
            ownChannelId: currentBinding.channelId,
          });
          try {
            const renamed = await client.updateChannel(currentBinding.channelId, patch);
            assertChannelPatch(renamed, patch);
            return renamed;
          } catch (error) {
            if (
              !isClickClackChannelNameConflict(error) ||
              attempt === CHANNEL_NAME_MUTATION_ATTEMPTS - 1
            ) {
              throw error;
            }
          }
        }
        throw new Error("ClickClack discussion channel name retries were exhausted");
      });
    } else {
      updated = await client.updateChannel(currentBinding.channelId, patch);
      assertChannelPatch(updated, patch);
    }
    const latestBinding = this.#store.get(sessionKey);
    if (
      !latestBinding ||
      latestBinding.serverBaseUrl !== currentBinding.serverBaseUrl ||
      latestBinding.channelId !== currentBinding.channelId ||
      latestBinding.externalRef !== currentBinding.externalRef
    ) {
      return;
    }
    const nextBinding: ClickClackDiscussionBinding = {
      ...latestBinding,
      externalUrl,
      label,
      section,
      ...(updated.display_title !== undefined ? { displayTitle: updated.display_title } : {}),
    };
    if (updated.display_title === undefined) {
      delete nextBinding.displayTitle;
    }
    this.#store.set(sessionKey, nextBinding);
  }

  #refreshSessionAttachment(
    sessionKey: string,
    binding: ClickClackDiscussionBinding,
  ): ClickClackDiscussionBinding | undefined {
    try {
      return attachBindingToCurrentActiveSession({
        runtime: this.#runtime,
        store: this.#store,
        sessionKey,
        binding,
      });
    } catch (error) {
      this.#logger().warn(
        `discussion attachment refresh failed for ${sessionKey}: ${String(error)}`,
      );
      return undefined;
    }
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
      entry?.sessionId &&
      entry.archivedAt === undefined &&
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
      clearPendingDiscussionOpen({
        runtime: this.#runtime,
        sessionKey: pending.sessionKey,
        expectedGeneration: pending.generation,
      });
      return;
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
    // Release local routing authority only. The ClickClack room remains durable,
    // and its lifecycle remains owned by ClickClack.
    clearDiscussionBindingGeneration({ runtime: this.#runtime, sessionKey });
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
    const hasPendingOpens = listPendingDiscussionOpens(this.#runtime).length > 0;
    // Without a gateway-event subscription (no broadcaster in this process),
    // bindings fall back to the interval poll or renames would never reconcile.
    const needsBindingPoll =
      this.#unsubscribeSessionsChanged === undefined && this.#store.entries().length > 0;
    if (this.#closed || (!hasPendingOpens && !needsBindingPoll)) {
      if (this.#timer) {
        clearInterval(this.#timer);
        this.#timer = undefined;
      }
      return;
    }
    if (!this.#timersEnabled || this.#timer) {
      return;
    }
    // Session changes drive normal binding reconciliation through gateway events.
    // Only ambiguous creates still need time-based retries while their durable
    // pending-open record exists.
    this.#timer = setInterval(() => {
      void this.reconcileAll()
        .catch((error: unknown) => {
          this.#logger().warn(`discussion reconcile pass failed: ${String(error)}`);
        })
        .finally(() => {
          this.#ensureTimer();
        });
    }, RECONCILE_INTERVAL_MS);
    this.#timer.unref?.();
  }

  #listReconcileSessionKeys(): Set<string> {
    return new Set([
      ...this.#store.entries().map(({ sessionKey }) => sessionKey),
      ...listPendingDiscussionOpens(this.#runtime).map(({ sessionKey }) => sessionKey),
    ]);
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
