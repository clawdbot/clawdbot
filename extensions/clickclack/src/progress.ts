/**
 * Publishes ClickClack's native ephemeral agent.progress signal for one
 * OpenClaw turn. ClickClack renders this as its compact "Agent is
 * responding" status and the detailed progress lines above the composer.
 */
import { buildChannelProgressDraftLine } from "openclaw/plugin-sdk/channel-outbound";

export type ClickClackItemEventPayload = {
  itemId?: string;
  toolCallId?: string;
  kind?: string;
  title?: string;
  name?: string;
  phase?: string;
  status?: string;
  summary?: string;
  progressText?: string;
  meta?: string;
};

type ClickClackProgressClient = {
  publishEphemeral(params: {
    workspaceId: string;
    channelId?: string;
    conversationId?: string;
    type: "agent.progress";
    payload?: Record<string, unknown>;
  }): Promise<void>;
};

type ClickClackProgressTarget = {
  workspaceId: string;
  channelId?: string;
  conversationId?: string;
};

function normalizedKind(payload: ClickClackItemEventPayload): string {
  const kind = payload.kind?.trim().toLowerCase();
  if (
    !kind ||
    kind === "preamble" ||
    kind === "analysis" ||
    kind === "thinking" ||
    kind === "reasoning" ||
    kind === "missing"
  ) {
    return "commentary";
  }
  return kind;
}

function progressText(payload: ClickClackItemEventPayload): string {
  const line = buildChannelProgressDraftLine({
    event: "item",
    itemId: payload.itemId,
    toolCallId: payload.toolCallId,
    itemKind: payload.kind,
    title: payload.title,
    name: payload.name,
    phase: payload.phase,
    status: payload.status,
    summary: payload.summary,
    progressText: payload.progressText,
    meta: payload.meta,
  })?.text?.trim();
  if (line) {
    return line;
  }
  return (
    payload.progressText?.trim() ||
    payload.summary?.trim() ||
    payload.title?.trim() ||
    payload.name?.trim() ||
    payload.meta?.trim() ||
    payload.status?.trim() ||
    "Working"
  );
}

function isFinal(payload: ClickClackItemEventPayload): boolean {
  const phase = payload.phase?.trim().toLowerCase();
  const status = payload.status?.trim().toLowerCase();
  return phase === "end" || status === "completed" || status === "failed" || status === "blocked";
}

type AnonymousLine = { id: string; active: boolean };

function createLineIdResolver(): (payload: ClickClackItemEventPayload) => string {
  const lineIdsByIdentity = new Map<string, string>();
  const anonymousLinesByKind = new Map<string, AnonymousLine[]>();
  let anonymousSequence = 0;

  return (payload) => {
    const identities = [payload.itemId?.replace(/^(tool|command):/, ""), payload.toolCallId]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value));
    const existingId = identities.map((identity) => lineIdsByIdentity.get(identity)).find(Boolean);
    if (existingId) {
      for (const identity of identities) {
        lineIdsByIdentity.set(identity, existingId);
      }
      return existingId;
    }
    if (identities.length > 0) {
      const id = `item:${identities[0]}`;
      for (const identity of identities) {
        lineIdsByIdentity.set(identity, id);
      }
      return id;
    }

    const kind = normalizedKind(payload);
    const anonymousLines = anonymousLinesByKind.get(kind) ?? [];
    const phase = payload.phase?.trim().toLowerCase();
    const existingAnonymous =
      phase === "start" ? undefined : anonymousLines.toReversed().find((line) => line.active);
    const line =
      existingAnonymous ??
      (() => {
        const created = { id: `item:${kind}:${++anonymousSequence}`, active: true };
        anonymousLines.push(created);
        anonymousLinesByKind.set(kind, anonymousLines);
        return created;
      })();
    if (isFinal(payload)) {
      line.active = false;
    }
    return line.id;
  };
}

type ClickClackAgentProgressPublisher = {
  start(): void;
  onItemEvent(payload: ClickClackItemEventPayload): false;
  finalize(): Promise<void>;
};

type QueuedProgressFrame = {
  lineId?: string;
  payload: Record<string, unknown>;
};

const CLICKCLACK_PROGRESS_UPDATE_INTERVAL_MS = 100;
const CLICKCLACK_PROGRESS_FINALIZE_GRACE_MS = 1_000;

