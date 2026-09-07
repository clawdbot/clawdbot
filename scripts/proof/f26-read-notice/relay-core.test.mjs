import assert from "node:assert/strict";
import test from "node:test";
import { ReadCase } from "./relay-core.mjs";

const request = {
  type: "req",
  id: "read-a",
  method: "chat.metadata",
  params: { sessionKey: "agent:main:main" },
};
const response = { type: "res", id: request.id, ok: true, payload: { models: [] } };
function armed(mode = "reject") {
  const state = new ReadCase(
    {
      label: "case-a",
      mode,
      connection: 2,
      sessionKey: request.params.sessionKey,
      trigger: "publication",
    },
    0,
  );
  state.publish(10);
  return state;
}

test("only a later publication on the selected socket opens capture", () => {
  const state = armed();
  assert.equal(state.event(1, { event: "chat.metadata.changed" }, 11), false);
  assert.equal(state.event(2, { event: "chat.metadata.changed" }, 9), false);
  assert.equal(state.request(2, request, 12, 1), false);
  assert.equal(state.event(2, { event: "chat.metadata.changed" }, 13), true);
  assert.equal(state.request(2, { ...request, params: { agentId: "main" } }, 14, 2), false);
  assert.equal(state.request(2, request, 12, 2), false);
  assert.equal(state.request(2, request, 14, 2), true);
  assert.equal(state.response(1, response, 3), "unrelated");
  assert.equal(state.response(2, { ...response, id: "other" }, 3), "unrelated");
  assert.equal(state.response(2, response, 3), "reject");
  assert.equal(state.terminal, false);
  state.written();
  assert.equal(state.terminal, true);
});

test("a held error requires a later other-session reply on the same connection", () => {
  const state = armed("hold-reject");
  state.event(2, { event: "chat.metadata.changed" }, 11);
  state.request(2, request, 12, 1);
  assert.equal(state.response(2, response, 2), "hold-reject");
  assert.throws(() =>
    state.release({ connection: 3, sessionKey: "agent:main:other", requestSequence: 20 }, 3),
  );
  assert.throws(() =>
    state.release({ connection: 2, sessionKey: request.params.sessionKey, requestSequence: 20 }, 3),
  );
  assert.throws(() =>
    state.release({ connection: 2, sessionKey: "agent:main:other", requestSequence: 11 }, 3),
  );
  state.release({ connection: 2, sessionKey: "agent:main:other", requestSequence: 20 }, 3);
  state.written();
});

test("expiry and original failure cannot be upgraded to a delivered injected rejection", () => {
  const state = armed();
  state.event(2, { event: "chat.metadata.changed" }, 11);
  state.request(2, request, 12, 1);
  assert.throws(() => state.response(2, response, 12001));
  assert.equal(state.response(2, { ...response, ok: false }, 3), "upstream-error");
  assert.throws(() => state.written());
});

test("manual Refresh is explicit and does not masquerade as publication proof", () => {
  const state = new ReadCase(
    {
      label: "refresh",
      mode: "pass",
      connection: 2,
      sessionKey: request.params.sessionKey,
      trigger: "refresh",
    },
    0,
  );
  assert.throws(() => state.publish(1));
  assert.equal(state.request(2, request, 1, 1), true);
  assert.equal(state.response(2, response, 2), "pass");
  assert.equal(state.publicationSequence, undefined);
});
