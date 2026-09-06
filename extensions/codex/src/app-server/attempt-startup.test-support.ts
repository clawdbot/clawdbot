import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type {
  CodexBundleMcpThreadConfig,
  EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, vi } from "vitest";
import { startCodexAttemptThread } from "./attempt-startup.js";
import { withEphemeralCodexAuthStore } from "./auth-start-options.js";
import { CodexAppServerClient } from "./client.js";
import {
  type CodexPluginConfig,
  resolveCodexAppServerRuntimeOptions,
  resolveCodexComputerUseConfig,
} from "./config.js";
import { createCodexTestHostCapabilities } from "./host-capability.test-support.js";
import { testCodexAppServerBindingStore } from "./session-binding.test-helpers.js";
import {
  getLeasedSharedCodexAppServerClient,
  resolveCodexAppServerSpawnIdentity,
  type CodexAppServerPreparedAuth,
  type CodexAppServerClientFactory,
} from "./shared-client.js";
import { createClientHarness, createCodexTestModel } from "./test-support.js";

export type AttemptClientHarness = ReturnType<typeof createClientHarness>;
export const HARNESS_REQUEST_TIMEOUT_MS = 15_000;

export function createAttemptClientHarness(): AttemptClientHarness {
  return createClientHarness({
    onWrite: (line, send) => {
      const request = JSON.parse(line) as { id: number; method: string };
      if (request.method === "config/read") {
        send({ id: request.id, result: { config: {}, origins: {}, layers: [] } });
      }
      if (request.method === "configRequirements/read") {
        send({ id: request.id, result: { requirements: null } });
      }
    },
  });
}

export function createAttemptThreadStarter(
  tempRoots: Set<string>,
  pluginConfig: CodexPluginConfig,
) {
  return function startThreadWithHarness(
    startupTimeoutMs: number,
    signal = new AbortController().signal,
    overrides?: {
      pluginConfig?: CodexPluginConfig;
      startupPreparedAuth?: CodexAppServerPreparedAuth;
      attemptClientFactory?: (harness: AttemptClientHarness) => CodexAppServerClientFactory;
      buildAttemptParams?: () => EmbeddedRunAttemptParams;
      harness?: AttemptClientHarness;
      paths?: AttemptPaths;
      skipStartSpy?: boolean;
      runtimeArtifactRequest?: Parameters<
        typeof startCodexAttemptThread
      >[0]["runtimeArtifactRequest"];
      sandbox?: Parameters<typeof startCodexAttemptThread>[0]["sandbox"];
      sandboxExecServerEnabled?: boolean;
      runtime?: Parameters<typeof startCodexAttemptThread>[0]["runtime"];
      appServer?: Parameters<typeof startCodexAttemptThread>[0]["appServer"];
    },
  ) {
    const harness = overrides?.harness ?? createAttemptClientHarness();
    const paths = overrides?.paths ?? createAttemptPaths(tempRoots);
    const startSpy = overrides?.skipStartSpy
      ? undefined
      : vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
    const effectivePluginConfig = overrides?.pluginConfig ?? pluginConfig;

    const run = startCodexAttemptThread({
      bindingStore: testCodexAppServerBindingStore,
      runtime: overrides?.runtime,
      attemptClientFactory:
        overrides?.attemptClientFactory?.(harness) ?? getLeasedSharedCodexAppServerClient,
      appServer:
        overrides?.appServer ??
        resolveCodexAppServerRuntimeOptions({ pluginConfig: effectivePluginConfig }),
      pluginConfig: effectivePluginConfig,
      computerUseConfig: resolveCodexComputerUseConfig({ pluginConfig: effectivePluginConfig }),
      startupAuthProfileId: undefined,
      startupAuthBindingFingerprint: undefined,
      ...(overrides?.runtimeArtifactRequest
        ? { runtimeArtifactRequest: overrides.runtimeArtifactRequest }
        : {}),
      startupPreparedAuth: overrides?.startupPreparedAuth,
      startupAuthAccountCacheKey: undefined,
      startupEnvApiKeyCacheKey: undefined,
      agentDir: paths.agentDir,
      config: undefined,
      buildAttemptParams: overrides?.buildAttemptParams ?? (() => createAttemptParams(paths)),
      sessionAgentId: "agent-1",
      effectiveWorkspace: paths.workspaceDir,
      effectiveCwd: paths.cwd,
      dynamicTools: [],
      webSearchAllowed: false,
      developerInstructions: undefined,
      finalConfigPatch: undefined,
      bundleMcpThreadConfig,
      nativeToolSurfaceEnabled: true,
      nativeProviderWebSearchSupport: "supported",
      sandboxExecServerEnabled: overrides?.sandboxExecServerEnabled ?? false,
      sandbox: overrides?.sandbox ?? null,
      contextEngineProjection: undefined,
      startupTimeoutMs,
      signal,
      onStartupTimeout: vi.fn(),
      spawnedBy: undefined,
    });

    return { harness, run, startSpy };
  };
}

export function readHarnessMessages(
  writes: string[],
): Array<{ id?: number; method?: string; params?: unknown }> {
  return writes.map(
    (write) => JSON.parse(write) as { id?: number; method?: string; params?: unknown },
  );
}

