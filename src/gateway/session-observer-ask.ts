import type { SessionObserverDigest } from "../../packages/gateway-protocol/src/schema/sessions.js";
import { resolveSessionAgentId } from "../agents/agent-scope.js";
import { flushSessionActivityAssistantNote } from "../agents/session-activity-notes.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  SessionObserverAskError,
  type SessionObserverService,
} from "./session-observer-contract.js";
import {
  sanitizeSessionObserverModelText,
  type SessionObserverDeps,
  type SessionObserverState,
} from "./session-observer-model.js";

const observerLog = createSubsystemLogger("gateway/session-observer");

const ASK_MODEL_TIMEOUT_MS = 10_000;
const ASK_MODEL_MAX_TOKENS = 400;
const ASK_ANSWER_MAX_CHARS = 600;
const MAX_CONCURRENT_ASKS = 6;
const ASK_RATE_WINDOW_MS = 60_000;
const MAX_ASKS_PER_RATE_WINDOW = 12;
const MAX_ASKS_PER_CONNECTION_RATE_WINDOW = 4;

const ASK_SYSTEM_PROMPT = [
  "You answer operator questions about a running AI agent session using only the supplied observation digest and notes.",
  "Do not infer details that are absent from the observations; plainly say when you cannot know.",
  "Return only a concise plain-text answer in American English, with no markdown or JSON wrapper.",
].join(" ");

type SessionObserverSnapshot = {
  agentId: string;
  runId?: string;
  digest?: SessionObserverDigest;
  notes: string[];
};

type SessionObserverAskRuntimeParams = {
  getConfig: SessionObserverDeps["getConfig"];
  subscribers: SessionObserverDeps["subscribers"];
  states: ReadonlyMap<string, SessionObserverState>;
  resolveUtilityModelRef: NonNullable<SessionObserverDeps["resolveUtilityModelRef"]>;
  prepareModel: NonNullable<SessionObserverDeps["prepareModel"]>;
  completeModel: NonNullable<SessionObserverDeps["completeModel"]>;
  readSession: NonNullable<SessionObserverDeps["readSession"]>;
  now: () => number;
  setTimeoutFn: NonNullable<SessionObserverDeps["setTimeoutFn"]>;
  clearTimeoutFn: NonNullable<SessionObserverDeps["clearTimeoutFn"]>;
  isDisposed: () => boolean;
};

function buildAskPrompt(params: {
  digest?: SessionObserverDigest;
  notes: readonly string[];
  question: string;
}): string {
  return JSON.stringify({
    digest: params.digest ?? null,
    notes: params.notes,
    question: params.question,
  });
}

