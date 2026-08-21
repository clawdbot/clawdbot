import type { GatewayBrowserClient } from "../api/gateway.ts";
import { parseGitHubLinkTarget } from "./github-link-target.ts";

const GITHUB_PREVIEW_METHOD = "controlUi.githubPreview";
const GITHUB_PREVIEW_PREWARM_LIMIT = 3;

export async function prewarm(
  root: ParentNode,
  client: GatewayBrowserClient,
  signal: AbortSignal,
  isCurrent: () => boolean,
): Promise<void> {
  if (signal.aborted || !isCurrent()) {
    return;
  }
  const anchors = root.querySelectorAll<HTMLAnchorElement>(
    ".chat-thread a.markdown-github-link[href]",
  );
  const seen = new Set<string>();
  const targets = [];
  for (let index = anchors.length - 1; index >= 0; index -= 1) {
    const target = parseGitHubLinkTarget(anchors[index]?.href ?? "");
    if (!target) {
      continue;
    }
    const key = `${target.kind}:${target.owner.toLowerCase()}/${target.repo.toLowerCase()}#${target.number}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    targets.push(target);
    if (targets.length === GITHUB_PREVIEW_PREWARM_LIMIT) {
      break;
    }
  }
  // Responses are discarded intentionally: these calls fill the Gateway-process
  // LRU without loading the browser hovercard runtime during session startup.
  for (const target of targets) {
    if (signal.aborted || !isCurrent()) {
      return;
    }
    await client
      .request(
        GITHUB_PREVIEW_METHOD,
        {
          kind: target.kind,
          number: target.number,
          owner: target.owner,
          repo: target.repo,
        },
        { signal },
      )
      .catch(() => undefined);
  }
}
