import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as githubIdentity from "../../agents/github-tool-identity.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.js";
import { SecretSurfaceUnavailableError } from "../../secrets/runtime-degraded-state.js";
import type { ControlUiGitHubPreview, ControlUiSessionPreview } from "../control-ui-contract.js";
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
    context: (overrides.context ?? {
      getRuntimeConfig: () => ({
        agents: { entries: { main: {} } },
        gateway: { controlUi: { github: { token: "preview-service-token" } } },
      }),
    }) as never,
    isWebchatConnect: () => false,
    params,
    req: { id: "1", method: "controlUi.githubPreview", params, type: "req" as const },
    respond,
  };
}

describe("controlUi.githubPreview", () => {
  afterEach(() => {
    clearRuntimeConfigSnapshot();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("uses the selected agent's Settings identity for public metadata", async () => {
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    const identity = {
      token: "selected-agent-github-token",
      cacheScope: "selected-agent-preview",
      assertSelected: vi.fn(),
      revalidate: vi.fn().mockResolvedValue(undefined),
    };
    const prepare = vi
      .spyOn(githubIdentity, "prepareGitHubReadIdentity")
      .mockResolvedValue(identity);
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const authorized =
        new Headers(init?.headers).get("Authorization") === `Bearer ${identity.token}`;
      const url = input instanceof Request ? input.url : input.toString();
      return new Response(
        JSON.stringify(
          !authorized
            ? { message: "Bad credentials" }
            : url.endsWith("/issues/88120")
              ? {
                  created_at: "2026-09-01T08:00:00Z",
                  updated_at: "2026-09-01T09:00:00Z",
                  repository_url: "https://api.github.com/repos/openclaw/openclaw",
                  state: "open",
                  title: "Use the selected GitHub identity",
                  user: { login: "octocat" },
                }
              : { private: false },
        ),
        { status: authorized ? 200 : 401 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const respond = vi.fn<RespondFn>();
    const cfg = {
      agents: {
        entries: {
          main: {},
          alternate: { tools: { github: { profileId: `ghp_${"a".repeat(32)}` } } },
        },
      },
      gateway: { controlUi: { github: { token: "old-preview-service-token" } } },
    };
    setRuntimeConfigSnapshot(cfg);
    const handler = expectDefined(
      createControlUiHandlers()["controlUi.githubPreview"],
      "preview handler",
    );

    await handler(
      requestOptions(
        { kind: "issue", number: 88120, owner: "openclaw", repo: "openclaw", agentId: "alternate" },
        respond,
        { context: { getRuntimeConfig: () => cfg } },
      ),
    );

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ title: "Use the selected GitHub identity" }),
      undefined,
    );
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "alternate", config: cfg }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(identity.revalidate).toHaveBeenCalled();
  });

  it("keeps anonymous public previews without consulting unconfigured native identities", async () => {
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    const prepare = vi
      .spyOn(githubIdentity, "prepareGitHubReadIdentity")
      .mockRejectedValue(new githubIdentity.GitHubIdentityError("rate_limited"));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          created_at: "2026-09-01T08:00:00Z",
          updated_at: "2026-09-01T09:00:00Z",
          state: "open",
          title: "Public metadata without a login",
          user: { login: "octocat" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const respond = vi.fn<RespondFn>();
    const cfg = { agents: { entries: { main: {} } } };
    const handler = expectDefined(
      createControlUiHandlers()["controlUi.githubPreview"],
      "preview handler",
    );

    await handler(
      requestOptions(
        { kind: "issue", number: 88121, owner: "openclaw", repo: "openclaw", agentId: "main" },
        respond,
        { context: { getRuntimeConfig: () => cfg } },
      ),
    );

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ title: "Public metadata without a login" }),
      undefined,
    );
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has("Authorization")).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("keeps an unavailable managed identity visible instead of using the service token", async () => {
    vi.spyOn(githubIdentity, "prepareGitHubReadIdentity").mockRejectedValue(
      new githubIdentity.GitHubIdentityError("unavailable"),
    );
    const cfg = {
      agents: { entries: { main: {} } },
      tools: { github: { profileId: `ghp_${"b".repeat(32)}` } },
      gateway: { controlUi: { github: { token: "existing-preview-service-token" } } },
    };
    const loadPreview = vi.fn();
    const respond = vi.fn<RespondFn>();
    const handler = expectDefined(
      createControlUiHandlers(loadPreview)["controlUi.githubPreview"],
      "preview handler",
    );

    await handler(
      requestOptions(
        { kind: "issue", number: 88125, owner: "openclaw", repo: "openclaw", agentId: "main" },
        respond,
        { context: { getRuntimeConfig: () => cfg } },
      ),
    );

    expect(loadPreview).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "UNAVAILABLE",
      message:
        "The selected GitHub credential is unavailable; reconnect the agent's GitHub identity in Settings.",
      retryable: false,
    });
  });

  it.each(["unchanged", "agent", "system"])(
    "delivers public metadata only while its fallback identity remains selected: %s",
    async (selection) => {
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
      let cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
      const started = createDeferred();
      const pending = createDeferred<ControlUiGitHubPreview>();
      const loadPreview = vi.fn(() => {
        started.resolve();
        return pending.promise;
      });
      const handlers = createControlUiHandlers(loadPreview);
      const respond = vi.fn<RespondFn>();

      const request = expectDefined(
        handlers["controlUi.githubPreview"],
        'handlers["controlUi.githubPreview"] test invariant',
      )(
        requestOptions(
          { kind: "issue", number: 99815, owner: "openclaw", repo: "openclaw" },
          respond,
          { context: { getRuntimeConfig: () => cfg } },
        ),
      );
      await started.promise;
      const tools = { github: { profileId: `ghp_${"c".repeat(32)}` } };
      if (selection === "agent") {
        cfg = { agents: { entries: { main: { tools } } } };
      } else if (selection === "system") {
        cfg = { ...cfg, tools };
      }
      pending.resolve(preview);
      await request;

      expect(loadPreview).toHaveBeenCalledWith(
        { kind: "issue", number: 99815, owner: "openclaw", repo: "openclaw" },
        undefined,
      );
      if (selection === "unchanged") {
        expect(respond).toHaveBeenCalledWith(true, preview, undefined);
      } else {
        expect(respond).toHaveBeenCalledWith(false, undefined, {
          code: "UNAVAILABLE",
          message: new githubIdentity.GitHubIdentityError("changed").message,
          retryable: true,
        });
      }
    },
  );

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

  it.each([
    {
      failure: "GitHub quota",
      error: new ControlUiGitHubError(429, "rate limited"),
      message: "GitHub API rate limit exceeded (HTTP 429). Wait and retry.",
      retryable: true,
    },
    {
      failure: "configured-unavailable preview credential",
      error: new SecretSurfaceUnavailableError({
        ownerKind: "capability",
        ownerId: "control-ui-github",
        state: "unavailable",
        paths: ["gateway.controlUi.github.token"],
        refKeys: [],
        reason: "secret reference was not found",
      }),
      message:
        "The configured Control UI GitHub credential is unavailable. Resolve gateway.controlUi.github.token and retry.",
      retryable: false,
    },
  ])(
    "preserves the $failure diagnostic in the RPC response",
    async ({ error, message, retryable }) => {
      const handlers = createControlUiHandlers(vi.fn().mockRejectedValue(error));
      const respond = vi.fn<RespondFn>();

      await expectDefined(
        handlers["controlUi.githubPreview"],
        'handlers["controlUi.githubPreview"] test invariant',
      )(
        requestOptions(
          { kind: "pull", number: 99816, owner: "openclaw", repo: "openclaw" },
          respond,
        ),
      );

      expect(respond).toHaveBeenCalledWith(false, undefined, {
        code: "UNAVAILABLE",
        message,
        retryable,
      });
    },
  );
});

