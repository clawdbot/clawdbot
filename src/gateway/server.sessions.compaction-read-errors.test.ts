import { beforeEach, expect, test, vi } from "vitest";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { rpcReq } from "./test-helpers.js";
import {
  sessionStoreEntry,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

type LoadTranscriptEvents =
  (typeof import("../config/sessions/session-accessor.sqlite-read.js"))["loadTranscriptEvents"];

const transcriptReads = vi.hoisted(() => ({
  actual: undefined as LoadTranscriptEvents | undefined,
  load: vi.fn<LoadTranscriptEvents>(),
}));

vi.mock("../config/sessions/session-accessor.sqlite-read.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../config/sessions/session-accessor.sqlite-read.js")>();
  transcriptReads.actual = actual.loadTranscriptEvents;
  transcriptReads.load.mockImplementation(actual.loadTranscriptEvents);
  return { ...actual, loadTranscriptEvents: transcriptReads.load };
});

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

function requireTranscriptReader(): LoadTranscriptEvents {
  if (!transcriptReads.actual) {
    throw new Error("transcript reader mock was not initialized");
  }
  return transcriptReads.actual;
}

beforeEach(() => {
  transcriptReads.load.mockReset();
  transcriptReads.load.mockImplementation(requireTranscriptReader());
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

test("sessions.compact reports initial transcript read failures as unavailable", async () => {
  const { storePath } = await createSessionStoreDir();
  await seedCompactionSession({ sessionId: "sess-read-failure", storePath });
  transcriptReads.load.mockRejectedValueOnce(transcriptReadError());

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
  const events = await requireTranscriptReader()(scope);
  transcriptReads.load.mockResolvedValueOnce(events).mockRejectedValueOnce(transcriptReadError());

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
  transcriptReads.load.mockRejectedValueOnce(transcriptReadError());

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
