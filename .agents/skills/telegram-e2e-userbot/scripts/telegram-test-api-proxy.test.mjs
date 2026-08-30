import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { startTelegramTestApiProxy, telegramTestApiPath } from "./telegram-test-api-proxy.mjs";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

test("inserts the Test Server segment after the bot token", () => {
  assert.equal(telegramTestApiPath("/bot123:ABC/getUpdates"), "/bot123:ABC/test/getUpdates");
  assert.equal(
    telegramTestApiPath("/file/bot123:ABC/photos/file.jpg"),
    "/file/bot123:ABC/test/photos/file.jpg",
  );
  assert.throws(() => telegramTestApiPath("/healthz"), /invalid Bot API path/u);
});

test("proxies method, query, headers, and body to the Test Server path", async () => {
  let observed;
  const upstreamServer = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      observed = {
        method: request.method,
        url: request.url,
        body,
        marker: request.headers["x-marker"],
      };
      response.writeHead(201, { "content-type": "application/json", "x-upstream": "yes" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  const upstream = await listen(upstreamServer);
  const proxy = await startTelegramTestApiProxy({ upstream });
  const response = await fetch(`${proxy.apiRoot}/bot123:ABC/sendMessage?chat_id=42`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-marker": "kept" },
    body: JSON.stringify({ text: "hello" }),
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("x-upstream"), "yes");
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(observed, {
    method: "POST",
    url: "/bot123:ABC/test/sendMessage?chat_id=42",
    body: '{"text":"hello"}',
    marker: "kept",
  });
  await proxy.close();
  await new Promise((resolve) => upstreamServer.close(resolve));
});

test("drains every pending Test Server update", async () => {
  const offsets = [];
  const upstreamServer = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      offsets.push(JSON.parse(body).offset);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ ok: true, result: offsets.length === 1 ? [{ update_id: 7 }] : [] }),
      );
    });
  });
  const upstream = await listen(upstreamServer);
  const proxy = await startTelegramTestApiProxy({ upstream });

  await proxy.drainUpdates("123:ABC");

  assert.deepEqual(offsets, [0, 8]);
  await proxy.close();
  await new Promise((resolve) => upstreamServer.close(resolve));
});

test("holds one upstream-accepted method response until explicit release", async () => {
  const upstreamServer = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  const upstream = await listen(upstreamServer);
  const proxy = await startTelegramTestApiProxy({ upstream });
  proxy.holdNextResponse({ method: "sendMessage", skip: 1 });
  await fetch(`${proxy.apiRoot}/bot123:ABC/sendMessage`, { method: "POST", body: "first" });
  let bodySettled = false;
  const heldBody = fetch(`${proxy.apiRoot}/bot123:ABC/sendMessage`, {
    method: "POST",
    body: "second",
  })
    .then((response) => response.json())
    .then((body) => {
      bodySettled = true;
      return body;
    });
  const held = await proxy.waitForHeldResponse("sendMessage", 1_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bodySettled, false);
  assert.deepEqual(
    { method: held.method, ordinal: held.ordinal },
    { method: "sendMessage", ordinal: 2 },
  );
  proxy.releaseHeldResponse();
  assert.deepEqual(await heldBody, { ok: true });
  assert.equal(proxy.getResponseHoldEvents()[0].releasedAt >= held.heldAt, true);
  await proxy.close();
  await new Promise((resolve) => upstreamServer.close(resolve));
});

test("proxy close aborts the in-flight Test Server request", async () => {
  let upstreamStarted;
  let upstreamAborted = false;
  const started = new Promise((resolve) => {
    upstreamStarted = resolve;
  });
  const proxy = await startTelegramTestApiProxy({
    fetchImpl: async (_url, init) => {
      upstreamStarted();
      return await new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => {
            upstreamAborted = true;
            reject(init.signal.reason);
          },
          { once: true },
        );
      });
    },
  });
  const request = fetch(`${proxy.apiRoot}/bot123:ABC/getUpdates`, {
    method: "POST",
    body: "{}",
  }).catch(() => undefined);
  await started;
  await proxy.close();
  await request;
  assert.equal(upstreamAborted, true);
});

test("lease revocation blocks every later Bot API request", async () => {
  const leaseError = new Error("lease revoked");
  let healthy = true;
  let revoke;
  let upstreamRequests = 0;
  const whenUnhealthy = new Promise((resolve) => {
    revoke = () => {
      healthy = false;
      resolve(leaseError);
    };
  });
  const proxy = await startTelegramTestApiProxy({
    leaseHealth: {
      assertHealthy: () => {
        if (!healthy) throw leaseError;
      },
      whenUnhealthy,
    },
    fetchImpl: async () => {
      upstreamRequests += 1;
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const before = await fetch(`${proxy.apiRoot}/bot123:ABC/getMe`);
  assert.equal(before.status, 200);
  revoke();
  await new Promise((resolve) => setImmediate(resolve));
  const after = await fetch(`${proxy.apiRoot}/bot123:ABC/sendMessage`, {
    method: "POST",
    body: "{}",
  });
  assert.equal(after.status, 502);
  assert.equal(upstreamRequests, 1);
  await proxy.close();
});
