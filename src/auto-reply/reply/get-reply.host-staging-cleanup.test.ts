// Tests getReplyFromConfig host workspace staging directory cleanup.
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createGetReplyContinueDirectivesResult } from "./get-reply.test-fixtures.js";

const {
  mocks,
  stageSandboxMediaMock,
  runPreparedReplyMock,
  buildCtx,
} = vi.hoisted(() => ({
  mocks: {
    resolveReplyDirectives: vi.fn(),
    triggerInternalHook: vi.fn(),
  },
  stageSandboxMediaMock: vi.fn(),
  runPreparedReplyMock: vi.fn<(params: any) => Promise<any>>(async () => ({ text: "ok" })),
  buildCtx: (overrides = {}) => ({
    Provider: "telegram",
    Surface: "telegram",
    OriginatingChannel: "telegram",
    AccountId: "default",
    MessageSid: "msg-123",
    SenderId: "user-123",
    CommandBody: "hello",
    BodyForAgent: "hello",
    Timestamp: Date.now(),
    media: [{ path: "/tmp/voice.ogg", contentType: "audio/ogg", url: "/tmp/voice.ogg" }],
    ...overrides,
  }),
}));

vi.mock("./stage-sandbox-media.js", () => ({
  stageSandboxMedia: (params: unknown) => stageSandboxMediaMock(params),
}));

vi.mock("./get-reply-directives.js", () => ({
  resolveReplyDirectives: (params: unknown) => mocks.resolveReplyDirectives(params),
}));

vi.mock("./get-reply-run.js", () => ({
  runPreparedReply: (params: unknown) => runPreparedReplyMock(params),
}));

const { getReplyFromConfig } = await import("./get-reply.js");

