/* @vitest-environment jsdom */
import { expect } from "vitest";
import {
  createControlUiMockGatewayInitScript,
  type ControlUiMockGatewayScenario,
} from "./control-ui-e2e.ts";
import { mockGatewayTest } from "./mock-gateway-page.test-support.ts";

type Row = Record<string, unknown>;
type Frame = { type: string; id: string; ok: boolean; payload: Row; error?: Row };
type Controls = {
  deferNext: (method: string) => void;
  resolveDeferred: (method: string, payload?: unknown) => void;
  rejectDeferred: (method: string) => void;
  setMethodResponse: (method: string, payload: unknown) => void;
};
const flush = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
const notes = { key: "agent:ops:notes", sessionId: "notes-generation-1", label: "Notes" };

const it = mockGatewayTest.extend<{
  connect: (scenario?: ControlUiMockGatewayScenario) => Promise<{
    send: (method: string, params?: Row) => Promise<string>;
    response: (id: string) => Frame | undefined;
    request: (method: string, params?: Row) => Promise<Frame>;
    controls: Controls;
  }>;
}>({
  connect: async ({ gatewayPage }, use) => {
    await use(async (scenario = {}) => {
      const { window, execute } = gatewayPage;
      execute(createControlUiMockGatewayInitScript(scenario));
      const socket = new window.WebSocket("ws://mock-gateway");
      const frames: Frame[] = [];
      socket.addEventListener("message", (event: MessageEvent) => {
        frames.push(JSON.parse(String(event.data)) as Frame);
      });
      await flush();
      let sequence = 0;
      const send = async (method: string, params: Row = {}) => {
        const id = String(++sequence);
        socket.send(JSON.stringify({ type: "req", id, method, params }));
        await flush();
        return id;
      };
      const response = (id: string) =>
        frames.find((frame) => frame.type === "res" && frame.id === id);
      const controls = (
        window as typeof window & {
          openclawControlUiE2eGateway: Controls;
        }
      ).openclawControlUiE2eGateway;
      return {
        send,
        response,
        controls,
        request: async (method, params) => {
          const frame = response(await send(method, params));
          if (!frame) {
            throw new Error(`Missing response for ${method}`);
          }
          return frame;
        },
      };
    });
  },
});

it.for([
  { defaultAgentId: "main", sessionKey: "agent:main:notes", expected: "agent:main:main" },
  { defaultAgentId: "ops", sessionKey: notes.key, expected: "agent:ops:main" },
  { defaultAgentId: " Ops Team ", sessionKey: notes.key, expected: "agent:ops-team:main" },
  {
    defaultAgentId: "ops",
    sessionKey: notes.key,
    sessionScope: "global" as const,
    expected: "global",
  },
  {
    defaultAgentId: "ops",
    sessionKey: notes.key,
    mainSessionKey: "agent:ops:inbox",
    expected: "agent:ops:inbox",
  },
])(
  "advertises configured main independently of selected $sessionKey ($expected)",
  async ({ expected, ...scenario }, { connect }) => {
    const { request } = await connect(scenario);
    expect((await request("connect")).payload).toMatchObject({
      snapshot: {
        sessionDefaults: {
          mainSessionKey: expected,
          defaultAgentId: expected === "global" ? "ops" : expected.split(":")[1],
        },
      },
    });
  },
);

it.for(["rows", "static list"])(
  "serves per-key identity before listing (%s)",
  async (source, { connect }) => {
    const other = { key: "agent:ops:other", sessionId: "other-generation-2", pinnedAt: 100 };
    const pinned = { key: "agent:ops:pinned", sessionId: "pinned-generation", pinned: true };
    const archived = {
      key: "agent:ops:archived",
      sessionId: "archived-generation",
      archived: true,
    };
    const rows = [notes, other, pinned, archived];
    const expectedRows = [
      notes,
      { ...other, pinned: true },
      { ...pinned, pinnedAt: expect.any(Number) },
      { ...archived, archivedAt: expect.any(Number), pinned: false },
    ];
    const scenario = {
      defaultAgentId: "ops",
      sessionKey: notes.key,
      ...(source === "rows"
        ? { sessions: rows }
        : {
            methodResponses: { "sessions.list": { sessions: rows, count: rows.length } },
          }),
    };
    const { request } = await connect(scenario);
    for (const row of expectedRows) {
      for (const method of ["chat.history", "chat.startup"]) {
        expect((await request(method, { sessionKey: row.key })).payload).toMatchObject({
          sessionId: row.sessionId,
          sessionInfo: row,
        });
      }
      expect((await request("sessions.describe", { key: row.key })).payload).toMatchObject({
        session: row,
      });
    }
    expect((await request("sessions.list")).payload).toMatchObject({
      sessions: expectedRows,
    });
  },
);

