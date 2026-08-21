import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { getRuntimeConfig } from "../config/config.js";
import { withTranscriptWriteTransaction } from "../config/sessions/session-accessor.js";
import type { GitHubPublicationCoordinator } from "./github-publication.js";

const GITHUB_PUBLICATION_RESPONSE_PREFIX = "github-publication:";

function formatGitHubPublicationResult(result: SessionGitHubPublicationResult): string {
  switch (result.status) {
    case "published":
      return `Published ${result.repository} branch ${result.branch}: ${result.url}`;
    case "failed":
      return `GitHub publication failed: ${result.message} ${result.nextAction}`;
    case "publishing":
    case "requested":
      return result.message;
  }
  return result satisfies never;
}

export function createGitHubPublicationTranscriptReporter(
  loadSessionRuntime: () => Promise<{
    resolveCanonicalSessionEntryFromStoreKeys: typeof import("./session-utils.js").resolveCanonicalSessionEntryFromStoreKeys;
    resolveGatewaySessionStoreTargetWithStore: typeof import("./session-utils.js").resolveGatewaySessionStoreTargetWithStore;
  }>,
  coordinator: Pick<GitHubPublicationCoordinator, "markReported">,
) {
  return async (params: {
    sessionId: string;
    sessionKey: string;
    agentId: string;
    result: SessionGitHubPublicationResult;
  }): Promise<void> => {
    const runtime = await loadSessionRuntime();
    const target = runtime.resolveGatewaySessionStoreTargetWithStore({
      cfg: getRuntimeConfig(),
      key: params.sessionKey,
      agentId: params.agentId,
      clone: false,
    });
    const entry = runtime.resolveCanonicalSessionEntryFromStoreKeys(target.store, target.storeKeys);
    if (entry?.sessionId !== params.sessionId || target.canonicalKey !== params.sessionKey) {
      throw new Error("GitHub publication transcript owner changed");
    }
    await withTranscriptWriteTransaction(
      {
        agentId: target.agentId,
        sessionId: params.sessionId,
        sessionKey: target.canonicalKey,
        storePath: target.storePath,
      },
      (transcriptTarget) => {
        const manager = SessionManager.open(transcriptTarget);
        const exists = manager.getBranch().some((transcriptEntry) => {
          return (
            transcriptEntry.type === "message" &&
            transcriptEntry.message.role === "assistant" &&
            transcriptEntry.message.responseId ===
              `${GITHUB_PUBLICATION_RESPONSE_PREFIX}${params.result.requestId}`
          );
        });
        if (!exists) {
          manager.appendMessage({
            role: "assistant",
            content: [{ type: "text", text: formatGitHubPublicationResult(params.result) }],
            api: "openai-responses",
            provider: "openclaw",
            model: "gateway-publication",
            responseId: `${GITHUB_PUBLICATION_RESPONSE_PREFIX}${params.result.requestId}`,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: Date.now(),
          });
        }
      },
    );
    coordinator.markReported(params.result.requestId);
  };
}
