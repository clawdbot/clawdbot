import type {
  AgentHarnessHostCapabilities,
  AgentMessage,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { TranscriptEntryAnchor } from "openclaw/plugin-sdk/session-transcript-runtime";

const PROVIDER_TRANSCRIPT_COMMIT = Symbol.for("openclaw.agentHarness.providerTranscriptCommit.v1");

type ProviderTranscriptCommitResult =
  | {
      kind: "committed" | "replayed";
      results: readonly {
        anchor: TranscriptEntryAnchor;
        identity: string;
        message: AgentMessage;
      }[];
    }
  | {
      kind: "conflict" | "rejected" | "suppressed";
      reason?: string;
    };

type ProviderTranscriptCommit = (params: {
  assertCurrent: () => void;
  baseAnchor?: TranscriptEntryAnchor;
  entries: readonly {
    eventId: string;
    identity: string;
    message: AgentMessage;
    sourceFingerprint?: string;
  }[];
  validatePreparedPrefix?: (messages: readonly AgentMessage[]) => boolean;
}) => Promise<ProviderTranscriptCommitResult>;

export function commitProviderSessionTranscriptPrefix(
  hostCapabilities: AgentHarnessHostCapabilities,
  params: Parameters<ProviderTranscriptCommit>[0],
) {
  const commit = Reflect.get(hostCapabilities, PROVIDER_TRANSCRIPT_COMMIT) as
    | ProviderTranscriptCommit
    | undefined;
  return commit
    ? commit(params)
    : Promise.reject(new Error("provider transcript commit requires host transcript capability"));
}
