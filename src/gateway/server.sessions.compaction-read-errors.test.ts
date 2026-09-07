import { beforeEach, expect, test, vi } from "vitest";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
// Force the mocked module to load here: the factory below captures the real reader as a
// side effect, and beforeEach needs that capture. Without this import the factory only ran
// if some other module in the graph pulled it in first, which is not guaranteed once a
// shard shares a worker (--isolate=false).
import "../config/sessions/session-accessor.sqlite-read.js";
import { rpcReq } from "./test-helpers.js";
import {
  sessionStoreEntry,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

vi.hoisted(() => {
  // Earlier Gateway suites may have already loaded the unmocked accessor graph.
  vi.resetModules();
});

type ReadTranscriptStatsSync =
  (typeof import("../config/sessions/session-accessor.sqlite-read.js"))["readTranscriptStatsSync"];

const transcriptReads = vi.hoisted(() => ({
  stats: vi.fn<ReadTranscriptStatsSync>(),
}));

vi.mock("../config/sessions/session-accessor.sqlite-read.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../config/sessions/session-accessor.sqlite-read.js")>();
  return {
    ...actual,
    readTranscriptStatsSync: transcriptReads.stats,
  };
});

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

// Read the real implementation back here rather than capturing it inside the mock
// factory: Vitest runs that factory on first import of the mocked module, and this
// project is `isolate: false`, so on a warm module graph the factory can still be
// unrun when the first `beforeEach` fires.
async function actualTranscriptStatsReader(): Promise<ReadTranscriptStatsSync> {
  const actual = await vi.importActual<
    typeof import("../config/sessions/session-accessor.sqlite-read.js")
  >("../config/sessions/session-accessor.sqlite-read.js");
  return actual.readTranscriptStatsSync;
}

let realTranscriptStatsReader: ReadTranscriptStatsSync;

beforeEach(async () => {
  transcriptReads.stats.mockReset();
  realTranscriptStatsReader = await actualTranscriptStatsReader();
  transcriptReads.stats.mockImplementation(realTranscriptStatsReader);
});

async function seedCompactionSession(params: {
  sessionId: string;
  storePath: string;
  nativeHarness?: boolean;
  withTranscript?: boolean;
}) {
  const scope = {
    agentId: "main",
    sessionId: params.sessionId,
    sessionKey: "agent:main:main",
    storePath: params.storePath,
  };
  await upsertSessionEntryCore(
    scope,
    sessionStoreEntry(
      params.sessionId,
      params.nativeHarness
        ? {
            agentHarnessId: "codex",
            cliSessionBindings: { "codex-cli": { sessionId: "thread-1" } },
            cliSessionIds: { "codex-cli": "thread-1" },
            modelSelectionLocked: true,
          }
        : {},
    ),
  );
  if (params.withTranscript === false) {
    return scope;
  }
  await appendTranscriptEvent(scope, {
    type: "session",
    version: 3,
    id: params.sessionId,
    timestamp: "2026-08-18T12:00:00.000Z",
    cwd: "/tmp",
  });
  await appendTranscriptMessage(scope, {
    message: { role: "user", content: "compact me", timestamp: 1 },
    now: Date.parse("2026-08-18T12:00:01.000Z"),
  });
  return scope;
}

const transcriptReadError = () =>
  new Error("SQLITE_IOERR: failed to read session transcript storage");

/**
 * Injects the read failure for one seeded session instead of the next global call.
 * `--isolate=false` shares a worker, so any sibling transcript read can consume a
 * `*Once` mock before the compaction RPC issues its own and the failure silently
 * disappears. Keying on sessionId makes the injection independent of call order.
 */
function failTranscriptStatsForSession(
  sessionId: string,
  options?: { succeedFirstWith: ReturnType<ReadTranscriptStatsSync> },
): void {
  let sessionReads = 0;
  transcriptReads.stats.mockImplementation((scope) => {
    if (scope.sessionId !== sessionId) {
      return realTranscriptStatsReader(scope);
    }
    sessionReads += 1;
    if (options && sessionReads === 1) {
      return options.succeedFirstWith;
    }
    throw transcriptReadError();
  });
}

test("sessions.compact reports initial transcript read failures as unavailable", async () => {
  const { storePath } = await createSessionStoreDir();
  await seedCompactionSession({ sessionId: "sess-read-failure", storePath });
  failTranscriptStatsForSession("sess-read-failure");

  const { ws } = await openClient();
  try {
    const response = await rpcReq(ws, "sessions.compact", { key: "main" });

    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({
      code: "UNAVAILABLE",
      message: expect.stringContaining("failed to read session transcript storage"),
    });
  } finally {
    ws.close();
  }
});

test("sessions.compact reports model compaction transcript re-read failures as unavailable", async () => {
  const { storePath } = await createSessionStoreDir();
  const scope = await seedCompactionSession({
    sessionId: "sess-model-read-failure",
    storePath,
    nativeHarness: true,
  });
  failTranscriptStatsForSession("sess-model-read-failure", {
    succeedFirstWith: realTranscriptStatsReader(scope),
  });

  const { ws } = await openClient();
  try {
    const response = await rpcReq(ws, "sessions.compact", { key: "main" });

    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({
      code: "UNAVAILABLE",
      message: expect.stringContaining("failed to read session transcript storage"),
    });
  } finally {
    ws.close();
  }
});

test("sessions.compact maxLines reports transcript preflight read failures as unavailable", async () => {
  const { storePath } = await createSessionStoreDir();
  await seedCompactionSession({ sessionId: "sess-max-lines-read-failure", storePath });
  failTranscriptStatsForSession("sess-max-lines-read-failure");

  const { ws } = await openClient();
  try {
    const response = await rpcReq(ws, "sessions.compact", { key: "main", maxLines: 50 });

    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({
      code: "UNAVAILABLE",
      message: expect.stringContaining("failed to read session transcript storage"),
    });
  } finally {
    ws.close();
  }
});

test.each([{ maxLines: undefined }, { maxLines: 50 }])(
  "sessions.compact keeps an empty transcript as a successful no-op (maxLines=$maxLines)",
  async ({ maxLines }) => {
    const { storePath } = await createSessionStoreDir();
    await seedCompactionSession({
      sessionId: `sess-empty-${maxLines ?? "model"}`,
      storePath,
      withTranscript: false,
    });

    const { ws } = await openClient();
    try {
      const response = await rpcReq<{ compacted: boolean; ok: true; reason: string }>(
        ws,
        "sessions.compact",
        { key: "main", ...(maxLines === undefined ? {} : { maxLines }) },
      );

      expect(response.ok).toBe(true);
      expect(response.payload).toMatchObject({
        ok: true,
        compacted: false,
        reason: "no transcript",
      });
    } finally {
      ws.close();
    }
  },
);
