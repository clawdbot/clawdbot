import { describe, expect, it, vi } from "vitest";
import type {
  ControlUiGitHubPreview,
  ControlUiSessionPullRequests,
} from "../control-ui-contract.js";
import { ControlUiGitHubError } from "../control-ui-github-api.js";
import { createControlUiHandlers } from "./control-ui.js";
import type { RespondFn } from "./types.js";

function requestOptions(params: Record<string, unknown>, respond: RespondFn) {
  return {
    client: null,
    context: {} as never,
    isWebchatConnect: () => false,
    params,
    req: { id: "1", method: "controlUi.githubPreview", params, type: "req" as const },
    respond,
  };
}

describe("controlUi.githubPreview", () => {
  it("returns bounded public GitHub metadata", async () => {
    const preview: ControlUiGitHubPreview = {
      comments: 4,
      createdAt: "2026-07-05T08:00:00Z",
      kind: "issue",
      login: "octocat",
      number: 99815,
      owner: "openclaw",
      repo: "openclaw",
      state: "open",
      title: "Keep hover previews compact",
      updatedAt: "2026-07-05T09:55:00Z",
    };
    const loadPreview = vi.fn().mockResolvedValue(preview);
    const handlers = createControlUiHandlers(loadPreview);
    const respond = vi.fn<RespondFn>();

    await handlers["controlUi.githubPreview"](
      requestOptions(
        { kind: "issue", number: 99815, owner: "openclaw", repo: "openclaw" },
        respond,
      ),
    );

    expect(loadPreview).toHaveBeenCalledWith({
      kind: "issue",
      number: 99815,
      owner: "openclaw",
      repo: "openclaw",
    });
    expect(respond).toHaveBeenCalledWith(true, preview, undefined);
  });

  it("rejects malformed targets before loading GitHub", async () => {
    const loadPreview = vi.fn();
    const handlers = createControlUiHandlers(loadPreview);
    const respond = vi.fn<RespondFn>();

    await handlers["controlUi.githubPreview"](
      requestOptions(
        { kind: "issue", number: 1, owner: "openclaw/evil", repo: "openclaw" },
        respond,
      ),
    );

    expect(loadPreview).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "INVALID_REQUEST",
      message: "invalid controlUi.githubPreview params",
    });
  });

  it("returns a retryable unavailable error for GitHub quota failures", async () => {
    const handlers = createControlUiHandlers(
      vi.fn().mockRejectedValue(new ControlUiGitHubError(429, "rate limited")),
    );
    const respond = vi.fn<RespondFn>();

    await handlers["controlUi.githubPreview"](
      requestOptions({ kind: "pull", number: 99816, owner: "openclaw", repo: "openclaw" }, respond),
    );

    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "UNAVAILABLE",
      message: "GitHub preview unavailable",
      retryable: true,
    });
  });
});

describe("controlUi.sessionPullRequests", () => {
  it("returns detected pull requests for the session", async () => {
    const result: ControlUiSessionPullRequests = {
      pullRequests: [
        {
          number: 103469,
          owner: "openclaw",
          repo: "openclaw",
          branch: "claude/browser-tabs-tighter-header",
          title: "fix(macos): tighten the link-browser tab header",
          url: "https://github.com/openclaw/openclaw/pull/103469",
          state: "open",
          additions: 4,
          deletions: 3,
          checks: { state: "passing", passed: 5, failed: 0, skipped: 1, running: 0 },
          checksUrl: "https://github.com/openclaw/openclaw/pull/103469/checks",
        },
      ],
      rateLimited: false,
    };
    const loadPullRequests = vi.fn().mockResolvedValue(result);
    const handlers = createControlUiHandlers(vi.fn(), loadPullRequests);
    const respond = vi.fn<RespondFn>();

    await handlers["controlUi.sessionPullRequests"](
      requestOptions({ sessionKey: "agent:main:main", agentId: "main" }, respond),
    );

    expect(loadPullRequests).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      agentId: "main",
    });
    expect(respond).toHaveBeenCalledWith(true, result, undefined);
  });

  it("rejects params without a session key", async () => {
    const loadPullRequests = vi.fn();
    const handlers = createControlUiHandlers(vi.fn(), loadPullRequests);
    const respond = vi.fn<RespondFn>();

    await handlers["controlUi.sessionPullRequests"](requestOptions({ sessionKey: "  " }, respond));

    expect(loadPullRequests).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "INVALID_REQUEST",
      message: "invalid controlUi.sessionPullRequests params",
    });
  });

  it("returns a retryable unavailable error for GitHub quota failures", async () => {
    const handlers = createControlUiHandlers(
      vi.fn(),
      vi.fn().mockRejectedValue(new ControlUiGitHubError(429, "rate limited")),
    );
    const respond = vi.fn<RespondFn>();

    await handlers["controlUi.sessionPullRequests"](
      requestOptions({ sessionKey: "agent:main:main" }, respond),
    );

    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "UNAVAILABLE",
      message: "session pull requests unavailable",
      retryable: true,
    });
  });
});
