import type { PluginHookChannelParticipationCandidate } from "../plugins/hook-types.js";

export type ChannelParticipationCandidate = PluginHookChannelParticipationCandidate & {
  /** The existing replay owner already adopted or terminally handled this event. Not reply proof. */
  alreadyHandled?: boolean;
};

type Receiver<TSource> = {
  accountId: string;
  /** Return an eligible receiver, or bypass the whole decision for targeting/uncertainty. */
  prepare: (source: TSource) => Promise<ChannelParticipationCandidate | "bypass" | undefined>;
  abortSignal?: AbortSignal;
};

const MAX_CANDIDATES = 8;
const MAX_MESSAGE_CHARS = 2_000;
const MAX_DECISIONS = 256;
const DECISION_RETENTION_MS = 5 * 60_000;
const DECISION_TIMEOUT_MS = 8_000;

async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(resolve, Math.max(1, timeoutMs), undefined);
        timer.unref?.();
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Coordinates live receivers of the same native event before any agent runs.
 * Selection can only suppress ordinarily admitted receivers; it never grants access.
 */
export function createChannelParticipationCoordinator<TSource>(options: { channel: string }) {
  const receivers = new Map<string, Receiver<TSource>>();
  let generation = 0;
  type Decision = {
    generation: number;
    message: string;
    conversationId: string;
    expiresAt: number;
    invalidated: boolean;
    policiesCurrent: () => boolean;
    result: Promise<
      { candidates: ChannelParticipationCandidate[]; accountIds: string[] } | undefined
    >;
  };
  const decisions = new Map<string, Decision>();

  async function prepareRoster(
    source: TSource,
    snapshot: Receiver<TSource>[],
    originallyEligible?: Set<string>,
  ) {
    const prepared = await Promise.all(
      snapshot.map(async (receiver) => ({ receiver, candidate: await receiver.prepare(source) })),
    );
    const candidates: ChannelParticipationCandidate[] = [];
    for (const { receiver, candidate } of prepared) {
      if (!candidate) {
        continue;
      }
      if (candidate === "bypass") {
        return undefined;
      }
      // A late sibling may observe the selected turn's ordinary adoption. Preserve that
      // choice, but never nominate an event already consumed before classification began.
      if (candidate.alreadyHandled && !originallyEligible?.has(candidate.accountId)) {
        continue;
      }
      // A receiver cannot nominate a different account or exceed the prompt's identity budget.
      if (
        candidate.accountId !== receiver.accountId ||
        [candidate.accountId, candidate.agentId, candidate.participantId].some(
          (value) => !value || value.length > 128,
        ) ||
        (candidate.name?.length ?? 0) > 80
      ) {
        return undefined;
      }
      candidates.push({
        accountId: candidate.accountId,
        agentId: candidate.agentId,
        participantId: candidate.participantId,
        ...(candidate.name ? { name: candidate.name } : {}),
      });
    }
    return candidates.length >= 2 && candidates.length <= MAX_CANDIDATES ? candidates : undefined;
  }

  return {
    register(receiver: Receiver<TSource>): { dispose: () => void } {
      const registration = { ...receiver };
      let disposed = false;
      const dispose = () => {
        if (disposed) {
          return;
        }
        disposed = true;
        registration.abortSignal?.removeEventListener("abort", dispose);
        if (receivers.get(registration.accountId) === registration) {
          receivers.delete(registration.accountId);
          generation++;
          if (receivers.size === 0) {
            decisions.clear();
          }
        }
      };
      if (!receiver.abortSignal?.aborted) {
        receivers.set(receiver.accountId, registration);
        generation++;
        receiver.abortSignal?.addEventListener("abort", dispose, { once: true });
      }
      return { dispose };
    },

    async decide(params: {
      accountId: string;
      /** Exact native event identity, including realm, conversation, and thread scope. */
      eventKey: string;
      conversationId: string;
      source: TSource;
      message: string;
    }): Promise<"keep" | "suppress"> {
      if (
        !params.eventKey ||
        !params.message.trim() ||
        params.message.length > MAX_MESSAGE_CHARS ||
        !receivers.has(params.accountId) ||
        receivers.size < 2
      ) {
        return "keep";
      }
      // Keep the public SDK barrel light and the disabled path free of receiver/network work.
      const [{ getGlobalHookRunner }, { getGlobalHookRunnerRegistry }] = await Promise.all([
        import("../plugins/hook-runner-global.js"),
        import("../plugins/hook-runner-global-state.js"),
      ]);
      const runner = getGlobalHookRunner();
      if (!runner?.hasHooks("before_channel_participation")) {
        return "keep";
      }
      const policySnapshot = () =>
        getGlobalHookRunnerRegistry()?.typedHooks.filter(
          (hook) => hook.hookName === "before_channel_participation",
        ) ?? [];
      const policies = policySnapshot();
      const policiesCurrent = () => {
        const current = policySnapshot();
        return (
          current.length === policies.length && current.every((hook, i) => hook === policies[i])
        );
      };
      const snapshot = [...receivers.values()].sort((a, b) =>
        a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0,
      );
      const now = Date.now();
      const deadline = now + DECISION_TIMEOUT_MS;
      for (const [key, decision] of decisions) {
        if (decision.expiresAt <= now) {
          decisions.delete(key);
        }
      }
      let decision = decisions.get(params.eventKey);
      if (decision) {
        // Conflicting replays must not reuse a decision made over different message bytes.
        decision.invalidated ||=
          decision.message !== params.message || decision.conversationId !== params.conversationId;
      } else {
        // Do not evict in-flight choices and make sibling receivers classify the event again.
        if (decisions.size >= MAX_DECISIONS) {
          return "keep";
        }
        const admittedGeneration = generation;
        decision = {
          generation: admittedGeneration,
          message: params.message,
          conversationId: params.conversationId,
          expiresAt: now + DECISION_RETENTION_MS,
          invalidated: false,
          policiesCurrent,
          result: Promise.resolve(undefined),
        };
        const ownedDecision = decision;
        decisions.set(params.eventKey, decision);
        const resolve = async () => {
          const candidates = await prepareRoster(params.source, snapshot);
          if (
            !candidates ||
            !candidates.some((candidate) => candidate.accountId === params.accountId) ||
            generation !== admittedGeneration ||
            ownedDecision.invalidated ||
            !policiesCurrent()
          ) {
            return undefined;
          }
          const result = await runner.runBeforeChannelParticipation(
            { message: params.message, candidates },
            { channelId: options.channel, conversationId: params.conversationId },
            {
              isCurrent: () =>
                !ownedDecision.invalidated &&
                Date.now() < deadline &&
                generation === admittedGeneration &&
                policiesCurrent(),
            },
          );
          return result && { candidates, accountIds: result.accountIds };
        };
        decision.result = bounded(resolve(), DECISION_TIMEOUT_MS).then((result) => {
          ownedDecision.invalidated ||= !result;
          return result;
        });
      }
      const result = await decision.result;
      if (
        !result ||
        decision.invalidated ||
        decision.generation !== generation ||
        !decision.policiesCurrent() ||
        !result.candidates.some((candidate) => candidate.accountId === params.accountId) ||
        result.accountIds.includes(params.accountId)
      ) {
        return "keep";
      }
      // Membership and ACLs can change while inference awaits. Re-read their owners before
      // suppressing; a monitor lease alone is not current authorization evidence.
      const current = await bounded(
        prepareRoster(
          params.source,
          snapshot,
          new Set(result.candidates.map((candidate) => candidate.accountId)),
        ),
        deadline - Date.now(),
      );
      return current &&
        decision.generation === generation &&
        !decision.invalidated &&
        decision.policiesCurrent() &&
        JSON.stringify(current) === JSON.stringify(result.candidates)
        ? "suppress"
        : "keep";
    },
  };
}