export function createSessionObserverAskRuntime(params: SessionObserverAskRuntimeParams) {
  const askControllers = new Map<string, AbortController>();
  const askAdmissions: Array<{ connId: string; admittedAt: number }> = [];

  const getSnapshot = (sessionKey: string): SessionObserverSnapshot => {
    const state = params.states.get(sessionKey);
    if (state) {
      flushSessionActivityAssistantNote(state);
      return {
        agentId: state.agentId,
        runId: state.runId,
        ...(state.previousDigest ? { digest: state.previousDigest } : {}),
        // These strings were bounded and sanitized when they entered the note
        // buffer. Copy them verbatim so asks never reopen raw transcript data.
        notes: state.notes.map((note) => note.text),
      };
    }
    const cfg = params.getConfig();
    const agentId = resolveSessionAgentId({ sessionKey, config: cfg });
    const digest = params.readSession(sessionKey, agentId)?.observerDigest;
    return {
      agentId,
      ...(digest?.runId ? { runId: digest.runId } : {}),
      ...(digest ? { digest } : {}),
      notes: [],
    };
  };

  const ask: SessionObserverService["ask"] = async (request) => {
    const sessionKey = request.sessionKey.trim();
    const question = request.question.trim();
    if (!sessionKey || !question || params.isDisposed()) {
      throw new SessionObserverAskError("model-unavailable", "Session observer is unavailable.");
    }
    if (!params.subscribers.get(sessionKey).has(request.connId)) {
      throw new SessionObserverAskError(
        "not-subscribed",
        "Subscribe to this session before asking its observer.",
      );
    }
    const cfg = params.getConfig();
    if (cfg.gateway?.controlUi?.sessionObserver === false) {
      throw new SessionObserverAskError("disabled", "Session observer is disabled.");
    }
    if (askControllers.has(sessionKey)) {
      throw new SessionObserverAskError(
        "busy",
        "The session observer is answering another question.",
      );
    }
    const admittedAt = params.now();
    const cutoff = admittedAt - ASK_RATE_WINDOW_MS;
    while ((askAdmissions[0]?.admittedAt ?? admittedAt) < cutoff) {
      askAdmissions.shift();
    }
    const connectionAdmissions = askAdmissions.filter(
      (admission) => admission.connId === request.connId,
    );
    const globalRetryAfterMs =
      askAdmissions.length >= MAX_ASKS_PER_RATE_WINDOW
        ? Math.max(
            1,
            (askAdmissions[0]?.admittedAt ?? admittedAt) + ASK_RATE_WINDOW_MS - admittedAt,
          )
        : 0;
    const connectionRetryAfterMs =
      connectionAdmissions.length >= MAX_ASKS_PER_CONNECTION_RATE_WINDOW
        ? Math.max(
            1,
            (connectionAdmissions[0]?.admittedAt ?? admittedAt) + ASK_RATE_WINDOW_MS - admittedAt,
          )
        : 0;
    if (
      askControllers.size >= MAX_CONCURRENT_ASKS ||
      globalRetryAfterMs > 0 ||
      connectionRetryAfterMs > 0
    ) {
      throw new SessionObserverAskError(
        "rate-limited",
        "The session observer has reached its question limit. Try again shortly.",
        Math.max(
          askControllers.size >= MAX_CONCURRENT_ASKS ? ASK_MODEL_TIMEOUT_MS : 0,
          globalRetryAfterMs,
          connectionRetryAfterMs,
        ),
      );
    }
    const snapshot = getSnapshot(sessionKey);
    const utilityModelRef = params.resolveUtilityModelRef({ cfg, agentId: snapshot.agentId });
    if (!utilityModelRef) {
      throw new SessionObserverAskError(
        "utility-model-unavailable",
        "No utility model is configured for this session.",
      );
    }
    // Read-scoped asks can spend utility-model quota. Bound admission across
    // sessions and connections before any provider-backed preparation starts.
    askAdmissions.push({ connId: request.connId, admittedAt });
    const controller = new AbortController();
    askControllers.set(sessionKey, controller);
    const timeout = params.setTimeoutFn(() => controller.abort(), ASK_MODEL_TIMEOUT_MS);
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(new Error("session observer ask timed out or was cancelled")),
        { once: true },
      );
    });
    try {
      const execute = async () => {
        const prepared = await params.prepareModel({
          cfg,
          agentId: snapshot.agentId,
          modelRef: utilityModelRef,
          useUtilityModel: true,
          allowMissingApiKeyModes: ["aws-sdk"],
        });
        if (controller.signal.aborted || params.isDisposed()) {
          throw new Error("session observer ask is no longer active");
        }
        const currentCfg = params.getConfig();
        if (
          currentCfg.gateway?.controlUi?.sessionObserver === false ||
          params.resolveUtilityModelRef({ cfg: currentCfg, agentId: snapshot.agentId }) !==
            utilityModelRef
        ) {
          throw new Error("session observer utility model changed while answering");
        }
        if ("error" in prepared) {
          throw new Error(prepared.error);
        }
        const result = await params.completeModel({
          model: prepared.model,
          auth: prepared.auth,
          cfg: currentCfg,
          context: {
            systemPrompt: ASK_SYSTEM_PROMPT,
            messages: [
              {
                role: "user",
                content: buildAskPrompt({
                  digest: snapshot.digest,
                  notes: snapshot.notes,
                  question,
                }),
                timestamp: params.now(),
              },
            ],
          },
          options: {
            maxTokens: Math.min(ASK_MODEL_MAX_TOKENS, Math.floor(prepared.model.maxTokens)),
            temperature: 0.2,
            signal: controller.signal,
          },
        });
        if (result.stopReason === "error") {
          throw new Error(result.errorMessage?.trim() || "session observer ask completion failed");
        }
        const finalCfg = params.getConfig();
        const currentSnapshot = getSnapshot(sessionKey);
        if (
          controller.signal.aborted ||
          params.isDisposed() ||
          !params.subscribers.get(sessionKey).has(request.connId) ||
          finalCfg.gateway?.controlUi?.sessionObserver === false ||
          params.resolveUtilityModelRef({ cfg: finalCfg, agentId: snapshot.agentId }) !==
            utilityModelRef ||
          currentSnapshot.runId !== snapshot.runId ||
          currentSnapshot.digest?.revision !== snapshot.digest?.revision
        ) {
          throw new Error("session observer ask is no longer authorized");
        }
        const rawAnswer = result.content
          .filter((block): block is { type: "text"; text: string } => block.type === "text")
          .map((block) => block.text)
          .join("");
        const answer = sanitizeSessionObserverModelText(rawAnswer, ASK_ANSWER_MAX_CHARS);
        if (!answer) {
          throw new Error("session observer returned an empty answer");
        }
        return {
          answer,
          ...(snapshot.digest ? { digestRevision: snapshot.digest.revision } : {}),
        };
      };
      return await Promise.race([execute(), aborted]);
    } catch (error) {
      observerLog.warn("session observer ask failed", { sessionKey, error });
      throw new SessionObserverAskError(
        "model-unavailable",
        "The session observer could not answer right now.",
      );
    } finally {
      params.clearTimeoutFn(timeout);
      if (askControllers.get(sessionKey) === controller) {
        // Clear only the owning call's slot; a stale completion must never
        // release a newer ask admitted after cancellation.
        askControllers.delete(sessionKey);
      }
    }
  };

  return {
    ask,
    getSnapshot,
    dispose() {
      for (const controller of askControllers.values()) {
        controller.abort();
      }
      askControllers.clear();
      askAdmissions.length = 0;
    },
  };
}
