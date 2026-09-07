import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

// Run only against a disposable backend created by CONVEX_AGENT_MODE=anonymous.
const config = JSON.parse(fs.readFileSync(".convex/local/default/config.json", "utf8"));
assert.ok(config.deploymentName.startsWith("anonymous-"));
const cloud = `http://127.0.0.1:${config.ports.cloud}`;
const site = `http://127.0.0.1:${config.ports.site}/qa-credentials/v1/`;
const maintainer = "synthetic-maintainer";
const ci = "synthetic-ci";
const client = new ConvexHttpClient(cloud);
client.setAdminAuth(config.adminKey);
const kind = "telegram-test-userbot";
const fixture = (archive = "dGVzdA==") => ({
  schemaVersion: 1,
  environment: "test",
  groupId: "-123",
  sutBotId: "123",
  testerUserId: "456",
  sutToken: "synthetic-token",
  sutUsername: "synthetic_bot",
  tdlibArchiveBase64: archive,
  tdlibArchiveSha256: createHash("sha256").update(Buffer.from(archive, "base64")).digest("hex"),
  tdlibVersion: "1.8.67",
  preservedExtra: { enabled: true, labels: ["one", "two"] },
});
const fingerprint = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const internal = (name, args) =>
  client.function(makeFunctionReference(`credentials:${name}`), undefined, args);
