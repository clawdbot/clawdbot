import {
  implicitMentionKindWhen,
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-mention-gating";
import { vi } from "vitest";
import type { PluginRuntime } from "./runtime-api.js";
import { setMatrixRuntime } from "./runtime.js";

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
  state: Pick<NonNullable<PluginRuntime["state"]>, "resolveStateDir">;
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
  const defaultStateDirResolver: NonNullable<PluginRuntime["state"]>["resolveStateDir"] = (
    _env,
    homeDir,
  ) => options.stateDir ?? (homeDir ?? (() => "/tmp"))();
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
