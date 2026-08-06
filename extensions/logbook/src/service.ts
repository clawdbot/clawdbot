// Logbook background service: snapshot capture loop, batch analysis, retention.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalizeBase64 } from "openclaw/plugin-sdk/media-runtime";
import type {
  OpenClawConfig,
  OpenClawPluginApi,
  PluginLogger,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  CARD_LOOKBACK_MS,
  MAX_FRAMES_PER_CALL,
  parseCardsJson,
  parseObservationSegments,
  pickKeyframeId,
  revisionWindow,
  sampleFrames,
  selectBatchFrames,
  validateCardCoverage,
} from "./analyze.js";
import { parseModelRef, type LogbookConfig } from "./config.js";
import {
  buildAskPrompt,
  buildCardsCorrectionPrompt,
  buildCardsPrompt,
  buildObservationInstructions,
  buildStandupPrompt,
  OBSERVATION_JSON_SCHEMA,
} from "./prompts.js";
import { dayKeyFor, LogbookStore } from "./store.js";
import type { LogbookBatch, LogbookCard } from "./types.js";

const ANALYSIS_TICK_MS = 60 * 1000;
const PRUNE_TICK_MS = 60 * 60 * 1000;
const MODEL_MISSING_MESSAGE =
  "no vision model: set plugins.entries.logbook.config.visionModel or configure tools.media";
const MODEL_MISSING_LOG_INTERVAL_MS = 10 * 60 * 1000;
const CAPTURE_FAILURE_PAUSE_TICKS = 10;
const CAPTURE_FAILURE_THRESHOLD = 3;
const JPEG_QUALITY = 0.6;
// Only Codex currently implements the structured image-extraction contract.
// Borrowed defaults must not select a provider that will fail every batch.
const STRUCTURED_MEDIA_PROVIDER = "codex";
type SnapshotPayload = {
  format?: string;
  base64?: unknown;
  width?: number;
  height?: number;
  error?: string;
};

/** node.invoke responses wrap the node result in {payload, payloadJSON}. */
function unwrapInvokePayload(raw: unknown): SnapshotPayload | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const envelope = raw as { payload?: unknown; payloadJSON?: string | null };
  if (envelope.payload && typeof envelope.payload === "object") {
    return envelope.payload as SnapshotPayload;
  }
  if (typeof envelope.payloadJSON === "string" && envelope.payloadJSON.length > 0) {
    try {
      return JSON.parse(envelope.payloadJSON) as SnapshotPayload;
    } catch {
      return null;
    }
  }
  // Tolerate transports that already deliver the bare node payload.
  return "base64" in envelope || "error" in envelope ? (envelope as SnapshotPayload) : null;
}

/** Capture commands in preference order: app nodes first, headless node hosts second. */
const CAPTURE_COMMANDS = ["screen.snapshot", "logbook.snapshot"] as const;

type LogbookStatus = {
  captureEnabled: boolean;
  capturePaused: boolean;
  captureIntervalSeconds: number;
  analysisIntervalMinutes: number;
  retentionDays: number;
  nodeId?: string;
  nodeName?: string;
  lastCaptureAtMs?: number;
  lastCaptureError?: string;
  pendingFrames: number;
  analysisRunning: boolean;
  lastBatch?: Pick<LogbookBatch, "id" | "day" | "status" | "endMs" | "error">;
  visionModel?: string;
  visionModelSource: "config" | "media-defaults" | "missing";
  today: string;
  todayCards: number;
  timeZone: string;
};

export class LogbookService {
  private store: LogbookStore | null = null;
  private captureTimer: NodeJS.Timeout | null = null;
  private analysisTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private captureInFlight = false;
  private analysisInFlight = false;
  private capturePaused = false;
  private captureFailures = 0;
  private captureBackoffTicks = 0;
  private lastCaptureAtMs: number | undefined;
  private lastCaptureError: string | undefined;
  private lastModelMissingLogMs = 0;
  private cachedNode: { nodeId: string; displayName?: string; command: string } | null = null;
  // Nodes whose captures failed this rotation; skipped until every candidate
  // has failed once, then retried so transient outages self-heal.
  private failedNodeIds = new Set<string>();