export function readHarnessRequestMethods(
  harness: AttemptClientHarness,
): Array<string | undefined> {
  return readHarnessMessages(harness.writes)
    .filter(({ id }) => id !== undefined)
    .map(({ method }) => method);
}

export async function answerInitialize(harness: AttemptClientHarness): Promise<void> {
  await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThanOrEqual(1), {
    interval: 1,
    timeout: HARNESS_REQUEST_TIMEOUT_MS,
  });
  const initialize = JSON.parse(harness.writes[0] ?? "{}") as { id?: number };
  harness.send({ id: initialize.id, result: { userAgent: "openclaw/0.149.0 (macOS; test)" } });
}

export async function answerPreparedApiKeyLogin(harness: AttemptClientHarness): Promise<void> {
  const login = await waitForRequest(harness, "account/login/start");
  expect(login.params).toEqual({
    type: "apiKey",
    apiKey: "prepared-platform-key",
  });
  harness.send({ id: login.id, result: { type: "apiKey" } });
}

export async function waitForRequest(
  harness: AttemptClientHarness,
  method: string,
): Promise<{ id?: number; method?: string; params?: unknown }> {
  await vi.waitFor(
    () =>
      expect(readHarnessMessages(harness.writes).some((write) => write.method === method)).toBe(
        true,
      ),
    { interval: 1, timeout: HARNESS_REQUEST_TIMEOUT_MS },
  );
  const request = readHarnessMessages(harness.writes).find((write) => write.method === method);
  if (!request) {
    throw new Error(`${method} request was not written`);
  }
  return request;
}

export async function waitForThreadStart(harness: AttemptClientHarness): Promise<{ id?: number }> {
  return waitForRequest(harness, "thread/start");
}

export async function captureExpectedRuntimeArtifact(
  appServer: ReturnType<typeof resolveCodexAppServerRuntimeOptions>,
) {
  const { captureCodexAppServerRuntimeArtifactBeforeStart, finalizeCodexAppServerRuntimeArtifact } =
    await import("./runtime-artifact.js");
  const startOptions = withEphemeralCodexAuthStore({ startOptions: appServer.start });
  const spawnIdentity = resolveCodexAppServerSpawnIdentity(startOptions);
  const before = await captureCodexAppServerRuntimeArtifactBeforeStart({
    startOptions,
    spawnIdentity,
  });
  return finalizeCodexAppServerRuntimeArtifact({
    before,
    startOptions,
    spawnIdentity,
    runtimeIdentity: { serverVersion: "0.149.0", userAgent: "openclaw/0.149.0 (macOS; test)" },
  });
}

export function createPairedAttemptRuntime() {
  const channels: Array<{ close: ReturnType<typeof vi.fn>; sessionId: string }> = [];
  const openDuplex = vi.fn<
    NonNullable<Parameters<typeof startCodexAttemptThread>[0]["runtime"]>["nodes"]["openDuplex"]
  >(async (request) => {
    let resolveClosed: (value: unknown) => void = () => undefined;
    const closed = new Promise<unknown>((resolve) => {
      resolveClosed = resolve;
    });
    const channel = {
      send: vi.fn(async () => undefined),
      onMessage: vi.fn(() => () => undefined),
      closed,
      close: vi.fn(() => resolveClosed({ ok: true })),
    };
    channels.push({
      close: channel.close,
      sessionId: (request.params as { sessionId: string }).sessionId,
    });
    return channel;
  });
  return {
    runtime: createPluginRuntimeMock({ nodes: { openDuplex } }),
    channels,
    openDuplex,
  };
}

export type AttemptPaths = {
  agentDir: string;
  cwd: string;
  sessionFile: string;
  workspaceDir: string;
};

export function createAttemptPaths(tempRoots: Set<string>): AttemptPaths {
  const root = path.join(os.tmpdir(), `openclaw-codex-attempt-startup-${randomUUID()}`);
  tempRoots.add(root);
  return {
    agentDir: path.join(root, "agent"),
    cwd: path.join(root, "workspace"),
    sessionFile: path.join(root, "session.jsonl"),
    workspaceDir: path.join(root, "workspace"),
  };
}

export function createAttemptParams(paths: AttemptPaths): EmbeddedRunAttemptParams {
  return {
    hostCapabilities: createCodexTestHostCapabilities(),
    prompt: "hello",
    sessionId: "session-1",
    sessionKey: "agent:agent-1:session-1",
    agentDir: paths.agentDir,
    sessionFile: paths.sessionFile,
    effectiveCwd: paths.cwd,
    workspaceDir: paths.workspaceDir,
    runId: "run-1",
    provider: "codex",
    modelId: "gpt-5.4-codex",
    model: createCodexTestModel("codex"),
    thinkLevel: "medium",
    disableTools: true,
    timeoutMs: 5_000,
    authStorage: {} as never,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: {} as never,
  } as EmbeddedRunAttemptParams;
}

const bundleMcpThreadConfig = {
  configPatch: undefined,
  diagnostics: [],
  evaluated: false,
  fingerprint: undefined,
  staticServerNames: [],
  userStaticServerNames: [],
} satisfies CodexBundleMcpThreadConfig;
