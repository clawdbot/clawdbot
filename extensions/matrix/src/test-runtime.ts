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
      media: {
        fetchRemoteMedia: vi.fn(),
        saveMediaBuffer: options.saveMediaBuffer ?? vi.fn(),
      },
    },
  });
}