  constructor(
    private readonly config: LogbookConfig,
    private readonly deps: {
      runtime: NonNullable<OpenClawPluginApi["runtime"]>;
      fullConfig: OpenClawConfig;
      logger: PluginLogger;
      dataDir: string;
    },
  ) {}

  start(): void {
    this.store = new LogbookStore(this.deps.dataDir);
    // Batches interrupted by a gateway restart go back to pending.
    this.store.resetRunningBatches();
    this.captureTimer = setInterval(() => {
      void this.captureTick();
    }, this.config.captureIntervalSeconds * 1000);
    this.captureTimer.unref?.();
    this.analysisTimer = setInterval(() => {
      void this.analysisTick();
    }, ANALYSIS_TICK_MS);
    this.analysisTimer.unref?.();
    this.pruneTimer = setInterval(() => {
      this.prune();
    }, PRUNE_TICK_MS);
    this.pruneTimer.unref?.();
    this.prune();
    this.deps.logger.info(
      `logbook: started (capture every ${this.config.captureIntervalSeconds}s, analysis window ${this.config.analysisIntervalMinutes}m, data ${this.deps.dataDir})`,
    );
  }

  stop(): void {
    for (const timer of [this.captureTimer, this.analysisTimer, this.pruneTimer]) {
      if (timer) {
        clearInterval(timer);
      }
    }
    this.captureTimer = null;
    this.analysisTimer = null;
    this.pruneTimer = null;
    this.store?.close();
    this.store = null;
  }

  private requireStore(): LogbookStore {
    if (!this.store) {
      throw new Error("Logbook service is not running");
    }
    return this.store;
  }

  // ── Capture ────────────────────────────────────────────────────────

  setCapturePaused(paused: boolean): void {
    this.capturePaused = paused;
    if (!paused) {
      this.captureBackoffTicks = 0;
      this.captureFailures = 0;
    }
  }

  private async resolveNode(): Promise<
    { node: { nodeId: string; displayName?: string; command: string } } | { reason: string }
  > {
    if (this.cachedNode) {
      return { node: this.cachedNode };
    }
    const { nodes } = await this.deps.runtime.nodes.list({ connected: true });
    const captureCommand = (node: { commands?: string[] }) =>
      CAPTURE_COMMANDS.find((command) => (node.commands ?? []).includes(command));
    // App nodes (screen.snapshot) come first: plugin node-host commands are
    // advertised on every platform, but logbook.snapshot only captures on
    // macOS, so headless hosts are a fallback rather than the default pick.
    const commandRank = (node: { commands?: string[] }) =>
      CAPTURE_COMMANDS.indexOf(captureCommand(node) as (typeof CAPTURE_COMMANDS)[number]);
    const candidates = nodes
      .filter((node) => captureCommand(node) !== undefined)
      .toSorted((a, b) => commandRank(a) - commandRank(b) || a.nodeId.localeCompare(b.nodeId));
    const wanted = this.config.nodeId?.toLowerCase();
    // Failed nodes rotate to the back until everything has failed once;
    // without this, a broken node that sorts first is re-picked every tick.
    let pool = candidates.filter((node) => !this.failedNodeIds.has(node.nodeId));
    if (pool.length === 0) {
      this.failedNodeIds.clear();
      pool = candidates;
    }
    const picked = wanted
      ? candidates.find(
          (node) =>
            node.nodeId.toLowerCase() === wanted || node.displayName?.toLowerCase() === wanted,
        )
      : pool[0];
    const command = picked ? captureCommand(picked) : undefined;
    if (!picked || !command) {
      const inventory =
        nodes
          .map(
            (node) =>
              `${node.displayName ?? node.nodeId}(${(node.commands ?? []).join("/") || "no commands"})`,
          )
          .join(", ") || "none";
      return {
        reason: `no connected node exposes ${CAPTURE_COMMANDS.join(" or ")}; connected: ${inventory}`,
      };
    }
    this.cachedNode = { nodeId: picked.nodeId, displayName: picked.displayName, command };
    return { node: this.cachedNode };
  }