async function post(route, body, token = maintainer) {
  const response = await fetch(site + route, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: response.headers.get("content-type")?.includes("application/json")
      ? JSON.parse(text)
      : { message: text },
  };
}
async function snapshot() {
  const response = await fetch(cloud + "/api/run_test_function", {
    method: "POST",
    headers: { authorization: `Convex ${config.adminKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      adminKey: config.adminKey,
      args: {},
      format: "convex_encoded_json",
      bundle: {
        path: "testQuery.js",
        source:
          'import { query } from "convex:/_system/repl/wrappers.js"; export default query({handler: async ctx => ({rows: await ctx.db.query("credential_sets").collect(), chunks: await ctx.db.query("credential_payload_chunks").collect(), events: await ctx.db.query("admin_events").collect()})});',
      },
    }),
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  assert.equal(result.status, "success");
  return result.value;
}
const update = (credentialId, patch = {}) =>
  post("admin/telegram-fixtures", {
    credentialId,
    sutBotId: "123",
    testerUserId: "456",
    expectedGroupId: "-123",
    groupId: "-456",
    forumGroupId: "-100789",
    actorId: "synthetic-proof",
    ...patch,
  });
async function add(payload, options = {}) {
  const result = await internal("addCredentialSet", {
    kind,
    payload,
    note: "preserve this note",
    ...options,
  });
  assert.equal(result.status, "ok");
  return result.credential.credentialId;
}
async function acquire() {
  const identity = { kind, ownerId: "synthetic-consumer", actorRole: "ci" };
  const acquired = await post("acquire", identity, ci);
  assert.equal(acquired.body.status, "ok");
  const lease = {
    ...identity,
    credentialId: acquired.body.credentialId,
    leaseToken: acquired.body.leaseToken,
  };
  return { acquired: acquired.body, lease, release: () => post("release", lease, ci) };
}
async function consume({ acquired, lease }) {
  if (acquired.payload.__openclawQaCredentialPayloadChunksV1 !== true) return acquired.payload;
  const parts = [];
  for (let index = 0; index < acquired.payload.chunkCount; index++) {
    const part = await post("payload-chunk", { ...lease, index }, ci);
    assert.equal(part.body.status, "ok");
    parts.push(part.body.data);
  }
  const serialized = parts.join("");
  assert.equal(Buffer.byteLength(serialized), acquired.payload.byteLength);
  return JSON.parse(serialized);
}

test(
  "maintainer fixture updates preserve payloads and serialize with leases",
  { timeout: 90000 },
  async (t) => {
    const disabled = await add(fixture(Buffer.alloc(240000, 71).toString("base64")), {
      status: "disabled",
    });
    const other = await add({ preserved: "other kind" }, { kind: "synthetic-other" });
    const original = await snapshot();
    const untouched = (state) => ({
      rows: state.rows.filter((row) => [disabled, other].includes(row._id)),
      chunks: state.chunks.filter((row) => [disabled, other].includes(row.credentialId)),
    });
    for (const [label, payload] of [
      ["inline", fixture()],
      ["chunked", fixture(Buffer.alloc(240000, 65).toString("base64"))],
    ]) {
      await t.test(`${label} round trip, conflicts, no-op and preservation`, async () => {
        const id = await add(payload);
        try {
          const before = await snapshot();
          const rowBefore = before.rows.find((row) => row._id === id);
          const changed = await update(id);
          assert.equal(changed.status, 200);
          assert.equal(changed.body.status, "ok");
          assert.equal(changed.body.changed, true);
          assert.equal(changed.body.credential.credentialId, id);
          assert.equal("payload" in changed.body.credential, false);
          const after = await snapshot();
          const rowAfter = after.rows.find((row) => row._id === id);
          const preserved = ({ payload: _payload, updatedAtMs: _updated, ...rest }) => rest;
          assert.deepEqual(preserved(rowAfter), preserved(rowBefore));
          const listed = await post("admin/list", { kind, status: "active", includePayload: true });
          const expected = { ...payload, groupId: "-456", forumGroupId: "-100789" };
          assert.ok(
            isDeepStrictEqual(
              listed.body.credentials.find((row) => row.credentialId === id).payload,
              expected,
            ),
            "complete listed payload must be preserved",
          );
          assert.equal((await update(id)).body.code, "FIXTURE_CONFLICT");
          const noOp = await update(id, {
            expectedGroupId: "-456",
            expectedForumGroupId: "-100789",
          });
          assert.equal(noOp.body.changed, false);
          const afterNoOp = await snapshot();
          assert.deepEqual(afterNoOp.rows, after.rows);
          assert.equal(fingerprint(afterNoOp.chunks), fingerprint(after.chunks));
          const current = await acquire();
          try {
            assert.equal(current.acquired.credentialId, id);
            assert.ok(
              isDeepStrictEqual(await consume(current), expected),
              "complete leased payload must be preserved",
            );
            assert.equal((await post("heartbeat", current.lease, ci)).body.status, "ok");
            assert.equal(
              (await update(id, { expectedGroupId: "-456", expectedForumGroupId: "-100789" })).body
                .code,
              "LEASE_ACTIVE",
            );
          } finally {
            assert.equal((await current.release()).body.status, "ok");
          }
        } finally {
          assert.equal((await post("admin/remove", { credentialId: id })).body.status, "ok");
        }
      });
    }
    await t.test(
      "rejects unauthorized, invalid and mismatched requests without data changes",
      async () => {
        const id = await add(fixture());
        const before = await snapshot();
        const request = {
          credentialId: id,
          sutBotId: "123",
          testerUserId: "456",
          expectedGroupId: "-123",
          groupId: "-456",
          forumGroupId: "-100789",
        };
        for (const [token, status] of [
          [undefined, 401],
          ["wrong-secret", 401],
          [ci, 403],
        ]) {
          assert.equal(
            (await post("admin/telegram-fixtures", request, token ?? "")).status,
            status,
          );
        }
        for (const patch of [
          { groupId: "0" },
          { groupId: "123" },
          { forumGroupId: "not-an-id" },
          { forumGroupId: "-456" },
        ]) {
          assert.equal((await update(id, patch)).status, 400);
        }
        assert.equal((await update(id, { sutBotId: "999" })).body.code, "IDENTITY_MISMATCH");
        assert.equal((await update(id, { testerUserId: "999" })).body.code, "IDENTITY_MISMATCH");
        assert.equal((await update(disabled)).body.code, "CREDENTIAL_DISABLED");
        assert.equal((await update(other)).body.code, "KIND_MISMATCH");
        const after = await snapshot();
        assert.deepEqual(after.rows, before.rows);
        assert.equal(fingerprint(after.chunks), fingerprint(before.chunks));
        assert.equal((await post("admin/remove", { credentialId: id })).body.status, "ok");
        const nonTest = await add({ ...fixture(), environment: "production" });
        assert.equal((await update(nonTest)).body.code, "INVALID_PAYLOAD");
        assert.equal((await post("admin/remove", { credentialId: nonTest })).body.status, "ok");
      },
    );
    await t.test(
      "concurrent acquisition sees one complete payload or prevents the update",
      async () => {
        const payload = fixture(Buffer.alloc(240000, 66).toString("base64"));
        const id = await add(payload);
        const [changed, current] = await Promise.all([update(id), acquire()]);
        try {
          assert.equal(current.acquired.credentialId, id);
          if (changed.body.status === "ok") {
            assert.ok(
              isDeepStrictEqual(await consume(current), {
                ...payload,
                groupId: "-456",
                forumGroupId: "-100789",
              }),
              "acquisition must see the complete updated payload",
            );
          } else {
            assert.equal(changed.body.code, "LEASE_ACTIVE");
            assert.ok(
              isDeepStrictEqual(await consume(current), payload),
              "a rejected update must preserve the complete original payload",
            );
          }
        } finally {
          assert.equal((await current.release()).body.status, "ok");
        }
      },
    );
    const final = await snapshot();
    assert.equal(fingerprint(untouched(final)), fingerprint(untouched(original)));
    assert.equal(
      final.rows.some((row) => row.lease),
      false,
    );
    const updates = final.events.filter((event) => event.eventType === "telegram_fixtures_update");
    assert.ok(updates.length >= 2);
    assert.equal(JSON.stringify(updates).includes("synthetic-token"), false);
  },
);
