import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { rejectGitHubPublicationSelection } from "../github-publication-failure.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { sessionsGitHubHandlers } from "./sessions-github.js";
import type { SessionMutationAuthorization } from "./types.js";

const mocks = vi.hoisted(() => ({
  caller: vi.fn(),
  loadSession: vi.fn(),
  request: vi.fn(),
}));

vi.mock("../../agents/tools/gateway-caller-context.js", () => ({
  getGatewayToolCallerIdentity: mocks.caller,
}));
vi.mock("../session-utils.js", () => ({
  loadGatewaySessionEntryReadOnly: mocks.loadSession,
}));

async function invoke(
  params: Record<string, unknown>,
  sessionMutationAuthorization?: SessionMutationAuthorization,
) {
  const respond = vi.fn();
  await expectDefined(
    sessionsGitHubHandlers["sessions.github.publish"],
    "sessions.github.publish handler",
  )({
    params,
    respond: respond as never,
    context: {
      githubPublicationService: { requestForSession: mocks.request },
    } as never,
    client: null,
    req: { type: "req", id: "req-publication", method: "sessions.github.publish" },
    isWebchatConnect: () => false,
    ...(sessionMutationAuthorization ? { sessionMutationAuthorization } : {}),
  });
  return respond;
}

describe("sessions.github.publish", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.caller.mockReturnValue({
      agentId: "main",
      sessionKey: "agent:main:dashboard:task",
      operationalRunInstance: { runId: "run-1" },
    });
    mocks.loadSession.mockReturnValue({
      canonicalKey: "agent:main:dashboard:task",
      agentId: "main",
      entry: { sessionId: "session-1" },
    });
    mocks.request.mockResolvedValue({
      requestId: "publication-1",
      status: "requested",
      message: "Publication was accepted.",
    });
  });

  it("uses host-owned caller identity and forwards only bounded intent", async () => {
    const respond = await invoke({
      idempotencyKey: "tool-call-1",
      title: "Publish the fix",
    });

    expect(mocks.request).toHaveBeenCalledWith({
      idempotencyKey: "tool-call-1",
      title: "Publish the fix",
      sessionKey: "agent:main:dashboard:task",
      agentId: "main",
      expectedRunId: "run-1",
    });
    expect(respond).toHaveBeenCalledWith(true, {
      requestId: "publication-1",
      status: "requested",
      message: "Publication was accepted.",
    });
  });

  it.each(["fresh", "existing", "wrong-key", "lookup-failed", "ordinary"])(
    "forwards only the exact owner's %s selection rejection fact",
    async (mode) => {
      const key = "publication-selection";
      mocks.request.mockImplementationOnce(() => {
        if (mode === "ordinary") {
          throw new Error("GitHub publication identity changed.");
        }
        rejectGitHubPublicationSelection("GitHub publication identity changed.", {
          idempotencyKey: mode === "wrong-key" ? "another-invocation" : key,
          hasRequest: () => {
            if (mode === "lookup-failed") {
              throw new Error("Receipt lookup unavailable.");
            }
            return mode === "existing";
          },
        });
      });
      const respond = await invoke({ idempotencyKey: key });
      expect(respond).toHaveBeenCalledWith(false, undefined, {
        code: "UNAVAILABLE",
        message: "GitHub publication identity changed.",
        ...(mode === "fresh"
          ? { details: { code: "GITHUB_PUBLICATION_SELECTION_REJECTED", idempotencyKey: key } }
          : {}),
      });
    },
  );

  it("rejects caller-supplied repository authority at the protocol boundary", async () => {
    const respond = await invoke({
      idempotencyKey: "tool-call-1",
      repository: "openclaw/openclaw",
      branch: "main",
      token: "secret",
    });

    expect(mocks.request).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("canonicalizes an operator-selected session before publication", async () => {
    mocks.caller.mockReturnValue(undefined);
    mocks.loadSession.mockReturnValue({
      canonicalKey: "agent:main:main",
      agentId: "main",
      entry: { sessionId: "session-main" },
    });

    await invoke({ sessionKey: "main", idempotencyKey: "operator-publication-1" });

    expect(mocks.request).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      idempotencyKey: "operator-publication-1",
      agentId: "main",
    });
  });

  it("rejects a publication whose session authorization changes while verification waits", async () => {
    let resolveRequest: ((value: unknown) => void) | undefined;
    mocks.request.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          resolveRequest = resolve;
        }),
    );
    let authorized = true;
    const changed = new SessionMutationAuthorizationChangedError(
      errorShape(ErrorCodes.INVALID_REQUEST, "session participation changed"),
    );
    const authorization: SessionMutationAuthorization = {
      assertCurrent: () => {
        if (!authorized) {
          throw changed;
        }
      },
      assertTargetCurrent: vi.fn(),
    };

    const pending = invoke(
      { sessionKey: "agent:main:dashboard:task", idempotencyKey: "publication-revoked" },
      authorization,
    );
    await vi.waitFor(() => expect(resolveRequest).toBeTypeOf("function"));
    authorized = false;
    resolveRequest?.({
      requestId: "publication-revoked",
      status: "requested",
      message: "Publication was accepted.",
    });

    await expect(pending).rejects.toBe(changed);
    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({ assertCurrent: authorization.assertCurrent }),
    );
  });
});