  private async captureTick(): Promise<void> {
    if (!this.config.captureEnabled || this.capturePaused || this.captureInFlight || !this.store) {
      return;
    }
    if (this.captureBackoffTicks > 0) {
      this.captureBackoffTicks -= 1;
      return;
    }
    this.captureInFlight = true;
    try {
      const resolved = await this.resolveNode();
      if ("reason" in resolved) {
        if (this.lastCaptureError !== resolved.reason) {
          this.deps.logger.warn(`logbook: ${resolved.reason}`);
        }
        this.lastCaptureError = resolved.reason;
        return;
      }
      const node = resolved.node;
      const invoked = await this.deps.runtime.nodes.invoke({
        nodeId: node.nodeId,
        command: node.command,
        params: {
          screenIndex: this.config.screenIndex,
          maxWidth: this.config.maxWidth,
          quality: JPEG_QUALITY,
          format: "jpeg",
        },
        timeoutMs: 30_000,
      });
      const raw = unwrapInvokePayload(invoked);
      if (raw?.error) {
        throw new Error(raw.error);
      }
      const rawBase64 = raw?.base64;
      if (rawBase64 === undefined || rawBase64 === "") {
        throw new Error(`${node.command} returned no image payload`);
      }
      if (typeof rawBase64 !== "string") {
        throw new Error(`${node.command} returned invalid image payload`);
      }
      const base64 = canonicalizeBase64(rawBase64);
      if (!base64) {
        throw new Error(`${node.command} returned invalid image payload`);
      }
      const buffer = Buffer.from(base64, "base64");
      const capturedAtMs = Date.now();
      const day = dayKeyFor(capturedAtMs);
      const contentHash = createHash("sha256").update(buffer).digest("hex");
      // Unchanged consecutive frames mean the user is idle (or away); they are
      // stored for the filmstrip but excluded from analysis batches.
      const idle = this.store.lastFrame()?.contentHash === contentHash;
      const filePath = this.store.frameFilePath(day, capturedAtMs);
      // Screen captures can contain secrets; keep them owner-only.
      mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      writeFileSync(filePath, buffer, { mode: 0o600 });
      this.store.insertFrame({
        capturedAtMs,
        day,
        path: filePath,
        screenIndex: this.config.screenIndex,
        width: raw?.width,
        height: raw?.height,
        byteSize: buffer.byteLength,
        contentHash,
        idle,
      });
      this.lastCaptureAtMs = capturedAtMs;
      this.lastCaptureError = undefined;
      this.captureFailures = 0;
      this.failedNodeIds.clear();
    } catch (err) {
      this.captureFailures += 1;
      if (this.cachedNode) {
        this.failedNodeIds.add(this.cachedNode.nodeId);
      }
      this.cachedNode = null;
      this.lastCaptureError = err instanceof Error ? err.message : String(err);
      if (this.captureFailures >= CAPTURE_FAILURE_THRESHOLD) {
        this.captureBackoffTicks = CAPTURE_FAILURE_PAUSE_TICKS;
        this.deps.logger.warn(
          `logbook: capture failing (${this.lastCaptureError}); backing off for ${CAPTURE_FAILURE_PAUSE_TICKS} ticks`,
        );
      }
    } finally {
      this.captureInFlight = false;
    }
  }

  // ── Analysis ───────────────────────────────────────────────────────

  private resolveVisionModel(): {
    ref?: { provider: string; model: string; profile?: string; preferredProfile?: string };
    source: LogbookStatus["visionModelSource"];
  } {
    if (this.config.visionModel) {
      const ref = parseModelRef(this.config.visionModel);
      return ref ? { ref, source: "config" } : { source: "missing" };
    }
    const media = this.deps.fullConfig.tools?.media;
    // Operators who disabled image understanding must not have screenshots
    // routed to a provider via the borrowed media defaults.
    if (media?.image?.enabled === false) {
      return { source: "missing" };
    }
    const entries = media?.models ?? [];
    for (const entry of entries) {
      const usable =
        entry.type !== "cli" &&
        entry.provider?.trim().toLowerCase() === STRUCTURED_MEDIA_PROVIDER &&
        typeof entry.model === "string" &&
        (!entry.capabilities || entry.capabilities.includes("image"));
      if (usable) {
        return {
          // Auth profile fields ride along so profile-scoped media credentials
          // keep working when Logbook borrows the media-understanding default.
          ref: {
            provider: STRUCTURED_MEDIA_PROVIDER,
            model: entry.model as string,
            profile: entry.profile,
            preferredProfile: entry.preferredProfile,
          },
          source: "media-defaults",
        };
      }
    }
    return { source: "missing" };
  }