it("returns a missing descriptor without materializing an unseeded session", async ({
  connect,
}) => {
  const { request } = await connect({
    defaultAgentId: "ops",
    sessionKey: notes.key,
    sessions: [notes],
  });
  const missingKey = "agent:ops:main";

  expect((await request("sessions.describe", { key: missingKey })).payload).toEqual({
    session: null,
  });
  expect((await request("sessions.list")).payload.sessions).toEqual([
    expect.objectContaining(notes),
  ]);
  expect((await request("chat.history", { sessionKey: missingKey })).payload).not.toHaveProperty(
    "sessionInfo",
  );
});

it.for(["cases", "sequence"])(
  "does not invent metadata for %s-only rows",
  async (kind, { connect }) => {
    const row = {
      key: notes.key,
      sessionId: `session:${notes.key}`,
      label: "Plan release",
      childSessions: [{ key: "child" }],
    };
    const list = { sessions: [row] };
    const { request } = await connect({
      sessionKey: notes.key,
      methodResponses: {
        "sessions.list":
          kind === "cases"
            ? { cases: [{ match: {}, response: list }] }
            : { sequence: [list, { sessions: [] }] },
      },
    });
    for (const method of ["chat.startup", "chat.history"]) {
      // A sessionInfo is a complete row replacement at the UI boundary, not a patch.
      expect((await request(method, { sessionKey: row.key })).payload).not.toHaveProperty(
        "sessionInfo",
      );
    }
    expect((await request("sessions.list")).payload.sessions).toEqual([row]);
    // Wire-only list responses do not declare a canonical stored row for describe.
    expect((await request("sessions.describe", { key: row.key })).payload.session).toBeNull();
  },
);

it("preserves absent stored labels and model overrides in canonical input", async ({ connect }) => {
  const row = { key: notes.key, displayName: "Account · generated title" };
  const { request } = await connect({ methodResponses: { "sessions.list": { sessions: [row] } } });
  const info = (await request("chat.startup", { sessionKey: row.key })).payload.sessionInfo;
  expect(info).not.toHaveProperty("label");
  expect(info).not.toHaveProperty("model");
  expect(info).not.toHaveProperty("hasActiveRun");
});

it("reports the same global scope in hello and agents.list", async ({ connect }) => {
  const { request } = await connect({ sessionScope: "global" });
  expect((await request("connect")).payload).toMatchObject({
    snapshot: { sessionDefaults: { scope: "global" } },
  });
  expect((await request("agents.list")).payload.scope).toBe("global");
  expect((await request("sessions.list")).payload.sessions).toEqual([
    expect.objectContaining({ key: "global", kind: "global" }),
  ]);
});

it("reports canonical bulk-pin rejection without committing the archived target", async ({
  connect,
}) => {
  const archived = { ...notes, archivedAt: 123 };
  const other = { key: "agent:ops:other" };
  const { request } = await connect({ sessions: [archived, other] });
  expect(
    (await request("sessions.patchMany", { targets: [notes, other], patch: { pinned: true } }))
      .payload,
  ).toMatchObject({
    outcomes: [
      { key: notes.key, ok: false, error: { code: "INVALID_REQUEST" } },
      { key: other.key, ok: true },
    ],
  });
  expect((await request("sessions.describe", { key: notes.key })).payload.session).toMatchObject({
    archivedAt: 123,
    pinned: false,
  });
});

it("keeps unrelated committed metadata when replacing one wire snapshot", async ({ connect }) => {
  const other = { key: "agent:ops:other", pinned: false };
  const { request, controls } = await connect({ sessions: [notes, other] });
  await request("sessions.patch", { key: notes.key, archived: true });
  await request("sessions.patch", { key: other.key, pinned: true });
  controls.setMethodResponse("sessions.list", { sessions: [{ ...notes, label: "Wire label" }] });
  controls.setMethodResponse("sessions.list", {
    cases: [{ match: {}, response: { sessions: [{ key: notes.key }, other] } }],
  });
  expect((await request("sessions.list")).payload.sessions).toEqual([
    expect.objectContaining({ key: notes.key, archived: true }),
    expect.objectContaining({ key: other.key, pinned: true }),
  ]);
});

