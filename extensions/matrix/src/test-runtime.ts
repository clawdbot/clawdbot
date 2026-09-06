// Matrix plugin module implements test runtime behavior.
import fs from "node:fs";
import path from "node:path";
import {
  implicitMentionKindWhen,
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-mention-gating";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type {
  OpenBlobStoreOptions,
  OpenKeyedStoreOptions,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginBlobStoreForTests,
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { afterAll, vi } from "vitest";
import { setMatrixRuntime } from "./runtime.js";

const defaultStateDir = fs.realpathSync(
  fs.mkdtempSync(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-matrix-test-state-")),
);

afterAll(() => {
  resetPluginStateStoreForTests();
  fs.rmSync(defaultStateDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 20,
  });
});

type MatrixTestRuntimeOptions = {
  cfg?: Record<string, unknown>;
  logging?: Partial<PluginRuntime["logging"]>;
  channel?: Partial<PluginRuntime["channel"]>;
  stateDir?: string;
};

type MatrixRuntimeStub = {
  config: Pick<PluginRuntime["config"], "current" | "mutateConfigFile" | "replaceConfigFile">;
  channel?: PluginRuntime["channel"];
  logging?: PluginRuntime["logging"];
  state: Pick<
    NonNullable<PluginRuntime["state"]>,
    "openBlobStore" | "openKeyedStore" | "openSyncKeyedStore" | "resolveStateDir"
  >;
};

function createMatrixRuntimeMediaMock(
  overrides: Partial<NonNullable<PluginRuntime["channel"]>["media"]> = {},
): NonNullable<PluginRuntime["channel"]>["media"] {
  const readRemoteMediaBuffer = vi.fn() as NonNullable<
    PluginRuntime["channel"]
  >["media"]["readRemoteMediaBuffer"];
  return {
    readRemoteMediaBuffer,
    fetchRemoteMedia: readRemoteMediaBuffer,
    saveRemoteMedia: vi.fn().mockResolvedValue({
      path: "/tmp/test-media.jpg",
      contentType: "image/jpeg",
    }) as NonNullable<PluginRuntime["channel"]>["media"]["saveRemoteMedia"],
    saveResponseMedia: vi.fn().mockResolvedValue({
      path: "/tmp/test-media.jpg",
      contentType: "image/jpeg",
    }) as NonNullable<PluginRuntime["channel"]>["media"]["saveResponseMedia"],
    saveMediaBuffer: vi.fn().mockResolvedValue({
      path: "/tmp/test-media.jpg",
      contentType: "image/jpeg",
    }) as NonNullable<PluginRuntime["channel"]>["media"]["saveMediaBuffer"],
    ...overrides,
  };
}

export function installMatrixTestRuntime(options: MatrixTestRuntimeOptions = {}): void {
  const stateDir = options.stateDir ?? defaultStateDir;
  const defaultStateDirResolver: NonNullable<PluginRuntime["state"]>["resolveStateDir"] = (
    _env,
    _homeDir,
  ) => stateDir;
  const resolvePluginStateEnv = (storeOptions: OpenKeyedStoreOptions): NodeJS.ProcessEnv => ({
    ...(storeOptions.env ?? process.env),
    OPENCLAW_STATE_DIR:
      storeOptions.env?.OPENCLAW_STATE_DIR?.trim() || defaultStateDirResolver(storeOptions.env),
  });
  const getRuntimeConfig = () => options.cfg ?? {};
  const logging: PluginRuntime["logging"] | undefined = options.logging
    ? ({
        shouldLogVerbose: () => false,
        getChildLogger: () => ({
          info: () => {},
          warn: () => {},
          error: () => {},
        }),
        ...options.logging,
      } as PluginRuntime["logging"])
    : undefined;

  const runtime: MatrixRuntimeStub = {
    config: {
      current: getRuntimeConfig,
      mutateConfigFile: vi.fn(),
      replaceConfigFile: vi.fn(),
    },
    ...(options.channel ? { channel: options.channel as PluginRuntime["channel"] } : {}),
    ...(logging ? { logging } : {}),
    state: {
      resolveStateDir: defaultStateDirResolver,
      openBlobStore: (<T>(storeOptions: OpenBlobStoreOptions) =>
        createPluginBlobStoreForTests<T>("matrix", storeOptions, {
          ...process.env,
          OPENCLAW_STATE_DIR: defaultStateDirResolver(process.env),
        })) as PluginRuntime["state"]["openBlobStore"],
      openKeyedStore: (<T>(storeOptions: OpenKeyedStoreOptions) =>
        createPluginStateKeyedStoreForTests<T>("matrix", {
          ...storeOptions,
          env: resolvePluginStateEnv(storeOptions),
        })) as PluginRuntime["state"]["openKeyedStore"],
      openSyncKeyedStore: (<T>(storeOptions: OpenKeyedStoreOptions) =>
        createPluginStateSyncKeyedStoreForTests<T>("matrix", {
          ...storeOptions,
          env: resolvePluginStateEnv(storeOptions),
        })) as PluginRuntime["state"]["openSyncKeyedStore"],
    },
  };

  setMatrixRuntime(runtime as unknown as PluginRuntime);
}

type MatrixMonitorTestRuntimeOptions = Pick<MatrixTestRuntimeOptions, "cfg" | "stateDir"> & {
  matchesMentionPatterns?: (text: string, patterns: RegExp[]) => boolean;
  saveMediaBuffer?: NonNullable<NonNullable<PluginRuntime["channel"]>["media"]>["saveMediaBuffer"];
};

export function installMatrixMonitorTestRuntime(
  options: MatrixMonitorTestRuntimeOptions = {},
): void {
  installMatrixTestRuntime({
    cfg: options.cfg,
    stateDir: options.stateDir,
    channel: {
      mentions: {
        buildMentionRegexes: () => [],
        matchesMentionPatterns:
          options.matchesMentionPatterns ??
          ((text: string, patterns: RegExp[]) => patterns.some((pattern) => pattern.test(text))),
        matchesMentionWithExplicit: () => false,
        implicitMentionKindWhen,
        resolveInboundMentionDecision,
      },
      media: createMatrixRuntimeMediaMock({
        saveMediaBuffer: options.saveMediaBuffer ?? vi.fn(),
      }),
    },
  });
}
