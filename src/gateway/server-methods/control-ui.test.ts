import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import * as providerModelNormalization from "../../agents/provider-model-normalization.runtime.js";
import { createPluginMetadataSnapshot } from "../../config/plugin-auto-enable.test-helpers.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import { SecretSurfaceUnavailableError } from "../../secrets/runtime-degraded-state.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import type { ControlUiGitHubPreview, ControlUiSessionPreview } from "../control-ui-contract.js";
import { ControlUiGitHubError } from "../control-ui-github-api.js";
import * as sessionTranscriptTitleReader from "../session-transcript-title-reader.js";
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

  it("preserves a configured-unavailable preview credential diagnostic", async () => {
    const error = new SecretSurfaceUnavailableError({
      ownerKind: "capability",
      ownerId: "control-ui-github",
      state: "unavailable",
      paths: ["gateway.controlUi.github.token"],
      refKeys: [],
      reason: "secret reference was not found",
    });
    const handlers = createControlUiHandlers(vi.fn().mockRejectedValue(error));
    const respond = vi.fn<RespondFn>();

    await expectDefined(
      handlers["controlUi.githubPreview"],
      'handlers["controlUi.githubPreview"] test invariant',
    )(
      requestOptions({ kind: "pull", number: 99816, owner: "openclaw", repo: "openclaw" }, respond),
    );

    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "UNAVAILABLE",
      message:
        "The configured Control UI GitHub credential is unavailable. Resolve gateway.controlUi.github.token and retry.",
      retryable: false,
    });
  });
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

  it("projects stored session previews without executing provider normalization", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          defaults: { model: { primary: "preview-provider/legacy-model" } },
          entries: { main: {} },
        },
      };
      const sessionKey = "agent:main:dashboard:preview";
      const updatedAt = 1_786_000_000_000;
      const storedEntry = expectDefined(
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: "session-preview",
            updatedAt,
            label: "Research notes",
            archivedAt: updatedAt + 1,
            delivery: normalizeSessionDeliveryState({
              context: { channel: "telegram", to: "preview-chat" },
            }),
          },
        ),
        "preview session persisted",
      );
      const metadata = createPluginMetadataSnapshot({
        config: cfg,
        manifestRegistry: { plugins: [], diagnostics: [] },
      });
      const normalize = vi
        .spyOn(providerModelNormalization, "normalizeProviderModelIdWithRuntime")
        .mockImplementation(() => {
          throw new Error("Session previews must not execute provider normalization");
        });
      const titleFields = vi
        .spyOn(sessionTranscriptTitleReader, "readSessionTitleFieldsFromTranscript")
        .mockReturnValue({
          firstUserMessage: "First request",
          lastMessagePreview: "Latest response",
        });
      try {
        const respond = vi.fn<RespondFn>();
        await withPluginMetadataSnapshotScope(
          metadata,
          () =>
            expectDefined(
              createControlUiHandlers()["controlUi.sessionPreview"],
              'handlers["controlUi.sessionPreview"] test invariant',
            )(
              requestOptions({ sessionKey }, respond, {
                context: { getRuntimeConfig: () => cfg },
              }),
            ),
          { config: cfg, trustConfigIdentity: true },
        );

        expect(normalize).not.toHaveBeenCalled();
        expect(respond).toHaveBeenCalledWith(
          true,
          {
            status: "ok",
            sessionKey,
            agentId: "main",
            title: "Research notes",
            derivedTitle: "Research notes",
            kind: "direct",
            channel: "telegram",
            updatedAt: storedEntry.updatedAt,
            lastMessagePreview: "Latest response",
            archived: true,
          },
          undefined,
        );
      } finally {
        titleFields.mockRestore();
        normalize.mockRestore();
      }
    });
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
