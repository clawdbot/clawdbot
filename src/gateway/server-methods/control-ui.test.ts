import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { ControlUiGitHubPreview } from "../control-ui-contract.js";
import { ControlUiGitHubError } from "../control-ui-github-api.js";
import { createControlUiHandlers } from "./control-ui.js";
import type { RespondFn } from "./types.js";

function requestOptions(
  params: Record<string, unknown>,
  respond: RespondFn,
  overrides: { client?: { connId: string }; context?: unknown } = {},
) {
  return {
    client: (overrides.client ?? null) as never,
    context: (overrides.context ?? {}) as never,
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

    await expectDefined(
      handlers["controlUi.githubPreview"],
      'handlers["controlUi.githubPreview"] test invariant',
    )(
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

    await expectDefined(
      handlers["controlUi.githubPreview"],
      'handlers["controlUi.githubPreview"] test invariant',
    )(
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

    await expectDefined(
      handlers["controlUi.githubPreview"],
      'handlers["controlUi.githubPreview"] test invariant',
    )(
      requestOptions({ kind: "pull", number: 99816, owner: "openclaw", repo: "openclaw" }, respond),
    );

    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "UNAVAILABLE",
      message: "GitHub preview unavailable",
      retryable: true,
    });
  });
});

describe("controlUi.sessionPullRequests.subscribe", () => {
  it("replaces the connection watch set", async () => {
    const replace = vi.fn().mockResolvedValue(undefined);
    const handlers = createControlUiHandlers(vi.fn());
    const respond = vi.fn<RespondFn>();

    await expectDefined(
      handlers["controlUi.sessionPullRequests.subscribe"],
      'handlers["controlUi.sessionPullRequests.subscribe"] test invariant',
    )(
      requestOptions(
        { sessionKeys: [" agent:main:main ", "agent:main:main", "agent:work:main"] },
        respond,
        {
          client: { connId: "conn-control-ui" },
          context: { controlUiSessionPullRequests: { replace } },
        },
      ),
    );

    expect(replace).toHaveBeenCalledWith("conn-control-ui", ["agent:main:main", "agent:work:main"]);
    expect(respond).toHaveBeenCalledWith(true, { subscribed: true }, undefined);
  });

  it("accepts an empty replace-set as unsubscribe", async () => {
    const replace = vi.fn().mockResolvedValue(undefined);
    const handlers = createControlUiHandlers(vi.fn());
    const respond = vi.fn<RespondFn>();

    await expectDefined(
      handlers["controlUi.sessionPullRequests.subscribe"],
      'handlers["controlUi.sessionPullRequests.subscribe"] test invariant',
    )(
      requestOptions({ sessionKeys: [] }, respond, {
        client: { connId: "conn-control-ui" },
        context: { controlUiSessionPullRequests: { replace } },
      }),
    );

    expect(replace).toHaveBeenCalledWith("conn-control-ui", []);
    expect(respond).toHaveBeenCalledWith(true, { subscribed: false }, undefined);
  });

  it("rejects malformed replace-sets", async () => {
    const replace = vi.fn();
    const handlers = createControlUiHandlers(vi.fn());
    const respond = vi.fn<RespondFn>();

    await expectDefined(
      handlers["controlUi.sessionPullRequests.subscribe"],
      'handlers["controlUi.sessionPullRequests.subscribe"] test invariant',
    )(
      requestOptions({ sessionKeys: [" "] }, respond, {
        client: { connId: "conn-control-ui" },
        context: { controlUiSessionPullRequests: { replace } },
      }),
    );

    expect(replace).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "INVALID_REQUEST",
      message: "invalid controlUi.sessionPullRequests.subscribe params",
    });
  });
});