describe("getReplyFromConfig host workspace staging cleanup", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("cleans up hostWorkspaceStagingDir in finally block when getReply completes", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const { markCompleteReplyConfig } = await import("./get-reply-fast-path.test-support.js");

    const tempDir = tempDirs.make("openclaw-test-staging-");
    await expect(fs.stat(tempDir)).resolves.toBeDefined();

    await fs.writeFile(path.join(tempDir, "staged-file.txt"), "content");

    vi.mocked(stageSandboxMediaMock).mockResolvedValueOnce({
      staged: new Map(),
      hostWorkspaceStagingDir: tempDir,
    });

    mocks.resolveReplyDirectives.mockResolvedValueOnce(
      createGetReplyContinueDirectivesResult({
        body: "body",
        abortKey: "agent:main:session-id",
        from: "telegram:user",
        to: "telegram:local",
        senderId: "telegram:user",
        commandSource: "native",
        senderIsOwner: true,
        resetHookTriggered: false,
        provider: "openai",
        model: "gpt-4o-mini",
      }),
    );

    const reply = await getReplyFromConfig(
      buildCtx({ SessionKey: "agent:main:session-id" }),
      undefined,
      markCompleteReplyConfig({}, { runtimeMode: "full" }),
    );

    expect(reply).toEqual({ text: "ok" });
    const existsAfter = await fs
      .stat(tempDir)
      .then(() => true)
      .catch(() => false);
    expect(existsAfter).toBe(false);
  });

  it("delegates hostWorkspaceStagingDir cleanup when getReply enqueues a follow-up", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const { markCompleteReplyConfig } = await import("./get-reply-fast-path.test-support.js");

    const tempDir = tempDirs.make("openclaw-test-staging-delegated-");
    await expect(fs.stat(tempDir)).resolves.toBeDefined();

    await fs.writeFile(path.join(tempDir, "staged-file.txt"), "content");

    vi.mocked(stageSandboxMediaMock).mockResolvedValueOnce({
      staged: new Map(),
      hostWorkspaceStagingDir: tempDir,
    });

    mocks.resolveReplyDirectives.mockResolvedValueOnce(
      createGetReplyContinueDirectivesResult({
        body: "body",
        abortKey: "agent:main:session-id",
        from: "telegram:user",
        to: "telegram:local",
        senderId: "telegram:user",
        commandSource: "native",
        senderIsOwner: true,
        resetHookTriggered: false,
        provider: "openai",
        model: "gpt-4o-mini",
      }),
    );

    let lifecycleRef: any = null;

    vi.mocked(runPreparedReplyMock).mockImplementation(async (params) => {
      if (params.opts?.turnAdoptionLifecycle) {
        lifecycleRef = params.opts.turnAdoptionLifecycle;
        lifecycleRef.onDeferred?.();
      }
      return undefined;
    });

    const reply = await getReplyFromConfig(
      buildCtx({ SessionKey: "agent:main:session-id" }),
      { turnAdoptionLifecycle: { onAdopted: () => {} } },
      markCompleteReplyConfig({}, { runtimeMode: "full" }),
    );

    expect(reply).toBeUndefined();

    const existsAfterReply = await fs
      .stat(tempDir)
      .then(() => true)
      .catch(() => false);
    expect(existsAfterReply).toBe(true);

    expect(lifecycleRef).toBeDefined();
    lifecycleRef?.onSettled?.();

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    const existsAfterSettle = await fs
      .stat(tempDir)
      .then(() => true)
      .catch(() => false);
    expect(existsAfterSettle).toBe(false);
  });

  it("cleans up hostWorkspaceStagingDir immediately when queue admission returns false", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const { markCompleteReplyConfig } = await import("./get-reply-fast-path.test-support.js");
    const tempDir = tempDirs.make("openclaw-test-staging-rejected-");
    await expect(fs.stat(tempDir)).resolves.toBeDefined();

    await fs.writeFile(path.join(tempDir, "staged-file.txt"), "content");

    vi.mocked(stageSandboxMediaMock).mockResolvedValueOnce({
      staged: new Map(),
      hostWorkspaceStagingDir: tempDir,
    });

    mocks.resolveReplyDirectives.mockResolvedValueOnce(
      createGetReplyContinueDirectivesResult({
        body: "body",
        abortKey: "agent:main:session-id",
        from: "telegram:user",
        to: "telegram:local",
        senderId: "telegram:user",
        commandSource: "native",
        senderIsOwner: true,
        resetHookTriggered: false,
        provider: "openai",
        model: "gpt-4o-mini",
      }),
    );

    vi.mocked(runPreparedReplyMock).mockImplementation(async (params) => {
      if (params.opts?.turnAdoptionLifecycle) {
        params.opts.turnAdoptionLifecycle.onDeferred?.();
      }
      return undefined;
    });

    const reply = await getReplyFromConfig(
      buildCtx({ SessionKey: "agent:main:session-id" }),
      {
        turnAdoptionLifecycle: {
          onAdopted: () => {},
          onDeferred: () => false,
        },
      },
      markCompleteReplyConfig({}, { runtimeMode: "full" }),
    );

    expect(reply).toBeUndefined();

    const existsAfterReply = await fs
      .stat(tempDir)
      .then(() => true)
      .catch(() => false);
    expect(existsAfterReply).toBe(false);
  });

  it("retains hostWorkspaceStagingDir during queue wait for plain queued follow-ups without adoption lifecycle, reading staged media in deferred turn before terminal cleanup", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const { markCompleteReplyConfig } = await import("./get-reply-fast-path.test-support.js");
    const tempDir = tempDirs.make("openclaw-test-staging-plain-queued-");
    await expect(fs.stat(tempDir)).resolves.toBeDefined();

    await fs.writeFile(path.join(tempDir, "staged-file.txt"), "content");

    vi.mocked(stageSandboxMediaMock).mockResolvedValueOnce({
      staged: new Map(),
      hostWorkspaceStagingDir: tempDir,
    });

    mocks.resolveReplyDirectives.mockResolvedValueOnce(
      createGetReplyContinueDirectivesResult({
        body: "body",
        abortKey: "agent:main:session-id",
        from: "telegram:user",
        to: "telegram:local",
        senderId: "telegram:user",
        commandSource: "native",
        senderIsOwner: true,
        resetHookTriggered: false,
        provider: "openai",
        model: "gpt-4o-mini",
      }),
    );

    let followupRunCapture: any = undefined;
    let onHostStagingDelegatedCapture: any = undefined;
    vi.mocked(runPreparedReplyMock).mockImplementationOnce(async (params) => {
      followupRunCapture = params;
      onHostStagingDelegatedCapture = params.opts?.onHostStagingDelegated;
      if (onHostStagingDelegatedCapture) {
        onHostStagingDelegatedCapture();
      }
      return { queued: true } as any;
    });

    const reply = await getReplyFromConfig(
      buildCtx({
        SessionKey: "agent:main:session-id",
        CommandBody: "first-turn",
        media: [{ path: "/tmp/voice.ogg", contentType: "audio/ogg", url: "/tmp/voice.ogg" }],
      }),
      undefined,
      markCompleteReplyConfig({}, { runtimeMode: "full" }),
    );

    expect(reply).toEqual({ queued: true });

    const existsAfterQueue = await fs
      .stat(tempDir)
      .then(() => true)
      .catch(() => false);
    expect(existsAfterQueue).toBe(true);

    expect(followupRunCapture).toBeDefined();

    const { completeFollowupRunLifecycle } = await import("./queue/types.js");
    completeFollowupRunLifecycle({
      hostWorkspaceStagingDir: tempDir,
      steerPending: undefined,
      turnAdoptionLifecycle: undefined,
    });

    let existsAfterSettle = true;
    for (let i = 0; i < 50; i++) {
      existsAfterSettle = await fs
        .stat(tempDir)
        .then(() => true)
        .catch(() => false);
      if (!existsAfterSettle) {
        break;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    expect(existsAfterSettle).toBe(false);
  });
});
