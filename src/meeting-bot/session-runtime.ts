import type {
  TranscriptStartRequest,
  TranscriptsStartResult,
  TranscriptStopRequest,
  TranscriptsStopResult,
} from "../transcripts/provider-types.js";
import { MeetingSessionCleanupTracker } from "./session-cleanup-tracker.js";
import { MeetingSessionDurableTranscripts } from "./session-durable-transcripts.js";
import { MeetingSessionJoinLock } from "./session-join-lock.js";
import type {
  MeetingSessionRuntimeHandles,
  MeetingSessionCleanupOwner,
  MeetingSessionRuntimeOptions,
  MeetingSessionLeaveResult,
} from "./session-runtime-types.js";
import { evaluateMeetingSpeechReadiness } from "./session-speech-readiness.js";
import { MeetingSessionTranscriptStore } from "./session-transcript-store.js";
import type {
  MeetingBrowserHealth,
  MeetingBrowserTab,
  MeetingResolvedJoin,
  MeetingSessionRecord,
} from "./session-types.js";
export type {
  MeetingBrowserSessionView,
  MeetingSessionRuntimeHandles,
  MeetingSessionRuntimeJoinContext,
  MeetingSessionRuntimeMessages,
  MeetingSessionRuntimeOptions,
  MeetingSessionLeaveResult,
} from "./session-runtime-types.js";

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
  readonly #sessionStops = new Map<string, MeetingSessionCleanupOwner>();
  readonly #sessionSpeakers = new Map<string, (instructions?: string) => void>();
  readonly #sessionHealth = new Map<string, () => Partial<THealth>>();
  readonly #durableTranscripts: MeetingSessionDurableTranscripts<TSession>;
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
      onLines: async (session, lines) => await this.#durableTranscripts.ingest(session, lines),
    });
    this.#durableTranscripts = new MeetingSessionDurableTranscripts({
      config: options.durableTranscripts,
      formatError: (error) => options.formatError(error),
      isBrowserSession: (session) => options.isBrowserTransport(session.transport),
      isTranscribeSession: (session) => options.isTranscribeMode(session.mode),
      listSessions: () => [...this.#sessions.values()],
      logger: options.logger,
      logScope: options.logScope,
      sameMeetingUrl: (left, right) => options.sameMeetingUrl(left, right),
      transcriptStore: this.#transcriptStore,
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

  async startTranscriptSource(request: TranscriptStartRequest): Promise<TranscriptsStartResult> {
    return await this.#durableTranscripts.startSource(request);
  }

  async stopTranscriptSource(request: TranscriptStopRequest): Promise<TranscriptsStopResult> {
    return await this.#durableTranscripts.stopSource(request);
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
    // The meeting lock fences joins and leaves before terminal transcript work;
    // #sessionLeaves then coalesces retries owned by the same session.
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
    await this.#ensureRealtimeBridge(session);
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
      if (health?.manualAction || result.session?.state !== "active") {
        return false;
      }
      const blocked = health?.speechBlockedReason;
      if (blocked && !this.options.transientSpeechBlockedReasons.has(blocked)) {
        return false;
      }
    }
    return false;
  }

  async #ensureRealtimeBridge(session: TSession): Promise<void> {
    const sessionId = session.id;
    const owner: MeetingSessionCleanupOwner = this.#sessionStops.get(sessionId) ?? {};
    this.#sessionStops.set(sessionId, owner);
    const isCurrent = () =>
      this.#sessions.get(sessionId) === session && this.#sessionStops.get(sessionId) === owner;
    try {
      await this.#sessionCleanup.recover({
        sessionId,
        owner,
        browserLeft: session.browserLeft,
        isCurrent,
        isActive: () => session.state === "active",
        setup: (onCleanupReady) => this.options.ensureRealtimeBridge(session, onCleanupReady),
        clearAdmission: () => {
          this.#sessionSpeakers.delete(sessionId);
          this.#sessionHealth.delete(sessionId);
        },
        attach: (handles) => this.#attachRuntimeHandles(session, handles),
        retainPending: () => this.#retainPendingCleanup(session),
      });
    } finally {
      if (isCurrent()) {
        if (this.#sessionCleanup.finishSetup(sessionId, !owner.stop)) {
          this.#dropRuntimeHandles(sessionId);
        } else if (!owner.stop && !owner.recovery && !this.#sessionCleanup.isPending(sessionId)) {
          this.#sessionStops.delete(sessionId);
        }
      }
    }
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
    for (const pending of this.#sessions.values()) {
      if (
        pending.state === "ended" &&
        this.#hasPendingEngineCleanup(pending.id) &&
        pending.transport === resolved.transport &&
        this.options.sameMeetingUrl(pending.url, resolved.url)
      ) {
        await this.#leaveUnlocked(pending.id);
        this.#requireSettledEngineCleanup(pending.id);
      }
    }
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
          this.#requireSettledEngineCleanup(session.id);
        } catch (error) {
          await this.#settleRetainedBrowserTabsAfterFailure(retained);
          throw error;
        }
        this.#noteSession(session, this.options.messages.reassignedSessionNote);
      }
    }
    let reusable = activeSessions.find((session) => this.isReusableSession(session, resolved));
    if (reusable) {
      const refreshResult = await this.options.refreshReusableSession(reusable, request, resolved);
      if (reusable.state !== "active") {
        // The refresh hook runs inside the join lock, so it marks stale sessions
        // ended and lets this owner perform cleanup without recursive lock entry.
        await this.#leaveSession(reusable, {
          keepBrowserTab: refreshResult?.keepBrowserTab ?? true,
        });
        this.#requireSettledEngineCleanup(reusable.id);
        reusable = undefined;
      }
    }
    const speechInstructions = this.options.resolveSpeechInstructions(request);
    if (reusable) {
      await this.#durableTranscripts.start(reusable);
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
      // Roll back the new participant before reporting startup failure.
      // Unfinished cleanup remains addressable for a later leave.
      await this.#rollbackFailedJoinSession(session);
      if (this.#sessionCleanup.isPending(session.id)) {
        this.#retainPendingCleanup(session);
      }
      await this.#settleRetainedBrowserTabsAfterFailure(retained);
      this.options.logger.warn(
        `${this.options.logScope} join failed: ${this.options.formatError(error)}`,
      );
      throw error;
    }

    this.#sessions.set(session.id, session);
    await this.#durableTranscripts.start(session);
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
    const transcribe = this.options.isTranscribeMode(session.mode);
    let transcriptStopped = false;
    if (transcribe) {
      // Fence new live reads before final capture; the store's capture chain drains
      // reads already admitted before this terminal boundary.
      this.#transcriptStore.startFinalizing(session.id);
    }
    try {
      transcriptStopped = await this.#durableTranscripts.stop(session, {
        allowFallback: firstAttempt,
      });
      session.state = "ended";
      session.updatedAt = nowIso();
      this.#sessionSpeakers.delete(session.id);
      this.#sessionHealth.delete(session.id);
      const owner = this.#sessionStops.get(session.id);
      const stop = owner?.stop;
      const cleanup = await this.#sessionCleanup.cleanup({
        sessionId: session.id,
        stop: stop
          ? async () => {
              await stop();
              if (owner?.stop === stop) {
                owner.stop = undefined;
              }
            }
          : undefined,
        hasPendingSetup: () => Boolean(owner?.recovery),
        isStopSettled: () => !owner?.stop,
        keepBrowserTab: options?.keepBrowserTab === true,
        releaseBrowser: async () => await this.options.releaseBrowserTab(session),
      });
      session.browserLeft = cleanup.browserLeft;
      const browser = this.options.getBrowser(session);
      if (cleanup.browserLeft === true && browser?.health) {
        this.options.setBrowserHealth(session, {
          ...browser.health,
          inCall: false,
          micMuted: undefined,
          manualAction: undefined,
          speechReady: false,
          speechBlockedReason: undefined,
          speechBlockedMessage: undefined,
        } as THealth);
      }
      if (cleanup.stopSettled && !owner?.recovery && this.#sessionStops.get(session.id) === owner) {
        this.#sessionStops.delete(session.id);
      }
      if (cleanup.complete) {
        this.#dropRuntimeHandles(session.id);
      } else if (this.#sessions.get(session.id) === session) {
        this.#retainPendingCleanup(session);
      }
      return {
        found: true,
        session,
        ...(cleanup.browserLeft === undefined ? {} : { browserLeft: cleanup.browserLeft }),
      };
    } finally {
      if (transcriptStopped) {
        this.#transcriptStore.retire(session.id);
      }
      if (transcribe) {
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
    if (session.state !== "active") {
      throw new Error("Meeting session ended before runtime attachment");
    }
    if (handles.stop) {
      const owner: MeetingSessionCleanupOwner = this.#sessionStops.get(session.id) ?? {};
      if (owner.stop && owner.stop !== handles.stop) {
        throw new Error("Meeting cleanup must settle before replacing its runtime");
      }
      owner.stop = handles.stop;
      this.#sessionStops.set(session.id, owner);
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
    const session = this.#sessions.get(sessionId);
    if (session) {
      session.notes = session.notes.filter(
        (note) => !note.startsWith("Cleanup remains pending for session "),
      );
    }
  }

  #retainPendingCleanup(session: TSession): void {
    session.state = "ended";
    session.updatedAt = nowIso();
    this.#sessionSpeakers.delete(session.id);
    this.#sessionHealth.delete(session.id);
    this.#sessions.set(session.id, session);
    const note = `Cleanup remains pending for session ${session.id}. Use this meeting plugin's status and leave commands to retry cleanup.`;
    this.#noteSession(session, note);
    this.options.logger.warn(`${this.options.logScope} ${note}`);
  }

  #requireSettledEngineCleanup(sessionId: string): void {
    if (this.#hasPendingEngineCleanup(sessionId)) {
      throw new Error(
        `Meeting cleanup remains pending for session ${sessionId}; retry leave before joining again.`,
      );
    }
  }

  #hasPendingEngineCleanup(sessionId: string): boolean {
    const owner = this.#sessionStops.get(sessionId);
    return Boolean(owner?.stop || owner?.recovery);
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
    return evaluateMeetingSpeechReadiness({
      browser: this.options.getBrowser(session),
      managedBrowser: this.#isManagedBrowserSession(session),
      speech: this.options.messages.speech,
      talkBack: this.options.isTalkBackMode(session.mode),
    });
  }

  #noteSession(session: TSession, note: string): void {
    session.notes = [...session.notes.filter((item) => item !== note), note];
  }
}