  async analyzeNow(): Promise<{ started: boolean; reason?: string }> {
    const store = this.requireStore();
    if (this.analysisInFlight) {
      return { started: false, reason: "analysis already running" };
    }
    if (!this.resolveVisionModel().ref) {
      return { started: false, reason: MODEL_MISSING_MESSAGE };
    }
    // Explicit user action is the retry path for failed batches; automatic
    // retries could loop model spend on a persistently failing batch.
    store.resetErrorBatches();
    if (!store.nextPendingBatch()) {
      const frames = store.unbatchedActiveFrames(2000);
      // Force-close the current window so "analyze now" needs no elapsed time.
      const selection = selectBatchFrames({
        frames,
        windowMs: this.config.analysisIntervalMinutes * 60_000,
        nowMs: Date.now(),
        force: true,
      });
      if (!selection) {
        return { started: false, reason: "no unanalyzed activity captured yet" };
      }
      store.createBatch({
        day: dayKeyFor(selection.startMs),
        startMs: selection.startMs,
        endMs: selection.endMs,
        frameIds: selection.frameIds,
      });
    }
    void this.analysisTick();
    return { started: true };
  }

  private async analysisTick(): Promise<void> {
    if (this.analysisInFlight || !this.store) {
      return;
    }
    // Without a vision model, leave frames unbatched and batches pending so
    // everything analyzes once the operator configures one; erroring here
    // would permanently strand the assigned frames.
    if (!this.resolveVisionModel().ref) {
      const now = Date.now();
      if (now - this.lastModelMissingLogMs > MODEL_MISSING_LOG_INTERVAL_MS) {
        this.lastModelMissingLogMs = now;
        this.deps.logger.warn(`logbook: analysis paused; ${MODEL_MISSING_MESSAGE}`);
      }
      return;
    }
    this.analysisInFlight = true;
    try {
      this.enqueueElapsedWindow();
      for (let i = 0; i < 4; i += 1) {
        const batch = this.store.nextPendingBatch();
        if (!batch) {
          return;
        }
        await this.runBatch(batch);
      }
    } catch (err) {
      this.deps.logger.error(`logbook: analysis tick failed: ${String(err)}`);
    } finally {
      this.analysisInFlight = false;
    }
  }

  private enqueueElapsedWindow(): void {
    const store = this.requireStore();
    // Windows close on elapsed wall-clock or on a capture gap; both cases are
    // resolved by selectBatchFrames against the oldest unbatched frame.
    while (true) {
      const frames = store.unbatchedActiveFrames(2000);
      const selection = selectBatchFrames({
        frames,
        windowMs: this.config.analysisIntervalMinutes * 60_000,
        nowMs: Date.now(),
      });
      if (!selection) {
        return;
      }
      store.createBatch({
        day: dayKeyFor(selection.startMs),
        startMs: selection.startMs,
        endMs: selection.endMs,
        frameIds: selection.frameIds,
      });
    }
  }

