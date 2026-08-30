import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type {
  SessionCatalogHost,
  SessionCatalogTranscriptItem,
} from "openclaw/plugin-sdk/session-catalog";
import type { ActiveSessionCatalog } from "openclaw/plugin-sdk/session-catalog-runtime";
import { createBeamMirrorRunner } from "./mirror.js";

export const beamTestNow = Date.parse("2026-07-27T12:00:00.000Z");
export const beamTestLogger = { warn: () => {}, info: () => {} };
export type BeamTestSession = { threadId: string; name?: string; recencyAt: number };

export function beamTestMirrorConfig(overrides: Record<string, unknown> = {}) {
  return {
    plugins: {
      entries: {
        beam: {
          enabled: true,
          config: {
            mirror: {
              endpoint: "https://team.example/api/v1/beam/sessions",
              catalogs: ["claude", "codex", "beam"],
              ...overrides,
            },
          },
        },
      },
    },
  };
}

export function createBeamTestRuntime(config: unknown): PluginRuntime {
  return { config: { current: () => config } } as unknown as PluginRuntime;
}

export function createBeamTestCatalog(
  params: {
    id?: string;
    sessions?: BeamTestSession[] | (() => BeamTestSession[]);
    items?: SessionCatalogTranscriptItem[] | ((threadId: string) => SessionCatalogTranscriptItem[]);
    nextCursor?: string;
    hostCursor?: string;
    hostKind?: SessionCatalogHost["kind"];
    onList?: () => unknown;
    onRead?: (threadId: string) => unknown;
    processHomeFallbackAllowed?: boolean;
  } = {},
): ActiveSessionCatalog {
  const id = params.id ?? "claude";
  return {
    pluginId: id,
    id,
    label: id,
    processHomeFallbackAllowed: params.processHomeFallbackAllowed ?? true,
    list: async () => {
      await params.onList?.();
      const sessions = typeof params.sessions === "function" ? params.sessions() : params.sessions;
      return [
        {
          hostId: "gateway:local",
          label: "Local",
          kind: params.hostKind ?? "gateway",
          connected: true,
          ...(params.hostCursor ? { nextCursor: params.hostCursor } : {}),
          sessions: (sessions ?? [{ threadId: "t1", recencyAt: beamTestNow }]).map((session) => ({
            threadId: session.threadId,
            name: session.name,
            recencyAt: session.recencyAt,
            status: "stored",
            createdAt: beamTestNow - 60_000,
            updatedAt: session.recencyAt,
            archived: false,
            canContinue: false,
            canArchive: false,
          })),
        },
      ];
    },
    read: async ({ hostId, threadId }) => {
      await params.onRead?.(threadId);
      const items = typeof params.items === "function" ? params.items(threadId) : params.items;
      return {
        hostId,
        label: "Local",
        threadId,
        items: items ?? [
          { type: "agentMessage", text: "Done." },
          { type: "userMessage", text: "Fix the flow." },
        ],
        ...(params.nextCursor ? { nextCursor: params.nextCursor } : {}),
      };
    },
  };
}

type RunnerOptions = Parameters<typeof createBeamMirrorRunner>[0];
export function createBeamTestRunner({
  endpoint,
  ...options
}: Pick<RunnerOptions, "listCatalogs"> & Partial<RunnerOptions> & { endpoint?: string }) {
  return createBeamMirrorRunner({
    runtime: createBeamTestRuntime(beamTestMirrorConfig(endpoint ? { endpoint } : {})),
    logger: beamTestLogger,
    now: () => beamTestNow,
    ...options,
  });
}
