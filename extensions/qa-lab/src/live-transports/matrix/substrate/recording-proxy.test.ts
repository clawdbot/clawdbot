// Qa Lab Matrix tests cover redacted protocol recording and manifest derivation.
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startMatrixQaFaultProxy } from "./fault-proxy.js";
import { normalizeMatrixQaRoute } from "./recording-proxy-internals.js";
import { startMatrixQaRecordingProxy } from "./recording-proxy.js";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closeCallbacks.length > 0) {
    await closeCallbacks.pop()?.();
  }
});

async function startRecordingTarget(options?: { alwaysFailState?: boolean }) {
  let syncCount = 0;
  let stateCount = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://matrix.test");
    if (url.pathname.endsWith("/sync")) {
      syncCount += 1;
      const since = url.searchParams.get("since");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          account_data: {
            events: [
              {
                content: {
                  encrypted: {
                    SECRET_NESTED_STORAGE_KEY: { ciphertext: "secret-nested-ciphertext" },
                  },
                  unsigned: {
                    "secret-custom-field-name": "secret-custom-field-value",
                  },
                  url: "mxc://matrix.test/secret-media",
                  info: { mimetype: "image/png" },
                },
                type: "m.cross_signing.master",
              },
            ],
          },
          device_keys: {
            "@secret-user:matrix.test": {
              SECRET_DEVICE: {
                keys: {
                  "ed25519:SECRET_DEVICE": "secret-signing-key",
                },
              },
            },
          },
          device_one_time_keys_count: { signed_curve25519: 12 },
          device_unused_fallback_key_types: ["signed_curve25519"],
          next_batch: since === "echoed-unknown" ? since : `secret-sync-${syncCount}`,
          device_lists: { changed: ["secret-device"] },
          rooms: {
            join: {
              "!secret-room:matrix.test": {
                timeline: {
                  events: [
                    { type: "m.room.message" },
                    { sender: "@secret-sender:matrix.test", type: "m.room.encrypted" },
                  ],
                },
              },
            },
          },
        }),
      );
      return;
    }
    if (url.pathname.includes("/room_keys/keys")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          rooms: {
            "!secret-backup-room:matrix.test": {
              sessions: {
                "secret-backup-session": { first_message_index: 0 },
              },
            },
          },
        }),
      );
      return;
    }
    if (url.pathname.endsWith("/keys/upload")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ one_time_key_counts: {} }));
      return;
    }
    if (url.pathname.endsWith("/keys/query")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          failures: {
            "secret-server.example": { errcode: "M_UNAVAILABLE" },
          },
        }),
      );
      return;
    }
    if (url.pathname.includes("/account_data/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({}));
      return;
    }
    if (url.pathname.includes("/sendToDevice/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({}));
      return;
    }
    if (url.pathname.includes("/state/")) {
      stateCount += 1;
      const status = options?.alwaysFailState || stateCount === 1 ? 401 : 200;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(
        status === 401
          ? JSON.stringify({ errcode: "M_UNKNOWN_TOKEN", error: "secret-response" })
          : JSON.stringify({ name: "secret-state-name" }),
      );
      return;
    }
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ errcode: "M_UNKNOWN_TOKEN", error: "secret-response" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("recording target did not bind");
  }
  closeCallbacks.push(
    async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  return `http://127.0.0.1:${address.port}`;
}

describe("Matrix QA recording proxy", () => {
  it("records only redacted shapes and derives scenario expectations", async () => {
    const targetBaseUrl = await startRecordingTarget();
    const proxy = await startMatrixQaRecordingProxy({ targetBaseUrl });
    closeCallbacks.push(() => proxy.stop());
    proxy.setScenarioId("matrix-recording-test");

    const firstSync = await fetch(
      `${proxy.baseUrl}/_matrix/client/v3/sync?timeout=0&access_token=secret-query`,
      { headers: { authorization: "Bearer secret-header" } },
    );
    const firstBody = (await firstSync.json()) as { next_batch: string };
    await fetch(
      `${proxy.baseUrl}/_matrix/client/v3/sync?timeout=0&since=${encodeURIComponent(firstBody.next_batch)}`,
      { headers: { authorization: "Bearer secret-header" } },
    );
    const postState = async () => {
      await fetch(
        `${proxy.baseUrl}/_matrix/client/v3/rooms/!secret:matrix.test/state/m.room.name`,
        {
          body: JSON.stringify({ password: "secret-password", body: "secret-message" }),
          headers: {
            authorization: "Bearer secret-header",
            "content-type": "application/json",
          },
          method: "POST",
        },
      );
    };
    await postState();
    await fetch(`${proxy.baseUrl}/_matrix/client/v3/room_keys/keys`, {
      headers: {
        authorization: "Bearer secret-header",
      },
    });
    await fetch(`${proxy.baseUrl}/_matrix/client/v3/keys/upload`, {
      body: JSON.stringify({
        device_keys: {
          algorithms: ["m.olm.v1.curve25519-aes-sha2"],
          device_id: "SECRET_UPLOAD_DEVICE",
          keys: { "ed25519:SECRET_UPLOAD_DEVICE": "secret-upload-key" },
          user_id: "@secret-upload:matrix.test",
        },
        one_time_keys: {
          "signed_curve25519:SECRET_ONE_TIME": { key: "secret-one-time-key" },
        },
      }),
      headers: {
        authorization: "Bearer secret-header",
        "content-type": "application/json",
      },
      method: "POST",
    });
    await fetch(`${proxy.baseUrl}/_matrix/client/v3/keys/query`, {
      body: JSON.stringify({ device_keys: {} }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await fetch(
      `${proxy.baseUrl}/_matrix/client/v3/user/@secret-upload%3Amatrix.test/account_data/m.cross_signing.master`,
      {
        body: JSON.stringify({
          encrypted: {
            SECRET_STORAGE_KEY: { ciphertext: "secret-ciphertext" },
          },
        }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      },
    );
    await fetch(
      `${proxy.baseUrl}/_matrix/client/v3/user/@secret-upload%3Amatrix.test/account_data/m.megolm_backup.v1`,
      {
        body: JSON.stringify({ version: "1" }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      },
    );
    await fetch(`${proxy.baseUrl}/_matrix/client/v3/sendToDevice/m.room.encrypted/transaction-42`, {
      body: JSON.stringify({
        messages: {
          "@secret-recipient:matrix.test": {
            SECRET_RECIPIENT_DEVICE: { content: "secret-device-message" },
          },
        },
      }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    await postState();

    const records = proxy.records();
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("secret-query");
    expect(serialized).not.toContain("secret-header");
    expect(serialized).not.toContain("secret-password");
    expect(serialized).not.toContain("secret-message");
    expect(serialized).not.toContain("secret-sync");
    expect(serialized).not.toContain("secret-response");
    expect(serialized).not.toContain("secret-room");
    expect(serialized).not.toContain("secret-backup-room");
    expect(serialized).not.toContain("secret-backup-session");
    expect(serialized).not.toContain("secret-state-name");
    expect(serialized).not.toContain("secret-user");
    expect(serialized).not.toContain("SECRET_DEVICE");
    expect(serialized).not.toContain("SECRET_UPLOAD_DEVICE");
    expect(serialized).not.toContain("SECRET_ONE_TIME");
    expect(serialized).not.toContain("SECRET_RECIPIENT_DEVICE");
    expect(serialized).not.toContain("secret-server.example");
    expect(serialized).not.toContain("SECRET_STORAGE_KEY");
    expect(serialized).not.toContain("SECRET_NESTED_STORAGE_KEY");
    expect(serialized).not.toContain("secret-custom-field-name");
    const keyUpload = records.find((record) => record.request.route.endsWith("/keys/upload"));
    expect(keyUpload?.request.body).toEqual({
      kind: "json",
      fields: [
        "device_keys.algorithms",
        "device_keys.device_id",
        "device_keys.keys.{keyId}",
        "device_keys.user_id",
        "one_time_keys.{keyId}.key",
      ],
    });
    const sendToDevice = records.find((record) => record.request.route.includes("sendToDevice"));
    expect(sendToDevice?.request.body).toEqual({
      kind: "json",
      fields: ["messages.{userId}.{deviceId}.content"],
    });
    const keyQuery = records.find((record) => record.request.route.endsWith("/keys/query"));
    expect(keyQuery?.response.body).toEqual({
      kind: "json",
      fields: ["failures.{serverName}.errcode"],
    });
    const secretStorage = records.find((record) =>
      record.request.route.endsWith("/account_data/m.cross_signing.master"),
    );
    expect(secretStorage?.request.body).toEqual({
      kind: "json",
      fields: ["encrypted.{keyId}.ciphertext"],
    });
    expect(records[1]?.sync).toMatchObject({ continuity: true, since: "sync-1" });

    const manifest = proxy.buildManifest({
      generatedAt: "2026-07-03T00:00:00.000Z",
      requestedProfile: "all",
      scenarioIds: ["matrix-recording-test"],
      substrate: { id: "tuwunel", version: "v1.5.1" },
    });
    const expectation = manifest.scenarios["matrix-recording-test"];
    expect(manifest.profile).toEqual({
      derivedFrom: "observed-request-response-traffic",
      id: "matrix-qa-v1",
    });
    expect(expectation?.syncTokens).toEqual({
      continuityObserved: true,
      incrementalRequests: 1,
      initialRequests: 1,
      responseTokens: 2,
    });
    expect(expectation?.state.device).toEqual([
      "/_matrix/client/v3/keys/upload",
      "/_matrix/client/v3/sync",
    ]);
    expect(expectation?.state.key).toContain(
      "/_matrix/client/v3/user/{userId}/account_data/m.cross_signing.master",
    );
    expect(expectation?.state.key).toContain("/_matrix/client/v3/sync");
    expect(expectation?.state.backup).toContain(
      "/_matrix/client/v3/user/{userId}/account_data/m.megolm_backup.v1",
    );
    expect(expectation?.state.media).toContain("/_matrix/client/v3/sync");
    expect(expectation?.ordering[0]).toMatchObject({
      requestBody: { kind: "empty" },
      responseBody: {
        kind: "json",
        fields: expect.arrayContaining([
          "rooms.join.{roomId}.timeline.events[].sender",
          "rooms.join.{roomId}.timeline.events[].type",
        ]),
      },
    });
    expect(expectation?.retries).toEqual([]);
    expect(expectation?.errors).toEqual([
      {
        errcode: "M_UNKNOWN_TOKEN",
        method: "POST",
        route: "/_matrix/client/v3/rooms/{roomId}/state/m.room.name",
        status: 401,
      },
    ]);
  });

  it("normalizes substrate-specific Matrix identifiers from routes", () => {
    expect(
      normalizeMatrixQaRoute(
        "/_matrix/client/v3/rooms/!room%3Amatrix.test/send/m.room.message/txn-123",
      ),
    ).toBe("/_matrix/client/v3/rooms/{roomId}/send/m.room.message/{transactionId}");
    expect(
      normalizeMatrixQaRoute(
        "/_matrix/client/v3/rooms/!room%3Amatrix.test/redact/$event%3Amatrix.test/txn-123",
      ),
    ).toBe("/_matrix/client/v3/rooms/{roomId}/redact/{eventId}/{transactionId}");
    expect(normalizeMatrixQaRoute("/_matrix/media/v3/download/matrix.test/secret-media-id")).toBe(
      "/_matrix/media/v3/download/{serverName}/{mediaId}",
    );
    expect(
      normalizeMatrixQaRoute(
        "/_matrix/media/v3/download/matrix.test/secret-media-id/private-report.pdf",
      ),
    ).toBe("/_matrix/media/v3/download/{serverName}/{mediaId}/{filename}");
    expect(
      normalizeMatrixQaRoute("/_matrix/client/v1/media/thumbnail/matrix.test/secret-media-id"),
    ).toBe("/_matrix/client/v1/media/thumbnail/{serverName}/{mediaId}");
    expect(
      normalizeMatrixQaRoute("/_matrix/client/v3/user/@alice%3Amatrix.test/filter/filter-42"),
    ).toBe("/_matrix/client/v3/user/{userId}/filter/{filterId}");
    expect(
      normalizeMatrixQaRoute(
        "/_matrix/client/v3/user/@alice%3Amatrix.test/account_data/m.secret_storage.key.secret-key-id",
      ),
    ).toBe("/_matrix/client/v3/user/{userId}/account_data/m.secret_storage.key.{keyId}");
    expect(
      normalizeMatrixQaRoute("/_matrix/client/v3/room_keys/keys/!room%3Amatrix.test/session-42"),
    ).toBe("/_matrix/client/v3/room_keys/keys/{roomId}/{sessionId}");
  });

  it("records the response observed after scenario-local fault injection", async () => {
    const targetBaseUrl = await startRecordingTarget();
    const recording = await startMatrixQaRecordingProxy({ targetBaseUrl });
    closeCallbacks.push(() => recording.stop());
    recording.setScenarioId("matrix-fault-recording-test");
    const faultProxy = await startMatrixQaFaultProxy({
      targetBaseUrl,
      ...recording,
      rules: [
        {
          id: "backup-unavailable",
          match: (request) => request.path.endsWith("/room_keys/version"),
          response: () => ({
            body: { errcode: "M_NOT_FOUND", error: "secret-fault-message" },
            status: 404,
          }),
        },
      ],
    });
    closeCallbacks.push(() => faultProxy.stop());

    await fetch(`${faultProxy.baseUrl}/_matrix/client/v3/room_keys/version`);

    const record = recording
      .records()
      .find((entry) => entry.scenarioId === "matrix-fault-recording-test");
    expect(record?.response).toMatchObject({ errcode: "M_NOT_FOUND", status: 404 });
    expect(JSON.stringify(record)).not.toContain("secret-fault-message");
  });

  it("records proxy-generated upstream failures", async () => {
    const recording = await startMatrixQaRecordingProxy({
      targetBaseUrl: "http://127.0.0.1:1",
    });
    closeCallbacks.push(() => recording.stop());
    recording.setScenarioId("matrix-upstream-failure-test");

    const response = await fetch(`${recording.baseUrl}/_matrix/client/v3/sync?timeout=0`);

    expect(response.status).toBe(502);
    expect(recording.records().at(-1)?.response).toMatchObject({
      errcode: "MATRIX_QA_FAULT_PROXY_ERROR",
      status: 502,
    });
  });

  it("redacts signature upload device and cross-signing key identifiers", async () => {
    const targetBaseUrl = await startRecordingTarget();
    const recording = await startMatrixQaRecordingProxy({ targetBaseUrl });
    closeCallbacks.push(() => recording.stop());
    recording.setScenarioId("matrix-signatures-recording-test");

    await fetch(`${recording.baseUrl}/_matrix/client/v3/keys/signatures/upload`, {
      body: JSON.stringify({
        "@secret-signing-user:matrix.test": {
          SECRET_CROSS_SIGNING_KEY: { signatures: {} },
        },
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    const record = recording.records().at(-1);
    expect(record?.request.body).toEqual({
      kind: "json",
      fields: ["{userId}.{deviceOrKeyId}.signatures"],
    });
    expect(JSON.stringify(record)).not.toContain("secret-signing-user");
    expect(JSON.stringify(record)).not.toContain("SECRET_CROSS_SIGNING_KEY");
  });

  it("reports sync continuity only when every incremental token is recognized", async () => {
    const targetBaseUrl = await startRecordingTarget();
    const recording = await startMatrixQaRecordingProxy({ targetBaseUrl });
    closeCallbacks.push(() => recording.stop());
    recording.setScenarioId("matrix-sync-discontinuity-test");

    await fetch(`${recording.baseUrl}/_matrix/client/v3/sync?timeout=0&since=unknown-token`);

    const manifest = recording.buildManifest({
      requestedProfile: "test",
      scenarioIds: ["matrix-sync-discontinuity-test"],
      substrate: { id: "tuwunel", version: "test" },
    });
    expect(manifest.scenarios["matrix-sync-discontinuity-test"]?.syncTokens).toMatchObject({
      continuityObserved: false,
      incrementalRequests: 1,
    });
  });

  it("does not learn an unknown request token from the same sync response", async () => {
    const targetBaseUrl = await startRecordingTarget();
    const recording = await startMatrixQaRecordingProxy({ targetBaseUrl });
    closeCallbacks.push(() => recording.stop());
    recording.setScenarioId("matrix-echoed-sync-token-test");

    await fetch(`${recording.baseUrl}/_matrix/client/v3/sync?timeout=0&since=echoed-unknown`);

    expect(recording.records().at(-1)?.sync).toMatchObject({
      continuity: false,
      since: "sync-unknown",
    });
    expect(recording.records().at(-1)?.request.query).toMatchObject({
      since: "sync-unknown",
    });
  });

  it("does not conflate distinct same-shape operations as retries", async () => {
    const targetBaseUrl = await startRecordingTarget();
    const recording = await startMatrixQaRecordingProxy({ targetBaseUrl });
    closeCallbacks.push(() => recording.stop());
    recording.setScenarioId("matrix-distinct-operation-test");

    await fetch(
      `${recording.baseUrl}/_matrix/client/v3/rooms/!first:matrix.test/state/m.room.name`,
      {
        body: JSON.stringify({ name: "first" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    await fetch(
      `${recording.baseUrl}/_matrix/client/v3/rooms/!second:matrix.test/state/m.room.name`,
      {
        body: JSON.stringify({ name: "second" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );

    const manifest = recording.buildManifest({
      requestedProfile: "test",
      scenarioIds: ["matrix-distinct-operation-test"],
      substrate: { id: "tuwunel", version: "test" },
    });
    expect(manifest.scenarios["matrix-distinct-operation-test"]?.retries).toEqual([]);
  });

  it("does not conflate identical operations from different principals", async () => {
    const targetBaseUrl = await startRecordingTarget();
    const recording = await startMatrixQaRecordingProxy({ targetBaseUrl });
    closeCallbacks.push(() => recording.stop());
    recording.setScenarioId("matrix-principal-retry-test");
    const endpoint = `${recording.baseUrl}/_matrix/client/v3/rooms/!same:matrix.test/state/m.room.name`;

    await fetch(endpoint, {
      body: JSON.stringify({ name: "same" }),
      headers: { authorization: "Bearer first", "content-type": "application/json" },
      method: "POST",
    });
    await fetch(endpoint, {
      body: JSON.stringify({ name: "same" }),
      headers: { authorization: "Bearer second", "content-type": "application/json" },
      method: "POST",
    });

    const manifest = recording.buildManifest({
      requestedProfile: "test",
      scenarioIds: ["matrix-principal-retry-test"],
      substrate: { id: "tuwunel", version: "test" },
    });
    expect(manifest.scenarios["matrix-principal-retry-test"]?.retries).toEqual([]);
  });

  it("attributes sync completion to the active scenario", async () => {
    const targetBaseUrl = await startRecordingTarget();
    const recording = await startMatrixQaRecordingProxy({ targetBaseUrl });
    closeCallbacks.push(() => recording.stop());
    recording.setScenarioId("previous-scenario");
    const context = recording.createExchangeContext?.({
      body: Buffer.alloc(0),
      headers: {},
      method: "GET",
      path: "/_matrix/client/v3/sync",
      search: "?timeout=0",
    });
    recording.setScenarioId("active-scenario");
    await recording.onExchange?.({
      context,
      request: {
        body: Buffer.alloc(0),
        headers: {},
        method: "GET",
        path: "/_matrix/client/v3/sync",
        search: "?timeout=0",
      },
      response: {
        body: Buffer.from(JSON.stringify({ next_batch: "sync-complete" })),
        headers: new Headers({ "content-type": "application/json" }),
        status: 200,
      },
    });

    expect(recording.records().at(-1)?.scenarioId).toBe("active-scenario");
  });

  it("does not share sync-token continuity across principals", async () => {
    const targetBaseUrl = await startRecordingTarget();
    const recording = await startMatrixQaRecordingProxy({ targetBaseUrl });
    closeCallbacks.push(() => recording.stop());
    recording.setScenarioId("matrix-principal-sync-test");
    const exchange = async (bearerToken: string, search: string, nextBatch: string) => {
      const request = {
        bearerToken,
        body: Buffer.alloc(0),
        headers: {},
        method: "GET",
        path: "/_matrix/client/v3/sync",
        search,
      };
      await recording.onExchange?.({
        context: recording.createExchangeContext?.(request),
        request,
        response: {
          body: Buffer.from(JSON.stringify({ next_batch: nextBatch })),
          headers: new Headers({ "content-type": "application/json" }),
          status: 200,
        },
      });
    };

    await exchange("first", "?timeout=0", "shared-token");
    await exchange("second", "?timeout=0&since=shared-token", "second-token");

    expect(recording.records().at(-1)?.sync).toMatchObject({
      continuity: false,
      since: "sync-unknown",
    });
  });

  it("ends a retry chain at the first successful recovery", async () => {
    const targetBaseUrl = await startRecordingTarget();
    const recording = await startMatrixQaRecordingProxy({ targetBaseUrl });
    closeCallbacks.push(() => recording.stop());
    recording.setScenarioId("matrix-retry-boundary-test");
    const endpoint = `${recording.baseUrl}/_matrix/client/v3/rooms/!same:matrix.test/state/m.room.name`;
    const request = () =>
      fetch(endpoint, {
        body: JSON.stringify({ name: "same" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

    await request();
    await request();
    await request();

    const manifest = recording.buildManifest({
      requestedProfile: "test",
      scenarioIds: ["matrix-retry-boundary-test"],
      substrate: { id: "tuwunel", version: "test" },
    });
    expect(manifest.scenarios["matrix-retry-boundary-test"]?.retries).toEqual([
      expect.objectContaining({ attempts: 2, statuses: [401, 200] }),
    ]);
  });

  it("records exhausted retry chains without recovery", async () => {
    const targetBaseUrl = await startRecordingTarget({ alwaysFailState: true });
    const recording = await startMatrixQaRecordingProxy({ targetBaseUrl });
    closeCallbacks.push(() => recording.stop());
    recording.setScenarioId("matrix-exhausted-retry-test");
    const endpoint = `${recording.baseUrl}/_matrix/client/v3/rooms/!exhausted:matrix.test/state/m.room.name`;

    await fetch(endpoint, { method: "POST" });
    await fetch(endpoint, { method: "POST" });

    const manifest = recording.buildManifest({
      requestedProfile: "test",
      scenarioIds: ["matrix-exhausted-retry-test"],
      substrate: { id: "tuwunel", version: "test" },
    });
    expect(manifest.scenarios["matrix-exhausted-retry-test"]?.retries).toEqual([
      expect.objectContaining({ attempts: 2, statuses: [401, 401] }),
    ]);
  });

  it("does not infer retries across intervening operations", async () => {
    const targetBaseUrl = await startRecordingTarget();
    const recording = await startMatrixQaRecordingProxy({ targetBaseUrl });
    closeCallbacks.push(() => recording.stop());
    recording.setScenarioId("matrix-independent-operation-test");
    const stateEndpoint = `${recording.baseUrl}/_matrix/client/v3/rooms/!same:matrix.test/state/m.room.name`;

    await fetch(stateEndpoint, { method: "POST" });
    await fetch(`${recording.baseUrl}/_matrix/client/versions`);
    await fetch(stateEndpoint, { method: "POST" });

    const manifest = recording.buildManifest({
      requestedProfile: "test",
      scenarioIds: ["matrix-independent-operation-test"],
      substrate: { id: "tuwunel", version: "test" },
    });
    expect(manifest.scenarios["matrix-independent-operation-test"]?.retries).toEqual([]);
  });

  it("records repeated retry chains for the same operation", async () => {
    let requestCount = 0;
    const server = createServer((_req, res) => {
      requestCount += 1;
      const status = requestCount % 2 === 1 ? 503 : 200;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(status === 200 ? {} : { errcode: "M_UNAVAILABLE" }));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    closeCallbacks.push(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        }),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("retry target did not bind");
    }
    const recording = await startMatrixQaRecordingProxy({
      targetBaseUrl: `http://127.0.0.1:${address.port}`,
    });
    closeCallbacks.push(() => recording.stop());
    recording.setScenarioId("matrix-repeated-retry-test");
    const endpoint = `${recording.baseUrl}/_matrix/client/v3/rooms/!same:matrix.test/state/m.room.name`;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await fetch(endpoint, { method: "POST" });
    }

    const manifest = recording.buildManifest({
      requestedProfile: "test",
      scenarioIds: ["matrix-repeated-retry-test"],
      substrate: { id: "tuwunel", version: "test" },
    });
    expect(manifest.scenarios["matrix-repeated-retry-test"]?.retries).toEqual([
      expect.objectContaining({ attempts: 2, statuses: [503, 200] }),
      expect.objectContaining({ attempts: 2, statuses: [503, 200] }),
    ]);
  });
});