it("preserves stale wire responses without consuming sequences or replacing canonical identity", async ({
  connect,
}) => {
  const stale = { ...notes, sessionId: "retired-generation", pinned: false };
  const firstList = { sessions: [stale], offset: 10 };
  const lastList = { sessions: [], offset: 20 };
  const transcript = { messages: [], sessionId: "retired-transcript", sessionInfo: stale };
  const { request, controls, send, response } = await connect({
    sessions: [notes],
    methodResponses: {
      "sessions.list": { sequence: [firstList, lastList] },
      "chat.history": {
        cases: [{ match: { sessionKey: notes.key, offset: 10 }, response: transcript }],
      },
    },
  });
  expect((await request("chat.history", { sessionKey: notes.key })).payload.sessionId).toBe(
    notes.sessionId,
  );
  expect((await request("chat.startup", { sessionKey: notes.key })).payload.sessionId).toBe(
    notes.sessionId,
  );
  expect((await request("sessions.list")).payload).toMatchObject(firstList);
  expect((await request("sessions.list")).payload).toEqual(lastList);
  expect((await request("sessions.list")).payload).toEqual(lastList);
  expect((await request("chat.history", { sessionKey: notes.key, offset: 10 })).payload).toEqual(
    transcript,
  );
  controls.deferNext("chat.startup");
  const id = await send("chat.startup", { sessionKey: notes.key });
  controls.resolveDeferred("chat.startup", transcript);
  expect(response(id)?.payload).toEqual(transcript);
  controls.setMethodResponse("chat.history", transcript);
  expect((await request("chat.history", { sessionKey: notes.key })).payload).toEqual(transcript);
  expect((await request("chat.startup", { sessionKey: notes.key })).payload).toMatchObject(
    transcript,
  );
  expect((await request("sessions.describe", { key: notes.key })).payload).toMatchObject({
    session: notes,
  });
});

it("keeps patch metadata and pin/archive timestamps coherent across reads", async ({ connect }) => {
  const scenario = { sessionKey: notes.key, sessions: [notes] };
  const { request } = await connect(scenario);
  const readRow = async () => {
    const { payload } = await request("sessions.list", { archived: "all" });
    const row = (payload.sessions as Row[]).find((candidate) => candidate.key === notes.key)!;
    for (const method of ["chat.history", "chat.startup"]) {
      expect((await request(method, { sessionKey: notes.key })).payload).toMatchObject({
        sessionId: row.sessionId,
        sessionInfo: row,
      });
    }
    expect((await request("sessions.describe", { key: notes.key })).payload).toMatchObject({
      session: row,
    });
    return row;
  };
  const patch = (fields: Row) => request("sessions.patch", { key: notes.key, ...fields });
  await patch({ color: "blue" });
  expect((await readRow()).color).toBe("blue");
  await patch({ color: null });
  expect((await readRow()).color).toBeNull();
  await patch({ pinned: true });
  const pinned = await readRow();
  expect(pinned).toMatchObject({ pinned: true, pinnedAt: expect.any(Number) });
  await patch({ pinned: true });
  expect((await readRow()).pinnedAt).toBe(pinned.pinnedAt);
  await patch({ archived: true });
  const archived = await readRow();
  expect(archived).toMatchObject({ archived: true, archivedAt: expect.any(Number), pinned: false });
  expect(archived).not.toHaveProperty("pinnedAt");
  await patch({ archived: true });
  expect((await readRow()).archivedAt).toBe(archived.archivedAt);
  expect(await patch({ pinned: true })).toMatchObject({ ok: false });
  expect(await readRow()).toEqual(archived);
  await patch({ archived: false, pinned: true });
  expect(await readRow()).toMatchObject({
    archived: false,
    pinned: true,
    pinnedAt: expect.any(Number),
  });
  await patch({ pinned: false });
  expect(await readRow()).not.toHaveProperty("pinnedAt");
});

