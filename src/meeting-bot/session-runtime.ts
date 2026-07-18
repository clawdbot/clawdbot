import type { RuntimeLogger } from "../plugins/runtime/types.js";
import { MeetingSessionCleanupTracker } from "./session-cleanup-tracker.js";
import { MeetingSessionJoinLock } from "./session-join-lock.js";
import { MeetingSessionTranscriptStore } from "./session-transcript-store.js";
import type {
  MeetingBrowserHealth,
  MeetingBrowserTab,
  MeetingResolvedJoin,
  MeetingSessionRecord,
  MeetingTranscriptSnapshot,
} from "./session-types.js";

export type MeetingSessionRuntimeHandles<THealth extends MeetingBrowserHealth> = {
  stop?: () => Promise<void>;
  speak?: (instructions?: string) => void;
  getHealth?: () => Partial<THealth>;
};

export type MeetingBrowserSessionView<
  THealth extends MeetingBrowserHealth,
  TTab extends MeetingBrowserTab,
> = {
  launched: boolean;
  nodeId?: string;
  tab?: TTab;
  health?: THealth;
  hasAudioBridge: boolean;
};

export type MeetingSessionRuntimeJoinContext<
  TSession extends MeetingSessionRecord<TTransport, TMode>,
  TTransport extends string,
  TMode extends string,
  THealth extends MeetingBrowserHealth,
  TTab extends MeetingBrowserTab,
> = {
  attachRuntimeHandles(session: TSession, handles: MeetingSessionRuntimeHandles<THealth>): void;
  inheritedBrowserTab(params: {
    session: TSession;
    transport: TTransport;
    nodeId?: string;
    meetingUrl: string;
    tab?: TTab;
  }): TTab | undefined;
};

export type MeetingSessionRuntimeMessages<TSpeechBlockedReason extends string> = {
  previousBrowserLeaveFailed: string;
  reassignedSessionNote: string;
  reusedSessionNote: string;
  replacementBrowserLeaveFailed: string;
  speechBlockedFallback: string;
  speech: {
    audioBridgeUnavailable: string;
    browserUnverified: string;
    manualActionFallback: string;
    microphoneMuted: string;
    microphoneMutedReason: TSpeechBlockedReason;
    notInCall: string;
    notInCallReason: TSpeechBlockedReason;
    browserUnverifiedReason: TSpeechBlockedReason;
    audioBridgeUnavailableReason: TSpeechBlockedReason;
  };
};

export type MeetingSessionRuntimeOptions<
  TSession extends MeetingSessionRecord<TTransport, TMode>,
  TRequest,
  TTransport extends string,
  TMode extends string,
  THealth extends MeetingBrowserHealth<TManualReason, TSpeechBlockedReason>,
  TTab extends MeetingBrowserTab,
  TManualReason extends string,
  TSpeechBlockedReason extends string,
> = {
  logger: RuntimeLogger;
  logScope: string;
  formatError(error: unknown): string;
  messages: MeetingSessionRuntimeMessages<TSpeechBlockedReason>;
  reuseExistingBrowserTab: boolean;
  waitForInCallMs: number;
  joinTimeoutMs: number;
  transientSpeechBlockedReasons: ReadonlySet<TSpeechBlockedReason>;
  resolveJoin(request: TRequest): MeetingResolvedJoin<TTransport, TMode>;
  createSession(params: {
    request: TRequest;
    resolved: MeetingResolvedJoin<TTransport, TMode>;
    createdAt: string;
  }): TSession;
  resolveSpeechInstructions(request: TRequest): string | undefined;
  isBrowserTransport(transport: TTransport): boolean;
  isTalkBackMode(mode: TMode): boolean;
  isTranscribeMode(mode: TMode): boolean;
  sameMeetingUrl(left: string | undefined, right: string | undefined): boolean;
  normalizeMeetingUrlForReuse(url: string): string | undefined;
  getBrowser(session: TSession): MeetingBrowserSessionView<THealth, TTab> | undefined;
  setBrowserTab(session: TSession, tab: TTab | undefined): void;
  setBrowserHealth(session: TSession, health: THealth | undefined): void;
  joinTransport(params: {
    request: TRequest;
    session: TSession;
    context: MeetingSessionRuntimeJoinContext<TSession, TTransport, TMode, THealth, TTab>;
  }): Promise<{ delegatedSpoken?: boolean }>;
  releaseBrowserTab(session: TSession): Promise<boolean | undefined>;
  refreshBrowserHealth(
    session: TSession,
    options?: { force?: boolean; readOnly?: boolean },
  ): Promise<void>;
  refreshStatus(session: TSession): Promise<void>;
  refreshReusableSession(session: TSession): Promise<void>;
  ensureRealtimeBridge(
    session: TSession,
  ): Promise<MeetingSessionRuntimeHandles<THealth> | undefined>;
  captureTranscript(
    session: TSession,
    options?: { finalize?: boolean },
  ): Promise<MeetingTranscriptSnapshot | undefined>;
  speakViaTransport(
    session: TSession,
    instructions?: string,
  ): Promise<{ handled: boolean; spoken: boolean } | undefined>;
  defaultSpeechInstructions?: string;
};