  private async runBatch(batch: LogbookBatch): Promise<void> {
    const store = this.requireStore();
    const vision = this.resolveVisionModel();
    if (!vision.ref) {
      // Stay pending: the analysis tick pauses until a model is configured.
      return;
    }
    store.setBatchStatus(
      batch.id,
      "running",
      undefined,
      `${vision.ref.provider}/${vision.ref.model}`,
    );
    try {
      const frames = store.batchFrames(batch.id);
      const sampled = sampleFrames(frames, MAX_FRAMES_PER_CALL);
      const images = sampled.map((frame) => ({
        type: "image" as const,
        buffer: readFileSync(frame.path),
        fileName: path.basename(frame.path),
        mime: "image/jpeg",
      }));
      const observationResult =
        await this.deps.runtime.mediaUnderstanding.extractStructuredWithModel({
          provider: vision.ref.provider,
          model: vision.ref.model,
          profile: vision.ref.profile,
          preferredProfile: vision.ref.preferredProfile,
          input: images,
          instructions: buildObservationInstructions({
            frameTimes: sampled.map((frame) => frame.capturedAtMs),
            startMs: batch.startMs,
            endMs: batch.endMs,
          }),
          schemaName: "logbook.observations",
          jsonSchema: OBSERVATION_JSON_SCHEMA,
          cfg: this.deps.fullConfig,
          timeoutMs: 180_000,
        });
      const segments = parseObservationSegments({
        raw: observationResult.text ?? "",
        day: batch.day,
        startMs: batch.startMs,
        endMs: batch.endMs,
      });
      if (segments.length === 0) {
        store.setBatchStatus(batch.id, "error", "vision model returned no usable segments");
        return;
      }
      store.replaceObservations(batch.id, batch.day, segments);
      await this.reviseCards(batch);
      store.setBatchStatus(batch.id, "done");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      store.setBatchStatus(batch.id, "error", message);
      this.deps.logger.warn(`logbook: batch ${batch.id} failed: ${message}`);
    }
  }

  private async reviseCards(batch: LogbookBatch): Promise<void> {
    const store = this.requireStore();
    const lookbackStart = batch.startMs - CARD_LOOKBACK_MS;
    const previousCards = store
      .cardsForDay(batch.day)
      .filter((card) => card.endMs > lookbackStart && card.startMs < batch.endMs);
    const observations = store.observationsInRange(
      batch.day,
      Math.min(lookbackStart, batch.startMs),
      batch.endMs,
    );
    const window = revisionWindow({
      batchStartMs: batch.startMs,
      batchEndMs: batch.endMs,
      previousCards,
    });
    const prompt = buildCardsPrompt({
      day: batch.day,
      observations,
      previousCards,
      windowStartMs: window.startMs,
      windowEndMs: window.endMs,
    });
    // Coverage is validated alongside parsing: a partial-but-valid output must
    // trigger the repair round-trip instead of erasing previous cards below.
    const requiredSpans = [
      ...previousCards.map((card) => ({ startMs: card.startMs, endMs: card.endMs })),
      { startMs: batch.startMs, endMs: batch.endMs },
    ];
    const evaluate = (raw: string) => {
      const parsed = parseCardsJson({
        raw,
        day: batch.day,
        windowStartMs: window.startMs,
        windowEndMs: window.endMs,
      });
      if (!parsed.ok) {
        return parsed;
      }
      const coverage = validateCardCoverage({
        drafts: parsed.drafts,
        requiredSpans,
        windowStartMs: window.startMs,
        windowEndMs: window.endMs,
      });
      return coverage.ok ? parsed : { ok: false as const, error: coverage.error };
    };
    const first = await this.deps.runtime.llm.complete({
      messages: [{ role: "user", content: prompt }],
      purpose: "logbook.cards",
      maxTokens: 4000,
    });
    let parsed = evaluate(first.text);
    if (!parsed.ok) {
      const retry = await this.deps.runtime.llm.complete({
        messages: [
          { role: "user", content: prompt },
          { role: "assistant", content: first.text },
          { role: "user", content: buildCardsCorrectionPrompt(parsed.error) },
        ],
        purpose: "logbook.cards.repair",
        maxTokens: 4000,
      });
      parsed = evaluate(retry.text);
    }
    if (!parsed.ok) {
      throw new Error(`card synthesis failed validation: ${parsed.error}`);
    }
    const windowFrames = store
      .framesInRange(window.startMs, window.endMs)
      .map((frame) => ({ id: frame.id, capturedAtMs: frame.capturedAtMs }));
    const drafts = parsed.drafts.map((draft) =>
      Object.assign(draft, { keyframeId: pickKeyframeId(draft, windowFrames) }),
    );
    store.replaceCardsInWindow(batch.day, window.startMs, window.endMs, drafts);
  }

