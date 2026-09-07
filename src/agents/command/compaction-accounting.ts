import { hasSameCompactionWriter } from "../../auto-reply/reply/agent-runner-compaction-accounting.js";
import { incrementCompactionCount } from "../../auto-reply/reply/session-updates.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { CompactionAccountingFact } from "../embedded-agent-runner/run/internal-params.js";
import type { CompactionRequestBudget } from "../sessions/compaction/request-budget.js";

type DurableCompactionFact = Extract<CompactionAccountingFact, { kind: "durable" }>;

/** Keeps command context observations and completed counts on their original writer. */
export function createCommandCompactionAccounting(params: {
  sessionStore?: Record<string, SessionEntry>;
  persistCounts: boolean;
  onDurableFact: (fact: DurableCompactionFact) => void;
  refreshSessionEntry: (sessionKey: string) => void;
}) {
  let accounting: DurableCompactionFact | undefined;
  let requestBudget: CompactionRequestBudget | undefined;
  return {
    get fact() {
      return accounting;
    },
    get requestBudget() {
      return requestBudget;
    },
    beginCandidate(signal?: AbortSignal) {
      let acceptsRequestBudget = true;
      requestBudget = undefined;
      if (accounting?.currentContextSnapshot) {
        // Only an ordered fact from this candidate can restore current context.
        accounting = { ...accounting, currentContextSnapshot: { tokens: undefined } };
      }
      let candidateFact: CompactionAccountingFact | undefined;
      return {
        observeRequestBudget: (budget: CompactionRequestBudget | undefined) => {
          if (acceptsRequestBudget && !signal?.aborted) {
            requestBudget = budget;
          }
        },
        observe: (fact: CompactionAccountingFact | undefined) => {
          if (
            fact?.kind === "durable" &&
            fact.count === 0 &&
            accounting &&
            !hasSameCompactionWriter(accounting.target, fact.target)
          ) {
            return;
          }
          candidateFact = fact;
          if (fact?.kind === "durable") {
            // The first writer fact binds finalization; later unrelated zeros cannot rebind it.
            params.onDurableFact(fact);
          }
        },
        async finish(sessionEntry: SessionEntry | undefined) {
          // Close the foreground observer before count persistence can yield to late callbacks.
          acceptsRequestBudget = false;
          const fact = candidateFact;
          if (fact?.kind !== "durable") {
            return;
          }
          const carriedCount = hasSameCompactionWriter(accounting?.target, fact.target)
            ? (accounting?.count ?? 0)
            : 0;
          accounting = {
            ...fact,
            count: carriedCount + fact.count,
            currentContextSnapshot:
              fact.currentContextSnapshot ?? accounting?.currentContextSnapshot,
          };
          if (fact.count > 0 && params.persistCounts) {
            await incrementCompactionCount({
              agentId: fact.target.agentId,
              sessionEntry,
              sessionStore: params.sessionStore,
              sessionKey: fact.target.sessionKey,
              storePath: fact.target.storePath,
              expectedSession: fact.target,
              amount: fact.count,
              tokensAfter: fact.currentContextSnapshot?.tokens,
            });
            params.refreshSessionEntry(fact.target.sessionKey);
          }
        },
      };
    },
  };
}
