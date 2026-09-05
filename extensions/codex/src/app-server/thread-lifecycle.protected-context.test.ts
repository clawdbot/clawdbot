import path from "node:path";
import { describe, expect, it } from "vitest";
import { isJsonObject } from "./protocol.js";
import {
  createParams,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import {
  readCodexAppServerBinding,
  registerCodexTestSessionIdentity,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import {
  createLeasedCodexLifecycleHarness,
  startOrResumeThread,
} from "./thread-lifecycle.test-fixtures.js";

type LifecycleParams = Parameters<typeof startOrResumeThread>[0];

const runtimeFingerprint = "synthetic-protected-runtime";

async function createProtectedLifecycleFixture() {
  const sessionFile = path.join(tempDir, "session.jsonl");
  const cwd = path.join(tempDir, "workspace");
  const params = createParams(sessionFile, path.join(tempDir, "workspace"));
  params.agentDir = path.join(tempDir, "agent");
  params.modelId = "synthetic-model";
  params.model = { ...params.model, id: params.modelId };
  registerCodexTestSessionIdentity(sessionFile, params.sessionId, params.sessionKey);
  let nextThread = 1;
  let responseCwd = cwd;
  const wire = await createLeasedCodexLifecycleHarness({
    agentDir: params.agentDir,
    respond: (method, requestParams) => {
      if (method === "config/read") {
        return {
          config: { project_root_markers: [], projects: { [cwd]: { trust_level: "untrusted" } } },
          origins: {},
          layers: [],
        };
      }
      if (method === "thread/start" || method === "thread/resume") {
        const threadId =
          method === "thread/start"
            ? `synthetic-thread-${nextThread++}`
            : isJsonObject(requestParams) && typeof requestParams.threadId === "string"
              ? requestParams.threadId
              : undefined;
        if (!threadId) {
          throw new Error("Synthetic resume requires a thread id");
        }
        return {
          ...threadStartResult(threadId, { cwd: responseCwd }),
          cwd,
          model: params.modelId,
        };
      }
      if (method === "thread/delete") {
        return {};
      }
      throw new Error(`Unexpected protected lifecycle request: ${method}`);
    },
  });
  const start = (overrides: Partial<LifecycleParams> = {}) =>
    startOrResumeThread({
      client: wire.client,
      params,
      cwd,
      dynamicTools: [],
      appServer: {
        start: { transport: "stdio", command: "codex", args: ["app-server"], headers: {} },
        requestTimeoutMs: 5_000,
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: "read-only",
        codeModeOnly: false,
        loopDetectionPreToolUseRelay: true,
        connectionClass: "local-loopback",
        remoteAppsSubstrate: "preconfigured",
      },
      nativeCodeModeEnabled: false,
      persistentWebSearchAllowed: false,
      webSearchAllowed: false,
      userMcpServersEnabled: false,
      appServerRuntimeFingerprint: runtimeFingerprint,
      requireProtectedNativeContext: true,
      ...overrides,
    });
  return {
    ...wire,
    sessionFile,
    cwd,
    start,
    setResponseCwd: (value: string) => {
      responseCwd = value;
    },
    bind: async () => {
      const started = await start();
      await wire.endTurn(started.threadId);
      wire.request.mockClear();
      const binding = await readCodexAppServerBinding(sessionFile);
      if (!binding) {
        throw new Error("Synthetic protected thread did not persist its binding");
      }
      return binding;
    },
  };
}

describe("protected native thread lifecycle", () => {
  setupRunAttemptTestHooks();

  it.each([undefined, ""])(
    "rejects runtime fingerprint %j before native requests",
    async (value) => {
      const fixture = await createProtectedLifecycleFixture();

      await expect(fixture.start({ appServerRuntimeFingerprint: value })).rejects.toThrow(
        "Codex protected native context requires a runtime fingerprint",
      );

      expect(fixture.request).not.toHaveBeenCalled();
      expect(await readCodexAppServerBinding(fixture.sessionFile)).toBeUndefined();
    },
  );

  it.each([
    { name: "missing fingerprint", fingerprint: undefined, pending: false, wrongCwd: false },
    { name: "stale fingerprint", fingerprint: "synthetic-stale", pending: false, wrongCwd: false },
    { name: "wrong cwd", fingerprint: runtimeFingerprint, pending: false, wrongCwd: true },
    { name: "pending missing fingerprint", fingerprint: undefined, pending: true, wrongCwd: false },
    {
      name: "pending stale fingerprint",
      fingerprint: "synthetic-stale",
      pending: true,
      wrongCwd: false,
    },
    { name: "pending wrong cwd", fingerprint: runtimeFingerprint, pending: true, wrongCwd: true },
  ])("rotates local binding with $name before native resume", async (scenario) => {
    const fixture = await createProtectedLifecycleFixture();
    const previous = await fixture.bind();
    await writeCodexAppServerBinding(fixture.sessionFile, {
      ...previous,
      appServerRuntimeFingerprint: scenario.fingerprint,
      cwd: scenario.wrongCwd ? path.join(tempDir, "unprotected") : fixture.cwd,
      ...(scenario.pending ? { pendingResumeConfiguration: true } : {}),
    });

    const binding = await fixture.start();

    expect(binding.lifecycle.action).toBe("started");
    expect(binding.threadId).not.toBe(previous.threadId);
    expect(fixture.request.mock.calls.map(([method]) => method)).not.toContain("thread/resume");
    expect(fixture.request.mock.calls.map(([method]) => method)).not.toContain("thread/read");
    expect(await readCodexAppServerBinding(fixture.sessionFile)).toMatchObject({
      threadId: binding.threadId,
      cwd: fixture.cwd,
      appServerRuntimeFingerprint: runtimeFingerprint,
    });
    expect(
      (await readCodexAppServerBinding(fixture.sessionFile))?.pendingResumeConfiguration,
    ).toBeUndefined();
  });

  it("resumes a binding with matching protected runtime and cwd", async () => {
    const fixture = await createProtectedLifecycleFixture();
    const previous = await fixture.bind();

    const binding = await fixture.start();

    expect(binding.lifecycle.action).toBe("resumed");
    expect(binding.threadId).toBe(previous.threadId);
    expect(fixture.request.mock.calls.map(([method]) => method)).toContain("thread/resume");
    expect(fixture.request.mock.calls.map(([method]) => method)).not.toContain("thread/start");
    expect(await readCodexAppServerBinding(fixture.sessionFile)).toMatchObject({
      threadId: previous.threadId,
      cwd: fixture.cwd,
      appServerRuntimeFingerprint: runtimeFingerprint,
    });
  });

  it.each(["start", "resume"] as const)(
    "rejects native %s with a different cwd before handoff and cleans up",
    async (action) => {
      const fixture = await createProtectedLifecycleFixture();
      const previous = action === "resume" ? await fixture.bind() : undefined;
      fixture.setResponseCwd(path.join(tempDir, "unprotected"));

      await expect(fixture.start()).rejects.toThrow(
        "Codex thread did not use the protected native working directory",
      );

      const methods = fixture.request.mock.calls.map(([method]) => method);
      expect(methods).toContain(`thread/${action}`);
      expect(methods).not.toContain("thread/inject_items");
      expect(methods).not.toContain("turn/start");
      expect(await readCodexAppServerBinding(fixture.sessionFile)).toEqual(previous);
      expect(fixture.request).toHaveBeenCalledWith(
        action === "resume" ? "thread/unsubscribe" : "thread/delete",
        { threadId: previous?.threadId ?? "synthetic-thread-1" },
        expect.anything(),
      );
      if (action === "resume") {
        expect(methods).not.toContain("thread/delete");
        expect(methods).not.toContain("thread/start");
      }
    },
  );
});