export type MeetingSessionLeaveResult<TSession> = {
  found: boolean;
  session?: TSession;
  browserLeft?: boolean;
};

const nowIso = () => new Date().toISOString();

/** Shared lifecycle owner; platform strategies perform transport-specific I/O only. */
export class MeetingSessionRuntime<
  TSession extends MeetingSessionRecord<TTransport, TMode>,
  TRequest,
  TTransport extends string,
  TMode extends string,
  THealth extends MeetingBrowserHealth<TManualReason, TSpeechBlockedReason>,
  TTab extends MeetingBrowserTab,
  TManualReason extends string,
  TSpeechBlockedReason extends string,
> {
  readonly #sessions = new Map<string, TSession>();
  readonly #sessionLeaves = new Map<string, Promise<MeetingSessionLeaveResult<TSession>>>();
  readonly #sessionCleanup = new MeetingSessionCleanupTracker();
  readonly #meetingLock = new MeetingSessionJoinLock();
  readonly #sessionStops = new Map<string, () => Promise<void>>();
  readonly #sessionSpeakers = new Map<string, (instructions?: string) => void>();
  readonly #sessionHealth = new Map<string, () => Partial<THealth>>();
  readonly #transcriptStore: MeetingSessionTranscriptStore<TSession>;

  constructor(
    private readonly options: MeetingSessionRuntimeOptions<
      TSession,
      TRequest,
      TTransport,
      TMode,
      THealth,
      TTab,
      TManualReason,
      TSpeechBlockedReason
    >,
  ) {
    this.#transcriptStore = new MeetingSessionTranscriptStore({
      getSession: (sessionId) => this.#sessions.get(sessionId),
      isBrowserSession: (session) => this.options.isBrowserTransport(session.transport),
      isTranscribeSession: (session) => this.options.isTranscribeMode(session.mode),
      hasBrowserTab: (session) => Boolean(this.options.getBrowser(session)?.tab),
      capture: async (session, captureOptions) =>
        await this.options.captureTranscript(session, captureOptions),
    });
  }

  list(): TSession[] {
    this.refreshHealth();
    return [...this.#sessions.values()].toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getSession(sessionId: string): TSession | undefined {
    return this.#sessions.get(sessionId);
  }

  async status(sessionId?: string): Promise<{
    found: boolean;
    session?: TSession;
    sessions?: TSession[];
  }> {
    this.refreshHealth(sessionId);
    if (!sessionId) {
      const sessions = [...this.#sessions.values()].toSorted((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      );
      await Promise.all(sessions.map((session) => this.options.refreshStatus(session)));
      return { found: true, sessions };
    }
    const session = this.#sessions.get(sessionId);
    if (session) {
      await this.options.refreshStatus(session);
    }
    return session ? { found: true, session } : { found: false };
  }

  async transcript(sessionId: string, options: { sinceIndex?: number } = {}) {
    return await this.#transcriptStore.read(sessionId, options);
  }

  isReusableSession(session: TSession, resolved: MeetingResolvedJoin<TTransport, TMode>): boolean {
    return (
      session.state === "active" &&
      this.options.sameMeetingUrl(session.url, resolved.url) &&
      session.transport === resolved.transport &&
      session.mode === resolved.mode &&
      session.agentId === resolved.agentId
    );
  }

  async join(request: TRequest): Promise<{ session: TSession; spoken?: boolean }> {
    const resolved = this.options.resolveJoin(request);
    // Session publication follows async transport setup. Serialize every transport so
    // concurrent identical joins cannot both create an external participant.
    return await this.#meetingLock.run(
      this.#meetingKey(resolved.transport, resolved.url),
      async () => await this.#joinUnlocked(request, resolved),
    );
  }

  async leave(
    sessionId: string,
    options?: { keepBrowserTab?: boolean },
  ): Promise<MeetingSessionLeaveResult<TSession>> {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      return { found: false };
    }
    return await this.#meetingLock.run(
      this.#meetingKey(session.transport, session.url),
      async () => await this.#leaveUnlocked(sessionId, options),
    );
  }

  async speak(
    sessionId: string,
    instructions?: string,
  ): Promise<{ found: boolean; spoken: boolean; session?: TSession }> {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      return { found: false, spoken: false };
    }
    if (session.state !== "active") {
      return { found: true, spoken: false, session };
    }
    const delegated = await this.options.speakViaTransport(session, instructions);
    if (session.state !== "active") {
      return { found: true, spoken: false, session };
    }
    if (delegated?.handled) {
      return { found: true, spoken: delegated.spoken, session };
    }
    await this.refreshBrowserHealth(session);
    if (session.state !== "active") {
      return { found: true, spoken: false, session };
    }
    const handles = await this.options.ensureRealtimeBridge(session);
    if (session.state !== "active") {
      // A concurrent leave can finish while bridge startup awaits. Stop the late bridge
      // instead of attaching it to an ended session with no remaining cleanup owner.
      await handles?.stop?.();
      return { found: true, spoken: false, session };
    }
    if (handles) {
      this.#attachRuntimeHandles(session, handles);
    }
    const speak = this.#sessionSpeakers.get(sessionId);
    if (!speak || session.state !== "active") {
      return { found: true, spoken: false, session };
    }
    const readiness = this.refreshSpeechReadiness(session);
    if (!readiness.ready) {
      const note = readiness.message
        ? `Realtime speech blocked: ${readiness.message}`
        : this.options.messages.speechBlockedFallback;
      this.#noteSession(session, note);
      session.updatedAt = nowIso();
      return { found: true, spoken: false, session };
    }
    speak(instructions || this.options.defaultSpeechInstructions);
    session.updatedAt = nowIso();
    this.refreshHealth(sessionId);
    return { found: true, spoken: true, session };
  }

  async speakWhenReady(session: TSession, instructions: string): Promise<boolean> {
    let result = await this.speak(session.id, instructions);
    if (result.spoken || !this.options.isBrowserTransport(session.transport)) {
      return result.spoken;
    }
    const waitMs = Math.min(
      Math.max(0, this.options.waitForInCallMs),
      Math.max(0, this.options.joinTimeoutMs),
    );
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now())));
      });
      result = await this.speak(session.id, instructions);
      if (result.spoken) {
        return true;
      }
      const health = this.options.getBrowser(result.session as TSession)?.health;
      if (health?.manualActionRequired || result.session?.state !== "active") {
        return false;
      }
      const blocked = health?.speechBlockedReason;
      if (blocked && !this.options.transientSpeechBlockedReasons.has(blocked)) {
        return false;
      }
    }
    return false;
  }

  hasHealthHandle(sessionId: string): boolean {
    return this.#sessionHealth.has(sessionId);
  }

  refreshHealth(sessionId?: string): void {
    const ids = sessionId ? [sessionId] : [...this.#sessionHealth.keys()];
    for (const id of ids) {
      const session = this.#sessions.get(id);
      const getHealth = this.#sessionHealth.get(id);
      const browser = session ? this.options.getBrowser(session) : undefined;
      if (!session || !browser || !getHealth) {
        continue;
      }
      this.options.setBrowserHealth(session, { ...browser.health, ...getHealth() } as THealth);
      this.refreshSpeechReadiness(session);
    }
  }

  async refreshBrowserHealth(
    session: TSession,
    options: { force?: boolean; readOnly?: boolean } = {},
  ): Promise<void> {
    if (!this.#isManagedBrowserSession(session)) {
      this.refreshSpeechReadiness(session);
      return;
    }
    if (
      !options.force &&
      this.options.isTalkBackMode(session.mode) &&
      this.#evaluateSpeechReadiness(session).ready
    ) {
      this.refreshSpeechReadiness(session);
      return;
    }
    await this.options.refreshBrowserHealth(session, options);
    this.refreshSpeechReadiness(session);
  }

  async refreshCaptionHealth(session: TSession): Promise<void> {
    if (!this.options.isTranscribeMode(session.mode)) {
      this.refreshSpeechReadiness(session);
      return;
    }
    await this.refreshBrowserHealth(session);
  }

  refreshSpeechReadiness(session: TSession): {
    ready: boolean;
    reason?: TSpeechBlockedReason;
    message?: string;
  } {
    const readiness = this.#evaluateSpeechReadiness(session);
    if (readiness.ready) {
      session.notes = session.notes.filter((note) => !note.startsWith("Realtime speech blocked:"));
    }
    const browser = this.options.getBrowser(session);
    if (browser) {
      this.options.setBrowserHealth(session, {
        ...browser.health,
        speechReady: readiness.ready,
        speechBlockedReason: readiness.reason,
        speechBlockedMessage: readiness.message,
      } as THealth);
    }
    return readiness;
  }

  markSessionEnded(session: TSession, reason: string): void {
    session.state = "ended";
    session.updatedAt = nowIso();
    this.#dropRuntimeHandles(session.id);
    this.#noteSession(session, reason);
  }

  async #joinUnlocked(
    request: TRequest,
    resolved: MeetingResolvedJoin<TTransport, TMode>,
  ): Promise<{ session: TSession; spoken?: boolean }> {
    const activeSessions = this.list().filter(
      (session) =>
        session.state === "active" &&
        this.options.sameMeetingUrl(session.url, resolved.url) &&
        session.transport === resolved.transport,
    );
    const retained: Array<{ session: TSession; tab: TTab }> = [];
    if (this.options.isBrowserTransport(resolved.transport)) {
      // A reused browser tab has one lifecycle owner. End every incompatible record
      // before adoption so leaving an older session cannot tear down the new one.
      for (const session of activeSessions) {
        if (this.isReusableSession(session, resolved)) {
          continue;
        }
        const browser = this.options.getBrowser(session);
        const tab = this.options.reuseExistingBrowserTab ? browser?.tab : undefined;
        const keepBrowserParticipant = Boolean(tab) || browser?.launched === false;
        if (tab) {
          retained.push({ session, tab });
        }
        try {
          const left = await this.#leaveUnlocked(
            session.id,
            keepBrowserParticipant ? { keepBrowserTab: true } : undefined,
          );
          if (left.browserLeft === false) {
            throw new Error(this.options.messages.previousBrowserLeaveFailed);
          }
        } catch (error) {
          await this.#settleRetainedBrowserTabsAfterFailure(retained);
          throw error;
        }
        this.#noteSession(session, this.options.messages.reassignedSessionNote);
      }
    }
    let reusable = activeSessions.find((session) => this.isReusableSession(session, resolved));
    if (reusable) {
      await this.options.refreshReusableSession(reusable);
      if (reusable.state !== "active") {
        reusable = undefined;
      }
    }
    const speechInstructions = this.options.resolveSpeechInstructions(request);
    if (reusable) {
      await this.refreshBrowserHealth(reusable);
      this.#noteSession(reusable, this.options.messages.reusedSessionNote);
      reusable.updatedAt = nowIso();
      const spoken =
        this.options.isTalkBackMode(resolved.mode) && speechInstructions
          ? await this.speakWhenReady(reusable, speechInstructions)
          : false;
      return { session: reusable, spoken };
    }

    const session = this.options.createSession({ request, resolved, createdAt: nowIso() });
    let delegatedSpoken: boolean;
    try {
      const result = await this.options.joinTransport({
        request,
        session,
        context: {
          attachRuntimeHandles: (target, handles) => this.#attachRuntimeHandles(target, handles),
          inheritedBrowserTab: (params) => this.#inheritBrowserTabOwnership(params),
        },
      });
      delegatedSpoken = result.delegatedSpoken === true;
      const browser = this.options.getBrowser(session);
      const settled = await this.#settleRetainedBrowserTabs(
        retained,
        browser?.tab
          ? { transport: session.transport, nodeId: browser.nodeId, tab: browser.tab }
          : undefined,
      );
      if (!settled) {
        throw new Error(this.options.messages.replacementBrowserLeaveFailed);
      }
    } catch (error) {
      // Failed joins are never published, so this catch is their only cleanup owner.
      // Stop attached transports and release the new browser participant before rethrowing.
      await this.#rollbackFailedJoinSession(session);
      await this.#settleRetainedBrowserTabsAfterFailure(retained);
      this.options.logger.warn(
        `${this.options.logScope} join failed: ${this.options.formatError(error)}`,
      );
      throw error;
    }

    this.#sessions.set(session.id, session);
    const spoken = delegatedSpoken
      ? true
      : this.options.isTalkBackMode(resolved.mode) && speechInstructions
        ? await this.speakWhenReady(session, speechInstructions)
        : false;
    return { session, spoken };
  }

  async #leaveUnlocked(
    sessionId: string,
    options?: { keepBrowserTab?: boolean },
  ): Promise<MeetingSessionLeaveResult<TSession>> {
    const inFlight = this.#sessionLeaves.get(sessionId);
    if (inFlight) {
      return await inFlight;
    }
    const session = this.#sessions.get(sessionId);
    if (!session) {
      return { found: false };
    }
    if (session.state === "ended" && !this.#sessionCleanup.isPending(sessionId)) {
      return {
        found: true,
        session,
        ...(session.browserLeft === undefined ? {} : { browserLeft: session.browserLeft }),
      };
    }
    const leave = this.#leaveSession(session, options);
    this.#sessionLeaves.set(sessionId, leave);
    try {
      return await leave;
    } finally {
      if (this.#sessionLeaves.get(sessionId) === leave) {
        this.#sessionLeaves.delete(sessionId);
      }
    }
  }

  async #leaveSession(
    session: TSession,
    options?: { keepBrowserTab?: boolean },
  ): Promise<MeetingSessionLeaveResult<TSession>> {
    const firstAttempt = this.#sessionCleanup.begin(session.id, session.browserLeft);
    if (firstAttempt && this.options.isTranscribeMode(session.mode)) {
      this.#transcriptStore.startFinalizing(session.id);
      await this.#transcriptStore.capture(session, { finalize: true }).catch((error: unknown) => {
        this.options.logger.debug?.(
          `${this.options.logScope} final transcript snapshot ignored: ${this.options.formatError(error)}`,
        );
      });
    }
    session.state = "ended";
    session.updatedAt = nowIso();
    this.#sessionSpeakers.delete(session.id);
    this.#sessionHealth.delete(session.id);
    const stop = this.#sessionStops.get(session.id);
    try {
      const cleanup = await this.#sessionCleanup.cleanup({
        sessionId: session.id,
        stop,
        keepBrowserTab: options?.keepBrowserTab === true,
        releaseBrowser: async () => await this.options.releaseBrowserTab(session),
      });
      session.browserLeft = cleanup.browserLeft;
      if (cleanup.stopSettled && stop && this.#sessionStops.get(session.id) === stop) {
        this.#sessionStops.delete(session.id);
      }
      if (cleanup.complete) {
        this.#dropRuntimeHandles(session.id);
      }
      return {
        found: true,
        session,
        ...(cleanup.browserLeft === undefined ? {} : { browserLeft: cleanup.browserLeft }),
      };
    } finally {
      if (firstAttempt) {
        this.#transcriptStore.retire(session.id);
        this.#transcriptStore.finishFinalizing(session.id);
      }
    }
  }

  #meetingKey(transport: TTransport, url: string): string {
    const meeting = this.options.normalizeMeetingUrlForReuse(url) ?? url;
    return `${transport}:${meeting}`;
  }

  #inheritBrowserTabOwnership(params: {
    session: TSession;
    transport: TTransport;
    nodeId?: string;
    meetingUrl: string;
    tab?: TTab;
  }): TTab | undefined {
    if (!params.tab) {
      return undefined;
    }
    const inherited = [...this.#sessions.values()].some((session) => {
      const browser = this.options.getBrowser(session);
      const browserTab = browser?.tab;
      return (
        session.transport === params.transport &&
        this.options.sameMeetingUrl(session.url, params.meetingUrl) &&
        browser?.nodeId === params.nodeId &&
        browserTab?.targetId === params.tab?.targetId &&
        browserTab?.openedByPlugin === true
      );
    });
    return inherited ? { ...params.tab, openedByPlugin: true } : params.tab;
  }

  async #settleRetainedBrowserTabs(
    retained: Array<{ session: TSession; tab: TTab }>,
    adopted?: { transport: TTransport; nodeId?: string; tab: TTab },
  ): Promise<boolean> {
    let settled = true;
    for (let index = 0; index < retained.length;) {
      const retainedTab = retained[index];
      if (!retainedTab) {
        break;
      }
      const { session, tab } = retainedTab;
      const browser = this.options.getBrowser(session);
      const adoptedThisTab =
        adopted?.transport === session.transport &&
        adopted.nodeId === browser?.nodeId &&
        adopted.tab.targetId === tab.targetId;
      if (adoptedThisTab) {
        this.options.setBrowserTab(session, undefined);
        retained.splice(index, 1);
        continue;
      }
      if ((await this.options.releaseBrowserTab(session)) === false) {
        settled = false;
        index += 1;
        continue;
      }
      // Consume only after settlement succeeds. A rejection leaves this entry and the
      // remaining tail available to the failed-join rollback path for another attempt.
      retained.splice(index, 1);
    }
    return settled;
  }

  async #rollbackFailedJoinSession(session: TSession): Promise<void> {
    await this.#sessionCleanup.rollbackFailedJoin({
      sessionId: session.id,
      browserLeft: session.browserLeft,
      leave: async () => await this.#leaveSession(session),
      hasBrowserTab: () => Boolean(this.options.getBrowser(session)?.tab),
      releaseBrowser: async () => await this.options.releaseBrowserTab(session),
      formatError: (error) => this.options.formatError(error),
      warn: (message) => this.options.logger.warn(`${this.options.logScope} ${message}`),
      onBrowserResult: (left) => (session.browserLeft = left),
      onComplete: () => this.#dropRuntimeHandles(session.id),
    });
  }

  async #settleRetainedBrowserTabsAfterFailure(
    retained: Array<{ session: TSession; tab: TTab }>,
  ): Promise<void> {
    // Failed reassignment has no future owner for retained tabs. Try twice while
    // preserving entries between attempts, but never replace the original join error.
    for (let attempt = 0; attempt < 2 && retained.length > 0; attempt += 1) {
      try {
        if (await this.#settleRetainedBrowserTabs(retained)) {
          return;
        }
      } catch (error) {
        this.options.logger.warn(
          `${this.options.logScope} retained browser cleanup failed: ${this.options.formatError(error)}`,
        );
      }
    }
    if (retained.length > 0) {
      this.options.logger.warn(
        `${this.options.logScope} retained browser cleanup incomplete after failed join`,
      );
    }
  }

  #attachRuntimeHandles(session: TSession, handles: MeetingSessionRuntimeHandles<THealth>): void {
    if (handles.stop) {
      this.#sessionStops.set(session.id, handles.stop);
    }
    if (handles.speak) {
      this.#sessionSpeakers.set(session.id, handles.speak);
    }
    if (handles.getHealth) {
      this.#sessionHealth.set(session.id, handles.getHealth);
    }
  }

  #dropRuntimeHandles(sessionId: string): void {
    this.#sessionStops.delete(sessionId);
    this.#sessionSpeakers.delete(sessionId);
    this.#sessionHealth.delete(sessionId);
  }

  #isManagedBrowserSession(session: TSession): boolean {
    const browser = this.options.getBrowser(session);
    return Boolean(this.options.isBrowserTransport(session.transport) && browser?.launched);
  }

  #evaluateSpeechReadiness(session: TSession): {
    ready: boolean;
    reason?: TSpeechBlockedReason;
    message?: string;
  } {
    const speech = this.options.messages.speech;
    const browser = this.options.getBrowser(session);
    if (!this.options.isTalkBackMode(session.mode) || !browser) {
      return { ready: true };
    }
    if (!this.#isManagedBrowserSession(session)) {
      return browser.hasAudioBridge
        ? { ready: true }
        : {
            ready: false,
            reason: speech.audioBridgeUnavailableReason,
            message: speech.audioBridgeUnavailable,
          };
    }
    const health = browser.health;
    if (health?.manualActionRequired) {
      return {
        ready: false,
        reason: (health.manualActionReason ??
          speech.browserUnverifiedReason) as TSpeechBlockedReason,
        message: health.manualActionMessage ?? speech.manualActionFallback,
      };
    }
    if (health?.inCall === true) {
      if (health.micMuted !== false) {
        const muted = health.micMuted === true;
        // Unknown is transiently blocked: omitted mic controls cannot prove talk-back readiness.
        return {
          ready: false,
          reason: muted ? speech.microphoneMutedReason : speech.browserUnverifiedReason,
          message: muted ? speech.microphoneMuted : speech.browserUnverified,
        };
      }
      return browser.hasAudioBridge
        ? { ready: true }
        : {
            ready: false,
            reason: speech.audioBridgeUnavailableReason,
            message: speech.audioBridgeUnavailable,
          };
    }
    if (health?.inCall === false) {
      return { ready: false, reason: speech.notInCallReason, message: speech.notInCall };
    }
    return {
      ready: false,
      reason: speech.browserUnverifiedReason,
      message: speech.browserUnverified,
    };
  }

  #noteSession(session: TSession, note: string): void {
    session.notes = [...session.notes.filter((item) => item !== note), note];
  }
}
