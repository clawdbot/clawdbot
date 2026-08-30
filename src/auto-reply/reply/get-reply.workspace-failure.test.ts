// Tests that permanent workspace-state failures become visible terminal replies
// instead of escaping get-reply as retryable ingress errors.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  WorkspaceAliasRepointedError,
  WorkspaceVanishedError,
} from "../../agents/workspace-state-identity.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import {
  buildGetReplyCtx,
  createGetReplySessionState,
  registerGetReplyRuntimeOverrides,
} from "./get-reply.test-fixtures.js";
import "./get-reply.test-runtime-mocks.js";

const mocks = vi.hoisted(() => ({
  resolveReplyDirectives: vi.fn(),
  initSessionState: vi.fn(),
}));
registerGetReplyRuntimeOverrides(mocks);

let getReplyFromConfig: typeof import("./get-reply.js").getReplyFromConfig;
let loadConfigMock: typeof import("../../config/config.js").getRuntimeConfig;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function repointedAliasError(): WorkspaceAliasRepointedError {
  return new WorkspaceAliasRepointedError({
    aliasPath: "/home/user/clawd",
    storedWorkspacePath: "/home/user/clawd-old",
    currentWorkspacePath: "/srv/data/clawd",
  });
}

async function workspaceMock() {
  const { ensureAgentWorkspace } = await import("../../agents/workspace.js");
  return vi.mocked(ensureAgentWorkspace);
}

describe("getReplyFromConfig workspace failures", () => {
  beforeEach(async () => {
    ({ getReplyFromConfig } = await import("./get-reply.js"));
    ({ getRuntimeConfig: loadConfigMock } = await import("../../config/config.js"));
    vi.stubEnv("OPENCLAW_ALLOW_SLOW_REPLY_TESTS", "1");
    mocks.resolveReplyDirectives.mockReset();
    mocks.initSessionState.mockReset();
    vi.mocked(loadConfigMock).mockReset();
    vi.mocked(loadConfigMock).mockReturnValue({});
    (await workspaceMock()).mockReset();
    mocks.resolveReplyDirectives.mockResolvedValue({ kind: "reply", reply: { text: "ok" } });
    const sessionKey = "agent:main:telegram:123";
    const storePath = path.join(tempDirs.make("openclaw-get-reply-session-"), "sessions.json");
    const entry: InternalSessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
    };
    await replaceSessionEntry({ sessionKey, storePath }, entry);
    mocks.initSessionState.mockResolvedValue(
      createGetReplySessionState({
        initialSessionEntry: entry,
        sessionEntry: entry,
        sessionEntryHandle: { replaceCurrent: vi.fn() },
        sessionKey,
        sessionStore: { [sessionKey]: entry },
        storePath,
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("turns a repointed workspace alias into a visible terminal reply", async () => {
    (await workspaceMock()).mockRejectedValueOnce(repointedAliasError());

    const reply = await getReplyFromConfig(buildGetReplyCtx(), undefined, {});

    expect(reply).toMatchObject({
      text: expect.stringContaining("openclaw doctor"),
    });
    expect((reply as { text: string }).text).toContain("⚠️");
  });

  it("never sends workspace paths to the channel", async () => {
    (await workspaceMock()).mockRejectedValueOnce(repointedAliasError());

    const reply = (await getReplyFromConfig(buildGetReplyCtx(), undefined, {})) as {
      text: string;
    };

    // The typed error message embeds absolute host paths; the channel reply
    // must stay a fixed repair notice with no filesystem layout in it.
    expect(reply.text).not.toContain("/home/user");
    expect(reply.text).not.toContain("/srv/data");
    expect(reply.text).not.toMatch(/(^|[\s(])\/[A-Za-z0-9_.-]+\//u);
  });

  it("turns a vanished workspace into a visible terminal reply", async () => {
    (await workspaceMock()).mockRejectedValueOnce(
      new WorkspaceVanishedError({ workspaceDir: "/home/user/clawd" }),
    );

    const reply = await getReplyFromConfig(buildGetReplyCtx(), undefined, {});

    expect(reply).toMatchObject({
      text: expect.stringContaining("workspace is missing"),
    });
  });

  it("keeps heartbeat workspace failures throwing for heartbeat-owned logging", async () => {
    (await workspaceMock()).mockRejectedValueOnce(repointedAliasError());

    await expect(
      getReplyFromConfig(buildGetReplyCtx(), { isHeartbeat: true }, {}),
    ).rejects.toBeInstanceOf(WorkspaceAliasRepointedError);
  });

  it("rethrows other workspace provisioning failures unchanged", async () => {
    (await workspaceMock()).mockRejectedValueOnce(new Error("EACCES: permission denied"));

    await expect(getReplyFromConfig(buildGetReplyCtx(), undefined, {})).rejects.toThrow(/EACCES/u);
  });
});