export function createClickClackAgentProgressPublisher(params: {
  client: ClickClackProgressClient;
  target: ClickClackProgressTarget;
  turnId: string;
  agentLabel?: string;
  onError?: (error: unknown) => void;
}): ClickClackAgentProgressPublisher {
  let sequence = 0;
  const queue: QueuedProgressFrame[] = [];
  const queuedLines = new Map<string, QueuedProgressFrame>();
  let drainPromise: Promise<void> | undefined;
  let lineDrainTimer: ReturnType<typeof setTimeout> | undefined;
  let started = false;
  let cleared = false;
  const seenLines = new Set<string>();
  const resolveLineId = createLineIdResolver();

  const drain = (): Promise<void> => {
    if (drainPromise) {
      return drainPromise;
    }
    drainPromise = (async () => {
      while (queue.length > 0) {
        const frame = queue.shift();
        if (!frame) {
          continue;
        }
        if (frame.lineId) {
          queuedLines.delete(frame.lineId);
        }
        try {
          await params.client.publishEphemeral({
            ...params.target,
            type: "agent.progress",
            payload: {
              turn_id: params.turnId,
              seq: ++sequence,
              ...frame.payload,
            },
          });
        } catch (error) {
          try {
            params.onError?.(error);
          } catch {
            // Progress reporting must never affect the agent turn.
          }
        }
      }
    })().finally(() => {
      drainPromise = undefined;
      if (queue.length > 0) {
        void drain();
      }
    });
    return drainPromise;
  };

  const enqueue = (payload: Record<string, unknown>): void => {
    queue.push({ payload });
    void drain();
  };

  const flushQueuedLines = (): void => {
    for (const [lineId, frame] of queuedLines) {
      queuedLines.delete(lineId);
      queue.push(frame);
    }
    void drain();
  };

  const discardQueuedLines = (): void => {
    queuedLines.clear();
    const controlFrames = queue.filter((frame) => !frame.lineId);
    queue.splice(0, queue.length, ...controlFrames);
  };

  const waitForDrainWithinFinalizeGrace = async (pending: Promise<void>): Promise<boolean> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let drained = false;
    try {
      await Promise.race([
        pending.then(() => {
          drained = true;
        }),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, CLICKCLACK_PROGRESS_FINALIZE_GRACE_MS);
        }),
      ]);
      return drained;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  };

  const scheduleLineDrain = (): void => {
    if (lineDrainTimer) {
      return;
    }
    lineDrainTimer = setTimeout(() => {
      lineDrainTimer = undefined;
      flushQueuedLines();
    }, CLICKCLACK_PROGRESS_UPDATE_INTERVAL_MS);
  };

  const enqueueLine = (lineId: string, payload: Record<string, unknown>): void => {
    const queued = queuedLines.get(lineId);
    if (queued) {
      // Preserve an initial append while the request is in flight, but keep
      // only the newest line contents. A completion must still win so the
      // client can mark the line finalized when both arrive in one window.
      const op =
        payload.op === "finalize"
          ? "finalize"
          : queued.payload.op === "append"
            ? "append"
            : payload.op;
      queued.payload = { ...payload, ...(op ? { op } : {}) };
      return;
    }
    const frame = { lineId, payload };
    queuedLines.set(lineId, frame);
    scheduleLineDrain();
  };

  return {
    start() {
      if (started) {
        return;
      }
      started = true;
      enqueue({
        op: "append",
        line: {
          id: "turn",
          kind: "commentary",
          text: params.agentLabel ? `${params.agentLabel} is responding` : "Agent is responding",
          status: "running",
        },
      });
    },
    onItemEvent(payload) {
      if (!started || cleared) {
        return false;
      }
      const id = resolveLineId(payload);
      const final = isFinal(payload);
      const kind = normalizedKind(payload);
      const retractsExistingCommentary =
        kind === "commentary" &&
        seenLines.has(id) &&
        payload.progressText !== undefined &&
        payload.progressText.trim() === "";
      if (retractsExistingCommentary && queuedLines.get(id)?.payload.op === "append") {
        queuedLines.delete(id);
        seenLines.delete(id);
        return false;
      }
      const line: Record<string, unknown> = {
        id,
        kind,
        text: retractsExistingCommentary ? "" : progressText(payload),
        status: payload.status?.trim() || (final ? "completed" : "running"),
      };
      if (payload.name?.trim()) {
        line.tool_name = payload.name.trim();
      }
      enqueueLine(id, {
        op: final ? "finalize" : seenLines.has(id) ? "update" : "append",
        line,
      });
      seenLines.add(id);
      return false;
    },
    async finalize() {
      if (!started || cleared) {
        return;
      }
      cleared = true;
      if (lineDrainTimer) {
        clearTimeout(lineDrainTimer);
        lineDrainTimer = undefined;
      }
      flushQueuedLines();
      enqueue({ op: "clear" });
      const drained = await waitForDrainWithinFinalizeGrace(drain());
      if (!drained) {
        // Once the durable reply has been sent and the grace period expires,
        // stale detail frames no longer help the user. Keep only control frames
        // so the background queue reaches the best-effort clear promptly.
        discardQueuedLines();
      }
    },
  };
}
