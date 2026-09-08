import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { getRuntimeConfig } from "../config/config.js";
import { appendSessionTranscriptReport } from "../config/sessions/session-accessor.js";
import type { GitHubPublicationCoordinator } from "./github-publication.js";

const GITHUB_PUBLICATION_RESPONSE_PREFIX = "github-publication:";

function formatGitHubPublicationResult(result: SessionGitHubPublicationResult): string {
  const publisher = result.publisher;
  const source =
    publisher?.source === "personal"
      ? "My GitHub"
      : publisher?.source === "agent-override"
        ? "Agent override"
        : "System";
  const acting = publisher ? ` Using @${publisher.login} (${source}).` : "";
  switch (result.status) {
    case "published":
      return `Published ${result.repository} branch ${result.branch}: ${result.url}${acting}`;
    case "failed":
      return `GitHub publication failed: ${result.message} ${result.nextAction}${acting}`;
    case "publishing":
    case "requested":
    case "needs_confirmation":
      return `${result.message}${acting}`;
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
    const appended = await appendSessionTranscriptReport(
      {
        agentId: target.agentId,
        sessionId: params.sessionId,
        sessionKey: target.canonicalKey,
        storePath: target.storePath,
      },
      {
        kind: "assistant",
        message: {
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
        },
      },
    );
    if (!appended.ok) {
      throw new Error("GitHub publication transcript owner changed", { cause: appended.error });
    }
    coordinator.markReported(params.result.requestId);
  };
}
