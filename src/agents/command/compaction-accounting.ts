import { incrementCompactionCount } from "../../auto-reply/reply/session-updates.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type {
  CompactionAccountingFact,
  CompactionAccountingTarget,
} from "../embedded-agent-runner/run/internal-params.js";

type DurableCompactionFact = Extract<CompactionAccountingFact, { kind: "durable" }>;

function hasSameCompactionWriter(
  previous: CompactionAccountingTarget | undefined,
  current: CompactionAccountingTarget,
): boolean {
  // Physical session IDs may rotate while the binding and retained writer stay fixed.
  return (
    previous !== undefined &&
    previous.agentId === current.agentId &&
    previous.sessionKey === current.sessionKey &&
    previous.storePath === current.storePath &&
    previous.lifecycleRevision === current.lifecycleRevision &&
    previous.activeWriterRunId === current.activeWriterRunId
  );
}

/** Keeps command context observations and completed counts on their original writer. */
export function createCommandCompactionAccounting(params: {
  sessionStore?: Record<string, SessionEntry>;
  persistCounts: boolean;
  onDurableFact: (fact: DurableCompactionFact) => void;
  refreshSessionEntry: (sessionKey: string) => void;
}) {
  let accounting: DurableCompactionFact | undefined;
  return {
    get fact() {
      return accounting;
    },
    beginCandidate() {
      if (accounting?.currentContextSnapshot) {
        // Only an ordered fact from this candidate can restore current context.
        accounting = { ...accounting, currentContextSnapshot: { tokens: undefined } };
      }
      let candidateFact: CompactionAccountingFact | undefined;
      return {
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