it("does not commit rejected patches or unresolved deferrals", async ({ connect }) => {
  const { request, send, response, controls } = await connect({ sessionKey: notes.key });
  controls.setMethodResponse("sessions.patch", {
    __mockError: { code: "INVALID_REQUEST", message: "rejected" },
  });
  expect(await request("sessions.patch", { key: notes.key, pinned: true })).toMatchObject({
    ok: false,
  });
  expect((await request("sessions.list")).payload).toMatchObject({ sessions: [{ pinned: false }] });
  controls.setMethodResponse("sessions.patch", { ok: true });
  controls.deferNext("sessions.patch");
  const pending = await send("sessions.patch", { key: notes.key, pinned: true });
  expect(response(pending)).toBeUndefined();
  expect((await request("sessions.list")).payload).toMatchObject({ sessions: [{ pinned: false }] });
  controls.rejectDeferred("sessions.patch");
  expect((await request("sessions.list")).payload).toMatchObject({ sessions: [{ pinned: false }] });
  controls.deferNext("sessions.patch");
  await send("sessions.patch", { key: notes.key, pinned: true });
  controls.resolveDeferred("sessions.patch", { ok: true });
  expect((await request("sessions.list")).payload).toMatchObject({
    sessions: [{ pinned: true, pinnedAt: expect.any(Number) }],
  });
});

it("replays later commits onto an injected list without adopting its stale generation", async ({
  connect,
}) => {
  const { request, controls } = await connect({ sessions: [notes] });
  await request("sessions.patch", { key: notes.key, archived: true });
  const stale = { ...notes, archived: false, sessionId: "retired-generation" };
  controls.setMethodResponse("sessions.list", { sessions: [stale] });
  expect((await request("sessions.list")).payload.sessions).toEqual([
    expect.objectContaining(stale),
  ]);
  await request("sessions.patch", { key: notes.key, label: "Renamed" });
  expect((await request("sessions.list")).payload.sessions).toEqual([
    expect.objectContaining({ ...stale, label: "Renamed" }),
  ]);
  expect((await request("sessions.describe", { key: notes.key })).payload).toMatchObject({
    session: { sessionId: notes.sessionId, archived: true, label: "Renamed" },
  });
});

it("commits only successful patchMany targets", async ({ connect }) => {
  const other = { key: "agent:ops:other", sessionId: "other-generation" };
  const scenario = {
    sessionKey: notes.key,
    sessions: [notes, other],
    methodResponses: {
      "sessions.patchMany": {
        outcomes: [
          { key: notes.key, ok: true },
          { key: other.key, ok: false },
        ],
      },
    },
  };
  const { request } = await connect(scenario);
  await request("sessions.patchMany", {
    targets: [{ key: notes.key }, { key: other.key }],
    patch: { pinned: true },
  });
  expect((await request("sessions.list")).payload).toMatchObject({
    sessions: [
      { key: notes.key, pinned: true, pinnedAt: expect.any(Number) },
      { key: other.key, pinned: false },
    ],
  });
});

it.for(["sessions.create", "sessions.catalog.continue"])(
  "materializes %s identity for every read",
  async (method, { connect }) => {
    const key = "agent:main:created";
    const { request } = await connect({
      methodResponses: {
        [method]: { key, entry: { sessionId: "created-generation" }, runStarted: true },
      },
    });
    await request(method, { label: "Created" });
    for (const read of ["chat.history", "chat.startup"]) {
      expect((await request(read, { sessionKey: key })).payload).toMatchObject({
        sessionId: "created-generation",
        sessionInfo: { key, sessionId: "created-generation", label: "Created", hasActiveRun: true },
      });
    }
    expect((await request("sessions.describe", { key })).payload).toMatchObject({
      session: { key, sessionId: "created-generation" },
    });
    expect((await request("sessions.list")).payload.sessions).toEqual(
      expect.arrayContaining([expect.objectContaining({ key, sessionId: "created-generation" })]),
    );
  },
);

it.for([
  { sessionKey: "agent:ops:notes", sessionScope: "global" as const, kind: "direct" },
  { sessionKey: "global", sessionScope: "agent" as const, kind: "global" },
])(
  "derives selected row kind from its key under $sessionScope scope",
  async ({ kind, ...scenario }, { connect }) => {
    const { request } = await connect(scenario);
    expect((await request("sessions.list")).payload.sessions).toEqual([
      expect.objectContaining({ key: scenario.sessionKey, kind }),
    ]);
    expect(
      (await request("chat.history", { sessionKey: scenario.sessionKey })).payload.sessionInfo,
    ).toMatchObject({ key: scenario.sessionKey, kind });
  },
);