  // ── Q&A / standup ──────────────────────────────────────────────────

  async standup(
    day: string,
    refresh: boolean,
  ): Promise<{ day: string; text: string; updatedMs: number }> {
    const store = this.requireStore();
    if (!refresh) {
      const cached = store.getStandup(day);
      if (cached) {
        return cached;
      }
    }
    const previousDay = dayKeyFor(new Date(`${day}T12:00:00`).getTime() - 24 * 60 * 60 * 1000);
    const result = await this.deps.runtime.llm.complete({
      messages: [
        {
          role: "user",
          content: buildStandupPrompt({
            day,
            cards: store.cardsForDay(day),
            previousDayCards: store.cardsForDay(previousDay),
          }),
        },
      ],
      purpose: "logbook.standup",
      maxTokens: 800,
    });
    store.saveStandup(day, result.text.trim());
    const saved = store.getStandup(day);
    if (!saved) {
      throw new Error("standup save failed");
    }
    return saved;
  }

  async ask(day: string, question: string): Promise<string> {
    const store = this.requireStore();
    const observations = store.observationsInRange(day, 0, Number.MAX_SAFE_INTEGER).slice(-200);
    const result = await this.deps.runtime.llm.complete({
      messages: [
        {
          role: "user",
          content: buildAskPrompt({
            day,
            cards: store.cardsForDay(day),
            observations,
            question,
          }),
        },
      ],
      purpose: "logbook.ask",
      maxTokens: 600,
    });
    return result.text.trim();
  }

  // ── Introspection ──────────────────────────────────────────────────

  cardsForDay(day: string): LogbookCard[] {
    return this.requireStore().cardsForDay(day);
  }

  listDays(): ReturnType<LogbookStore["listDays"]> {
    return this.requireStore().listDays();
  }

  dayStats(day: string): ReturnType<LogbookStore["dayStats"]> {
    return this.requireStore().dayStats(day);
  }

  frameById(id: number): ReturnType<LogbookStore["frameById"]> {
    return this.requireStore().frameById(id);
  }

  framesInRange(startMs: number, endMs: number): ReturnType<LogbookStore["framesInRange"]> {
    return this.requireStore().framesInRange(startMs, endMs);
  }

  status(): LogbookStatus {
    const store = this.requireStore();
    const today = dayKeyFor(Date.now());
    const latestBatch = store.latestBatch();
    const vision = this.resolveVisionModel();
    return {
      captureEnabled: this.config.captureEnabled,
      capturePaused: this.capturePaused,
      captureIntervalSeconds: this.config.captureIntervalSeconds,
      analysisIntervalMinutes: this.config.analysisIntervalMinutes,
      retentionDays: this.config.retentionDays,
      nodeId: this.cachedNode?.nodeId ?? this.config.nodeId,
      nodeName: this.cachedNode?.displayName,
      lastCaptureAtMs: this.lastCaptureAtMs,
      lastCaptureError: this.lastCaptureError,
      pendingFrames: store.countUnbatchedActiveFrames(),
      analysisRunning: this.analysisInFlight,
      lastBatch: latestBatch
        ? {
            id: latestBatch.id,
            day: latestBatch.day,
            status: latestBatch.status,
            endMs: latestBatch.endMs,
            error: latestBatch.error,
          }
        : undefined,
      visionModel: vision.ref ? `${vision.ref.provider}/${vision.ref.model}` : undefined,
      visionModelSource: vision.source,
      today,
      todayCards: store.cardsForDay(today).length,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }

  private prune(): void {
    if (!this.store) {
      return;
    }
    const cutoff = Date.now() - this.config.retentionDays * 24 * 60 * 60 * 1000;
    const removed = this.store.pruneFrames(cutoff);
    if (removed > 0) {
      this.deps.logger.info(
        `logbook: pruned ${removed} frames older than ${this.config.retentionDays}d`,
      );
    }
  }
}
