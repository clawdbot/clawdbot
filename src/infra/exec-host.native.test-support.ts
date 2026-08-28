// Launched only by ExecHostTransportProofTests in a fresh, process-isolated state root.
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { requestExecHostViaSocket, type ExecHostRequest } from "./exec-host.js";

const [rootArgument, nativeSocket] = process.argv.slice(2);
assert.equal(process.env.OPENCLAW_EXEC_HOST_NATIVE_PROOF, "1");
const root = await fs.realpath(rootArgument);
assert.equal(path.dirname(root), await fs.realpath("/tmp"));
assert.ok(path.basename(root).startsWith("oc-exec-native-"));
assert.equal(await fs.realpath(process.env.OPENCLAW_STATE_DIR!), path.join(root, "state"));
const token = "exec-host-native-proof-token";
const marker = path.join(root, "native-markers");
const release = path.join(root, "release-child");
await fs.rm(marker, { force: true });
await fs.rm(release, { force: true });
const request: ExecHostRequest = {
  command: [
    "/bin/sh",
    "-c",
    'printf "START\\n" >> "$1"; while [ ! -f "$2" ]; do /bin/sleep 0.01; done; printf "COMPLETE\\n" >> "$1"',
    "exec-host-native-proof",
    marker,
    release,
  ],
  cwd: root,
  timeoutMs: 5_000,
  needsScreenRecording: false,
};

async function waitForStart() {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      if ((await fs.readFile(marker, "utf8")) === "START\n") {
        return;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    await delay(10);
  }
  throw new Error("Native child did not write START before the response fault");
}

async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Native proof deadline exceeded")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const success = await requestExecHostViaSocket({
  socketPath: nativeSocket,
  token,
  request: { command: ["/bin/echo", "native-success"], cwd: root, timeoutMs: 5_000 },
  timeoutMs: 10_000,
});
assert.equal(success?.ok, true);
if (success?.ok) {
  assert.equal(success.payload.success, true);
  assert.equal(success.payload.exitCode, 0);
  assert.equal(success.payload.stdout, "native-success\n");
}
const denied = await requestExecHostViaSocket({
  socketPath: nativeSocket,
  token,
  request: { ...request, agentId: "denied" },
  timeoutMs: 10_000,
});
assert.equal(denied?.ok, false);
if (denied && !denied.ok) {
  assert.equal(denied.error.reason, "security=deny");
}
await assert.rejects(fs.stat(marker), { code: "ENOENT" });
console.log("native success and policy denial verified");

const proxySocket = path.join(root, "proxy.sock");
const sockets: net.Socket[] = [];
const closes: Promise<void>[] = [];
const forwarded = Promise.withResolvers<void>();
const nativeResponse = Promise.withResolvers<string>();
const errors: Error[] = [];
const order: string[] = [];
function track(socket: net.Socket) {
  sockets.push(socket);
  closes.push(
    new Promise<void>((resolve) => {
      socket.once("close", resolve);
    }),
  );
  socket.on("error", (error) => errors.push(error));
}
const proxy = net.createServer({ allowHalfOpen: true }, (client) => {
  track(client);
  const upstream = net.createConnection({ path: nativeSocket, allowHalfOpen: true });
  track(upstream);
  // pipe forwards the signed bytes unchanged and forwards the request's write EOF.
  client.pipe(upstream);
  client.once("end", () => {
    order.push("request-half-closed");
    forwarded.resolve();
  });
  let response = "";
  upstream.setEncoding("utf8");
  upstream.on("data", (chunk: string) => {
    response += chunk;
  });
  upstream.once("end", () => nativeResponse.resolve(response));
});
try {
  const listening = once(proxy, "listening");
  proxy.listen(proxySocket);
  await listening;
  const outcome = requestExecHostViaSocket({
    socketPath: proxySocket,
    token,
    request,
    timeoutMs: 10_000,
  });
  await withDeadline(forwarded.promise, 3_000);
  await waitForStart();
  order.push("native-started");
  sockets[0].end();
  order.push("response-dropped");
  assert.equal(await outcome, null);
  order.push("client-null");
  assert.equal(await fs.readFile(marker, "utf8"), "START\n");
  await fs.writeFile(release, "finish\n");
  // Keep draining the native connection: its terminal reply proves the executor
  // awaited ShellExecutor and reaped the child, even though the caller lost it.
  const response = JSON.parse(await withDeadline(nativeResponse.promise, 8_000)) as {
    ok: boolean;
    payload: { success: boolean; exitCode: number };
  };
  assert.equal(response.ok, true);
  assert.equal(response.payload.success, true);
  assert.equal(response.payload.exitCode, 0);
  assert.equal(await fs.readFile(marker, "utf8"), "START\nCOMPLETE\n");
  order.push("native-completed");
  assert.deepEqual(order, [
    "request-half-closed",
    "native-started",
    "response-dropped",
    "client-null",
    "native-completed",
  ]);
  assert.deepEqual(errors, []);
  console.log("native START -> response dropped -> client null -> native COMPLETE");
} finally {
  await fs.writeFile(release, "finish\n");
  try {
    // Drain even after an assertion fails so the real native child is reaped.
    if (sockets.length > 0) {
      await withDeadline(nativeResponse.promise, 8_000);
    }
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await Promise.all(closes);
    await new Promise<void>((resolve, reject) => {
      proxy.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
