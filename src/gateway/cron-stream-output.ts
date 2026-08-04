import {
  markCronStreamBatchTruncated,
  resolveCronStreamBatching,
  truncateCronStreamBatch,
  type CronStreamSchedule,
} from "../cron/stream-schedule.js";
import type { CronJob } from "../cron/types.js";
import { compileSafeRegex, testRegexWithBoundedInput } from "../security/safe-regex.js";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";

const MAX_BUFFERED_OUTPUT_SEGMENTS = 64;
// Raw intake between drains is bounded at a multiple of the batch cap so a
// normal large pipe read (Node buffers up to 64 KiB per callback) does not
// lose complete lines to OS chunk boundaries, while a stalled owner queue
// still cannot buffer unbounded output.
const INTAKE_CAP_MULTIPLIER = 4;

type StreamOutputChannel = "stdout" | "stderr";

type InFlightBatch = {
  batch: string;
  sourceIdentity: string;
  startedAtMs: number;
  promise: Promise<CronStreamFireDisposition>;
  handled: boolean;
};

// A drop severs the retained partial line, but only a "midline" drop leaves
// the next fragment's head inside an unknown line; a drop that ended at a
// newline boundary lets the next fragment start a clean line.
type DroppedTail = false | "clean" | "midline";

type BufferedOutput = {
  channel: StreamOutputChannel;
  chunk: string;
  generation: number;
  truncatedTail: boolean;
  truncatedTailContinuesLine: boolean;
  // Chunks for this channel were dropped between the previous accepted
  // fragment and this one; the retained partial line is severed either way.
  precededByDrop: DroppedTail;
};

type FireDisposition = "fired" | "disabled" | "dropped" | "busy" | "error" | "not-run";
type OwnerState = "idle" | "starting" | "running" | "stopping" | "stopped" | "backoff";
type Log = (obj: unknown, msg?: string) => void;
type CronStreamOutputStopState = { sourceBatchLost: boolean; pendingBatchLost: boolean };

export type CronStreamJob = CronJob & { schedule: CronStreamSchedule };
export type CronStreamFireDisposition = FireDisposition;
export type CronStreamLossReason = "gate-drop" | "coalesced" | "not-running" | "payload-error";
export type CronStreamOwnerState = OwnerState;
export type CronStreamLogger = { info: Log; warn: Log };

type CronStreamOutputParams = {
  job: CronStreamJob;
  scheduleKey: string;
  sourceIdentity: string;
  minIntervalMs: number;
  settleTimeoutMs: number;
  nowMs: () => number;
  fireBatch: (
    job: CronJob,
    batch: string,
    streamScheduleKey: string,
    streamSourceIdentity: string,
  ) => Promise<CronStreamFireDisposition>;
  recordLoss: (reason: CronStreamLossReason) => Promise<void>;
  enqueue: (label: string, operation: () => Promise<void>) => Promise<void>;
  requestTriggerDisabledStop: () => void;
  getGeneration: () => number;
  getState: () => CronStreamOwnerState;
  isDesiredRunning: () => boolean;
  isRetired: () => boolean;
  logger: CronStreamLogger;
};

const clearTimer = (timer: NodeJS.Timeout | undefined): void => clearTimeout(timer);

function appendBatch(left: string | undefined, right: string, maxBytes: number): string {
  return left === undefined ? right : truncateCronStreamBatch(`${left}\n${right}`, maxBytes);
}