describe("controlUi.sessionPreview", () => {
  it("returns bounded, redacted metadata for one session", async () => {
    const secret = "sk-test-session-preview-secret-1234567890";
    const loadSessionPreview = vi.fn().mockResolvedValue({
      sessionKey: "agent:main:research",
      title: `  ${"T".repeat(240)}  `,
      derivedTitle: "  Research notes  ",
      agentId: "main",
      kind: "direct",
      channel: "webchat",
      updatedAt: 1_786_000_000_000,
      lastMessagePreview: `  OPENAI_API_KEY=${secret} ${"x".repeat(240)}  `,
      archived: false,
    });
    const handlers = createControlUiHandlers(vi.fn(), loadSessionPreview);
    const respond = vi.fn<RespondFn>();

    await expectDefined(
      handlers["controlUi.sessionPreview"],
      'handlers["controlUi.sessionPreview"] test invariant',
    )(requestOptions({ sessionKey: " agent:main:research " }, respond));

    expect(loadSessionPreview).toHaveBeenCalledWith(
      "agent:main:research",
      expect.any(Object),
      null,
    );
    const payload = respond.mock.calls[0]?.[1] as ControlUiSessionPreview | undefined;
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(payload).toMatchObject({
      status: "ok",
      sessionKey: "agent:main:research",
      derivedTitle: "Research notes",
      agentId: "main",
      kind: "direct",
      channel: "webchat",
      updatedAt: 1_786_000_000_000,
      archived: false,
    });
    if (payload?.status !== "ok") {
      throw new Error("expected an available session preview");
    }
    expect(payload.title).toHaveLength(200);
    expect(payload.lastMessagePreview?.length).toBeLessThanOrEqual(200);
    expect(payload.lastMessagePreview).not.toContain(secret);
  });

  it("returns unavailable for an unknown session", async () => {
    const handlers = createControlUiHandlers(vi.fn(), vi.fn().mockResolvedValue(null));
    const respond = vi.fn<RespondFn>();

    await expectDefined(
      handlers["controlUi.sessionPreview"],
      'handlers["controlUi.sessionPreview"] test invariant',
    )(requestOptions({ sessionKey: "agent:main:missing" }, respond));

    expect(respond).toHaveBeenCalledWith(true, { status: "unavailable" }, undefined);
  });

  it("rejects malformed preview params", async () => {
    const loadSessionPreview = vi.fn();
    const handlers = createControlUiHandlers(vi.fn(), loadSessionPreview);
    const respond = vi.fn<RespondFn>();

    await expectDefined(
      handlers["controlUi.sessionPreview"],
      'handlers["controlUi.sessionPreview"] test invariant',
    )(requestOptions({ sessionKey: "agent:main:research", extra: true }, respond));

    expect(loadSessionPreview).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "INVALID_REQUEST",
      message: "invalid controlUi.sessionPreview params",
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

  it("acknowledges a subscription before its cold snapshots finish loading", async () => {
    let finishHydration!: () => void;
    const hydration = new Promise<void>((resolve) => {
      finishHydration = resolve;
    });
    const replace = vi.fn(() => hydration);
    const handlers = createControlUiHandlers(vi.fn());
    const respond = vi.fn<RespondFn>();

    const request = expectDefined(
      handlers["controlUi.sessionPullRequests.subscribe"],
      'handlers["controlUi.sessionPullRequests.subscribe"] test invariant',
    )(
      requestOptions({ sessionKeys: ["agent:main:cold"] }, respond, {
        client: { connId: "conn-control-ui" },
        context: { controlUiSessionPullRequests: { replace } },
      }),
    );

    expect(replace).toHaveBeenCalledWith("conn-control-ui", ["agent:main:cold"]);
    expect(respond).toHaveBeenCalledWith(true, { subscribed: true }, undefined);
    finishHydration();
    await request;
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