async function waitForInFlightBatch(
  promise: Promise<CronStreamFireDisposition>,
  timeoutMs: number,
) {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(
        (disposition) => ({ settled: true as const, disposition }),
        (error: unknown) => ({ settled: true as const, error }),
      ),
      new Promise<{ settled: false }>((resolve) => {
        timeout = setTimeout(() => resolve({ settled: false }), timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    clearTimer(timeout);
  }
}

/** Owns one stream source's bounded output and dispatch cadence. */
export class CronStreamOutput {
  private job: CronStreamJob;
  private scheduleKey: string;
  private sourceIdentity: string;
  private matcher?: RegExp;
  private quietTimer?: NodeJS.Timeout;
  private rateTimer?: NodeJS.Timeout;
  private quietEpoch = 0;
  private rateEpoch = 0;
  private bufferedOutput: BufferedOutput[] = [];
  private bufferedOutputBytes = 0;
  private readonly queuedOutputDrainGenerations = new Set<number>();
  private readonly outputOverflowGenerations = new Set<number>();
  private droppedChunkTail: Record<StreamOutputChannel, DroppedTail> = {
    stdout: false,
    stderr: false,
  };
  private partialLines: Record<StreamOutputChannel, string> = { stdout: "", stderr: "" };
  private discardUntilNewline: Record<StreamOutputChannel, boolean> = {
    stdout: false,
    stderr: false,
  };
  private batch = "";
  private batchHasLines = false;
  private pendingBatch?: string;
  private firing?: InFlightBatch;
  private lastFireStartedAtMs: number;
  private nextEligibleAttemptAtMs: number;

  constructor(private readonly params: CronStreamOutputParams) {
    this.job = params.job;
    this.scheduleKey = params.scheduleKey;
    this.sourceIdentity = params.sourceIdentity;
    this.matcher = this.compileMatcher(params.job.schedule);
    this.lastFireStartedAtMs = params.job.state.lastRunAtMs ?? 0;
    this.nextEligibleAttemptAtMs = params.job.state.lastRunAtMs
      ? params.job.state.lastRunAtMs + params.minIntervalMs
      : 0;
  }

  updateSource(job: CronStreamJob, scheduleKey: string, sourceIdentity: string): void {
    this.job = job;
    this.scheduleKey = scheduleKey;
    this.sourceIdentity = sourceIdentity;
    this.matcher = this.compileMatcher(job.schedule);
  }

  snapshot() {
    return {
      bufferedOutputBytes: this.bufferedOutputBytes,
      bufferedOutputSegments: this.bufferedOutput.length,
    };
  }

  enqueueChunk(channel: StreamOutputChannel, chunk: string, generation: number): void {
    const state = this.params.getState();
    if (
      !chunk ||
      generation !== this.params.getGeneration() ||
      (state !== "starting" && state !== "running")
    ) {
      return;
    }
    const { maxBatchBytes } = resolveCronStreamBatching(this.job.schedule);
    const remaining = maxBatchBytes * INTAKE_CAP_MULTIPLIER - this.bufferedOutputBytes;
    if (
      this.outputOverflowGenerations.has(generation) ||
      remaining <= 0 ||
      this.bufferedOutput.length >= MAX_BUFFERED_OUTPUT_SEGMENTS
    ) {
      // The last drop wins: a terminal newline in the dropped data closes the
      // broken line, so the next accepted fragment starts a clean line.
      this.droppedChunkTail[channel] = chunk.endsWith("\n") ? "clean" : "midline";
      this.outputOverflowGenerations.add(generation);
      this.queueOutputDrain(generation);
      return;
    }
    const accepted = truncateUtf8Prefix(chunk, remaining);
    const truncatedTail = accepted !== chunk;
    const truncatedTailContinuesLine =
      truncatedTail && !chunk.slice(accepted.length).endsWith("\n");
    const acceptedBytes = Buffer.byteLength(accepted, "utf8");
    if (acceptedBytes === 0 && chunk.length > 0) {
      this.droppedChunkTail[channel] = chunk.endsWith("\n") ? "clean" : "midline";
      this.outputOverflowGenerations.add(generation);
      this.queueOutputDrain(generation);
      return;
    }
    const precededByDrop = this.droppedChunkTail[channel];
    this.droppedChunkTail[channel] = false;
    const last = this.bufferedOutput.at(-1);
    // Never merge across a dropped gap: the gap severed the line boundary.
    if (last?.channel === channel && last.generation === generation && !precededByDrop) {
      last.chunk += accepted;
      last.truncatedTail ||= truncatedTail;
      last.truncatedTailContinuesLine ||= truncatedTailContinuesLine;
    } else {
      this.bufferedOutput.push({
        channel,
        chunk: accepted,
        generation,
        truncatedTail,
        truncatedTailContinuesLine,
        precededByDrop,
      });
    }
    this.bufferedOutputBytes += acceptedBytes;
    if (truncatedTail) {
      this.outputOverflowGenerations.add(generation);
    }
    this.queueOutputDrain(generation);
  }

  async drainBufferedOutput(generation: number): Promise<void> {
    const buffered = this.bufferedOutput.filter((entry) => entry.generation === generation);
    this.bufferedOutput = this.bufferedOutput.filter((entry) => entry.generation !== generation);
    this.bufferedOutputBytes = this.bufferedOutput.reduce(
      (total, entry) => total + Buffer.byteLength(entry.chunk, "utf8"),
      0,
    );
    const overflowed = this.outputOverflowGenerations.delete(generation);
    if (generation !== this.params.getGeneration()) {
      return;
    }
    for (const entry of buffered) {
      if (this.params.getState() !== "running") {
        if (this.params.getState() !== "stopped") {
          await this.params.recordLoss("not-running");
        }
        continue;
      }
      await this.acceptChunk(entry);
    }
    if (overflowed && this.params.getState() === "running") {
      await this.params.recordLoss("coalesced");
    }
  }

  async flushSourceOutput(generation: number): Promise<void> {
    for (const channel of ["stdout", "stderr"] as const) {
      const partialLine = this.partialLines[channel];
      // A dropped continuation makes the retained EOF prefix indeterminate;
      // child exit must not turn that prefix into a complete matchable line.
      if (!this.discardUntilNewline[channel] && !this.droppedChunkTail[channel] && partialLine) {
        await this.acceptLine(
          partialLine.endsWith("\r") ? partialLine.slice(0, -1) : partialLine,
          generation,
          false,
        );
      }
      this.partialLines[channel] = "";
      this.discardUntilNewline[channel] = false;
      this.droppedChunkTail[channel] = false;
    }
    clearTimer(this.quietTimer);
    this.quietTimer = undefined;
    const batch = this.takeOpenBatch();
    if (batch !== undefined) {
      await this.handleClosedBatch(batch, generation);
    }
  }

  beginStop(): CronStreamOutputStopState {
    clearTimer(this.rateTimer);
    this.rateTimer = undefined;
    ++this.rateEpoch;
    const state = {
      sourceBatchLost: this.hasAcceptedSourceInput(),
      pendingBatchLost: this.pendingBatch !== undefined,
    };
    this.pendingBatch = undefined;
    this.resetSourceBuffers();
    return state;
  }

  async finishStop(state: CronStreamOutputStopState): Promise<void> {
    if (state.sourceBatchLost) {
      await this.params.recordLoss("not-running");
    }
    if (state.pendingBatchLost) {
      await this.params.recordLoss("not-running");
    }
    const firing = this.firing;
    if (firing && !firing.handled) {
      const result = await waitForInFlightBatch(firing.promise, this.params.settleTimeoutMs);
      if (!result.settled) {
        await this.params.recordLoss("not-running");
        firing.handled = true;
      } else if ("error" in result) {
        this.params.logger.warn(
          { jobId: this.job.id, err: String(result.error) },
          "cron-stream: batch fire failed during stop",
        );
        await this.params.recordLoss("payload-error");
        firing.handled = true;
      } else {
        await this.classifyFireDisposition(firing, result.disposition, true);
      }
    }
    this.firing = undefined;
  }

  async dropPendingForTerminalStop(): Promise<void> {
    clearTimer(this.rateTimer);
    this.rateTimer = undefined;
    ++this.rateEpoch;
    if (this.pendingBatch === undefined) {
      return;
    }
    this.pendingBatch = undefined;
    await this.params.recordLoss("not-running");
  }

  resetSourceBuffers(): void {
    clearTimer(this.quietTimer);
    this.quietTimer = undefined;
    ++this.quietEpoch;
    this.partialLines = { stdout: "", stderr: "" };
    this.discardUntilNewline = { stdout: false, stderr: false };
    this.droppedChunkTail = { stdout: false, stderr: false };
    this.batch = "";
    this.batchHasLines = false;
    this.bufferedOutput = [];
    this.bufferedOutputBytes = 0;
    this.queuedOutputDrainGenerations.clear();
    this.outputOverflowGenerations.clear();
  }

  schedulePendingIfNeeded(generation: number): void {
    if (this.pendingBatch === undefined || this.params.getState() !== "running") {
      return;
    }
    const nextAt = Math.max(
      this.nextEligibleAttemptAtMs,
      this.lastFireStartedAtMs + this.params.minIntervalMs,
    );
    this.schedulePendingFire(Math.max(0, nextAt - this.params.nowMs()), generation);
  }

  private queueOutputDrain(generation: number): void {
    if (this.queuedOutputDrainGenerations.has(generation)) {
      return;
    }
    this.queuedOutputDrainGenerations.add(generation);
    void this.params.enqueue("output", async () => {
      try {
        await this.drainBufferedOutput(generation);
      } finally {
        this.queuedOutputDrainGenerations.delete(generation);
        const currentGeneration = this.params.getGeneration();
        if (
          this.bufferedOutput.some((entry) => entry.generation === currentGeneration) ||
          this.outputOverflowGenerations.has(currentGeneration)
        ) {
          this.queueOutputDrain(currentGeneration);
        }
      }
    });
  }

  private async acceptChunk(entry: BufferedOutput): Promise<void> {
    const { channel, chunk, truncatedTail, truncatedTailContinuesLine, generation } = entry;
    if (entry.precededByDrop) {
      // The dropped gap severed the retained partial line; never synthesize a
      // line across it. Only a midline drop leaves this fragment's head inside
      // an unknown line — after a clean drop it starts a fresh line.
      this.partialLines[channel] = "";
      this.discardUntilNewline[channel] = entry.precededByDrop === "midline";
    }
    const { maxBatchBytes } = resolveCronStreamBatching(this.job.schedule);
    // The per-line byte cap is the raw-intake bound, not the delivery cap, and
    // it applies while assembling the line: a line must match identically
    // whether pipe callbacks split it or not, and a line over the bound is an
    // unprovable prefix no matter how its fragments arrived.
    const partialCapBytes = maxBatchBytes * INTAKE_CAP_MULTIPLIER;
    let text = `${this.partialLines[channel]}${chunk}`;
    this.partialLines[channel] = "";
    for (;;) {
      const newline = text.indexOf("\n");
      if (newline < 0) {
        break;
      }
      const rawLine = text.slice(0, newline);
      text = text.slice(newline + 1);
      if (this.discardUntilNewline[channel]) {
        this.discardUntilNewline[channel] = false;
        continue;
      }
      const overCap = Buffer.byteLength(rawLine, "utf8") > partialCapBytes;
      const boundedLine = overCap ? truncateUtf8Prefix(rawLine, partialCapBytes) : rawLine;
      await this.acceptLine(
        boundedLine.endsWith("\r") ? boundedLine.slice(0, -1) : boundedLine,
        generation,
        overCap,
      );
    }
    if (this.discardUntilNewline[channel]) {
      return;
    }
    if (truncatedTail || Buffer.byteLength(text, "utf8") > partialCapBytes) {
      const rawLine = truncateUtf8Prefix(text, partialCapBytes);
      if (rawLine) {
        await this.acceptLine(
          rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine,
          generation,
          true,
        );
      }
      this.discardUntilNewline[channel] = truncatedTail ? truncatedTailContinuesLine : true;
      return;
    }
    this.partialLines[channel] = text;
  }

  private async acceptLine(line: string, generation: number, truncated: boolean): Promise<void> {
    if (truncated && this.matcher) {
      // A truncated prefix cannot prove the full oversized line matches: an
      // end-anchored or length-sensitive pattern would false-fire on the cut.
      // Match mode treats oversized lines as unmatched, like any other miss.
      return;
    }
    // Match the raw source line before adding our synthetic truncation marker.
    if (!this.matchesLine(line)) {
      return;
    }
    const { batchMs, maxBatchBytes } = resolveCronStreamBatching(this.job.schedule);
    const renderedLine = truncated ? markCronStreamBatchTruncated(line, maxBatchBytes) : line;
    const candidate = this.batchHasLines ? `${this.batch}\n${renderedLine}` : renderedLine;
    const capped = truncateCronStreamBatch(candidate, maxBatchBytes);
    this.batch = capped;
    this.batchHasLines = true;
    clearTimer(this.quietTimer);
    this.quietTimer = undefined;
    const epoch = ++this.quietEpoch;
    if (capped !== candidate || Buffer.byteLength(capped, "utf8") >= maxBatchBytes) {
      const batch = this.takeOpenBatch();
      if (batch !== undefined) {
        await this.handleClosedBatch(batch, generation);
      }
      return;
    }
    this.quietTimer = setTimeout(() => {
      void this.closeQuietBatch(generation, epoch);
    }, batchMs);
    this.quietTimer.unref?.();
  }

  private closeQuietBatch(generation: number, epoch: number): Promise<void> {
    return this.params.enqueue("batch-closed", async () => {
      if (generation !== this.params.getGeneration()) {
        return;
      }
      if (this.params.getState() !== "running" || epoch !== this.quietEpoch) {
        if (
          this.params.getState() !== "stopped" &&
          epoch === this.quietEpoch &&
          this.batchHasLines
        ) {
          this.takeOpenBatch();
          await this.params.recordLoss("not-running");
        }
        return;
      }
      clearTimer(this.quietTimer);
      this.quietTimer = undefined;
      const batch = this.takeOpenBatch();
      if (batch !== undefined) {
        await this.handleClosedBatch(batch, generation);
      }
    });
  }

  private takeOpenBatch(): string | undefined {
    if (!this.batchHasLines) {
      return undefined;
    }
    const batch = this.batch;
    this.batch = "";
    this.batchHasLines = false;
    return batch;
  }

  private async handleClosedBatch(batch: string, generation: number): Promise<void> {
    // Child callbacks are generation-scoped; pending logical batches are not.
    if (generation !== this.params.getGeneration()) {
      return;
    }
    if (!this.params.isDesiredRunning() || this.params.getState() !== "running") {
      if (this.params.getState() !== "stopped") {
        await this.params.recordLoss("not-running");
      }
      return;
    }

    const { maxBatchBytes } = resolveCronStreamBatching(this.job.schedule);
    const spacingRemaining =
      Math.max(this.nextEligibleAttemptAtMs, this.lastFireStartedAtMs + this.params.minIntervalMs) -
      this.params.nowMs();
    if (this.firing || spacingRemaining > 0 || this.pendingBatch !== undefined) {
      this.pendingBatch = appendBatch(this.pendingBatch, batch, maxBatchBytes);
      await this.params.recordLoss("coalesced");
      if (!this.firing) {
        this.schedulePendingFire(Math.max(0, spacingRemaining), generation);
      }
      return;
    }
    this.startFire(batch, generation);
  }

  private startFire(batch: string, generation: number): void {
    if (generation !== this.params.getGeneration()) {
      return;
    }
    if (!this.params.isDesiredRunning() || this.params.isRetired()) {
      void this.params.recordLoss("not-running");
      return;
    }
    const attemptStartedAtMs = this.params.nowMs();
    this.nextEligibleAttemptAtMs = attemptStartedAtMs + this.params.minIntervalMs;
    const firing: InFlightBatch = {
      batch,
      sourceIdentity: this.sourceIdentity,
      startedAtMs: attemptStartedAtMs,
      promise: this.params.fireBatch(this.job, batch, this.scheduleKey, this.sourceIdentity),
      handled: false,
    };
    this.firing = firing;
    void firing.promise.then(
      (disposition) => this.fireCompleted(firing, disposition),
      (error: unknown) => this.fireRejected(firing, error),
    );
  }

  private ownsFiring(firing: InFlightBatch): boolean {
    if (firing.handled) {
      return false;
    }
    if (this.firing === firing && firing.sourceIdentity === this.sourceIdentity) {
      return true;
    }
    firing.handled = true;
    if (this.firing === firing) {
      this.firing = undefined;
    }
    return false;
  }

  private fireCompleted(
    firing: InFlightBatch,
    disposition: CronStreamFireDisposition,
  ): Promise<void> {
    return this.params.enqueue("fire-completed", async () => {
      if (!this.ownsFiring(firing)) {
        return;
      }
      await this.classifyFireDisposition(firing, disposition, false);
      this.firing = undefined;
      this.schedulePendingIfNeeded(this.params.getGeneration());
    });
  }

  private fireRejected(firing: InFlightBatch, error: unknown): Promise<void> {
    return this.params.enqueue("fire-rejected", async () => {
      if (!this.ownsFiring(firing)) {
        return;
      }
      this.params.logger.warn(
        { jobId: this.job.id, err: String(error) },
        "cron-stream: batch fire failed",
      );
      await this.params.recordLoss("payload-error");
      firing.handled = true;
      this.firing = undefined;
      this.schedulePendingIfNeeded(this.params.getGeneration());
    });
  }

  private async classifyFireDisposition(
    firing: InFlightBatch,
    disposition: CronStreamFireDisposition,
    stopping: boolean,
  ): Promise<void> {
    if (firing.handled) {
      return;
    }
    firing.handled = true;
    if (disposition === "fired" || disposition === "disabled") {
      // `disabled` means the batch fired and a once-trigger disabled the job.
      this.lastFireStartedAtMs = firing.startedAtMs;
      if (disposition === "disabled" && !stopping) {
        this.params.requestTriggerDisabledStop();
      }
      return;
    }
    if (disposition === "dropped" || disposition === "error") {
      await this.params.recordLoss(disposition === "dropped" ? "gate-drop" : "payload-error");
      return;
    }
    if (
      disposition === "busy" &&
      !stopping &&
      this.params.isDesiredRunning() &&
      this.params.getState() !== "stopped"
    ) {
      const { maxBatchBytes } = resolveCronStreamBatching(this.job.schedule);
      this.pendingBatch =
        this.pendingBatch === undefined
          ? firing.batch
          : appendBatch(firing.batch, this.pendingBatch, maxBatchBytes);
      return;
    }
    await this.params.recordLoss("not-running");
  }

  private schedulePendingFire(delayMs: number, generation: number): void {
    clearTimer(this.rateTimer);
    const rateEpoch = ++this.rateEpoch;
    this.rateTimer = setTimeout(() => {
      void this.attemptPendingFire(generation, rateEpoch);
    }, delayMs);
    this.rateTimer.unref?.();
  }

  private attemptPendingFire(generation: number, rateEpoch: number): Promise<void> {
    return this.params.enqueue("pending-fire", async () => {
      if (rateEpoch !== this.rateEpoch) {
        return;
      }
      this.rateTimer = undefined;
      if (this.pendingBatch === undefined) {
        return;
      }
      if (generation !== this.params.getGeneration()) {
        if (this.params.isDesiredRunning() && this.params.getState() === "running") {
          this.schedulePendingIfNeeded(this.params.getGeneration());
        }
        return;
      }
      const state = this.params.getState();
      if (state === "starting" || state === "backoff") {
        // The logical batch survives until the replacement child is running.
        return;
      }
      if (!this.params.isDesiredRunning()) {
        this.pendingBatch = undefined;
        if (state !== "stopped") {
          await this.params.recordLoss("not-running");
        }
        return;
      }
      if (state !== "running") {
        if (state !== "stopped") {
          this.pendingBatch = undefined;
          await this.params.recordLoss("not-running");
        }
        return;
      }
      if (this.firing) {
        return;
      }
      const spacingRemaining =
        Math.max(
          this.nextEligibleAttemptAtMs,
          this.lastFireStartedAtMs + this.params.minIntervalMs,
        ) - this.params.nowMs();
      if (spacingRemaining > 0) {
        this.schedulePendingFire(spacingRemaining, generation);
        return;
      }
      const pending = this.pendingBatch;
      this.pendingBatch = undefined;
      this.startFire(pending, generation);
    });
  }

  private compileMatcher(schedule: CronStreamSchedule): RegExp | undefined {
    return (schedule.mode ?? "line") === "match"
      ? (compileSafeRegex(schedule.match ?? "") ?? undefined)
      : undefined;
  }

  private matchesLine(line: string): boolean {
    return !this.matcher || testRegexWithBoundedInput(this.matcher, line);
  }

  private hasAcceptedSourceInput(): boolean {
    if (this.batchHasLines) {
      return true;
    }
    for (const channel of ["stdout", "stderr"] as const) {
      let text = this.partialLines[channel];
      let discardUntilNewline = this.discardUntilNewline[channel];
      for (const entry of this.bufferedOutput) {
        if (entry.channel === channel) {
          if (entry.precededByDrop) {
            // Mirror acceptChunk: dropped gaps sever line assembly.
            text = "";
            discardUntilNewline = entry.precededByDrop === "midline";
          }
          text += entry.chunk;
        }
      }
      for (;;) {
        const newline = text.indexOf("\n");
        if (newline < 0) {
          break;
        }
        const rawLine = text.slice(0, newline);
        text = text.slice(newline + 1);
        if (discardUntilNewline) {
          discardUntilNewline = false;
          continue;
        }
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (this.matchesLine(line)) {
          return true;
        }
      }
      if (discardUntilNewline || !text) {
        continue;
      }
      if (this.droppedChunkTail[channel]) {
        // The retained partial's continuation was dropped; its final line is
        // indeterminate and must not count as accepted source input.
        continue;
      }
      if (this.matcher) {
        // Mirror acceptChunk: a leftover past the raw-intake bound would be
        // truncated before matching, so match mode must not count it.
        const { maxBatchBytes } = resolveCronStreamBatching(this.job.schedule);
        if (Buffer.byteLength(text, "utf8") > maxBatchBytes * INTAKE_CAP_MULTIPLIER) {
          continue;
        }
      }
      const line = text.endsWith("\r") ? text.slice(0, -1) : text;
      if (this.matchesLine(line)) {
        return true;
      }
    }
    return false;
  }
}
