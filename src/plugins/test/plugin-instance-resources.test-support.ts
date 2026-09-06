import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { channel } from "node:diagnostics_channel";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { createDeferred } from "../../../test/helpers/promise.js";
import { PluginInstance } from "../plugin-instance.js";
import { verifyNativeSignalLifecycle } from "./plugin-instance-resources-signals.test-support.js";
import { verifyWatchLifecycle } from "./plugin-instance-resources-watch.test-support.js";

const require = createRequire(import.meta.url);
export async function verifyResourceLifecycle(scenario: string): Promise<void> {
  const instance = new PluginInstance("resource-proof");
  if (scenario.startsWith("watch-file-") || scenario.startsWith("promise-watch-")) {
    await verifyWatchLifecycle(scenario, instance);
  } else if (scenario === "lazy-stream") {
    let executed = false;
    const view = instance.wrap({
      stream: (async function* () {
        executed = true;
        yield "retired";
      })(),
    });
    await instance.dispose();
    await assert.rejects(
      async () => view.stream[Symbol.asyncIterator]().next(),
      /reloaded|disabled|retiring|closed/,
    );
    assert.equal(executed, false);
  } else if (scenario === "subclass") {
    const owned = instance.loadBuiltin("node:net", require) as typeof net;
    let destroyedInSubclass: string | undefined;
    let disposedInSubclass: string | undefined;
    class CustomSocket extends owned.Socket {
      #value = "subclass";
      custom() {
        return this.#value;
      }
      get label() {
        return this.#value;
      }
      override async [Symbol.asyncDispose]() {
        disposedInSubclass = this.#value;
        await super[Symbol.asyncDispose]();
      }
      override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
        destroyedInSubclass = this.#value;
        // oxlint-disable-next-line no-underscore-dangle -- Node Readable virtual cleanup calls super._destroy.
        super._destroy(error, callback);
      }
    }
    const socket = new CustomSocket();
    try {
      assert.ok(socket instanceof CustomSocket, "resource constructor lost newTarget");
      assert.equal(socket.custom(), "subclass");
      assert.equal(socket.label, "subclass");
    } finally {
      await instance.dispose();
    }
    assert.equal(destroyedInSubclass, "subclass");
    assert.equal(disposedInSubclass, "subclass");
  } else if (scenario === "factory-listener") {
    const owned = instance.loadBuiltin("node:http", require) as typeof http;
    const called: string[] = [];
    const server = owned.createServer(() => called.push("original"));
    server.listen({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    try {
      assert.ok(server instanceof owned.Server);
      const ownedNet = instance.loadBuiltin("node:net", require) as typeof net;
      assert.ok(server instanceof ownedNet.Server);
      class OtherServer extends owned.Server {}
      assert.equal(server instanceof OtherServer, false);
      server.removeAllListeners("request");
      server.on("request", () => called.push("replacement"));
      server.emit("request", {}, {});
      assert.deepEqual(called, ["replacement"], "factory listener survived removal");
    } finally {
      await instance.dispose();
    }
  } else if (scenario === "fluent-resource") {
    const owned = instance.loadBuiltin("node:net", require) as typeof net;
    const server = owned.createServer();
    try {
      const chained = server.listen({ host: "127.0.0.1", port: 0 });
      await once(server, "listening");
      assert.ok(chained === server, "fluent method exposed the raw server");
      await instance.dispose();
      assert.throws(
        () => chained.listen({ host: "127.0.0.1", port: 0 }),
        /reloaded|disabled|retiring/,
      );
    } finally {
      await instance.dispose();
    }
  } else if (scenario === "promisified-timer") {
    const owned = instance.loadBuiltin("node:timers", require) as typeof import("node:timers");
    try {
      assert.equal(await promisify(owned.setTimeout)(1, "timer-result"), "timer-result");
      assert.equal(await promisify(owned.setImmediate)("immediate-result"), "immediate-result");
      const pending = assert.rejects(promisify(owned.setTimeout)(60_000), { name: "AbortError" });
      const promises = instance.loadBuiltin(
        "node:timers/promises",
        require,
      ) as typeof import("node:timers/promises");
      assert.equal(await promises.scheduler.wait(1), undefined);
      assert.equal(await promises.scheduler.yield(), undefined);
      assert.throws(() => promises.scheduler.wait.call({}, 1), {
        code: "ERR_INVALID_THIS",
      });
      assert.throws(() => promises.scheduler.yield.call({}), {
        code: "ERR_INVALID_THIS",
      });
      const scheduled = assert.rejects(promises.scheduler.wait(60_000), { name: "AbortError" });
      instance.quiesce();
      assert.throws(() => promisify(owned.setTimeout)(1), /reloaded|disabled|retiring/);
      assert.throws(() => promises.setTimeout(1), /reloaded|disabled|retiring/);
      assert.throws(() => promises.setImmediate(), /reloaded|disabled|retiring/);
      assert.throws(() => promises.setInterval(1), /reloaded|disabled|retiring/);
      assert.throws(() => promises.scheduler.wait(1), /reloaded|disabled|retiring/);
      assert.throws(() => promises.scheduler.yield(), /reloaded|disabled|retiring/);
      await instance.dispose();
      await pending;
      await scheduled;
    } finally {
      await instance.dispose();
    }
  } else if (scenario === "pending-http") {
    const host = http.createServer();
    host.listen({ host: "127.0.0.1", port: 0 });
    await once(host, "listening");
    try {
      const received = once(host, "request");
      const owned = instance.loadBuiltin("node:http", require) as typeof http;
      const address = host.address() as net.AddressInfo;
      const request = owned.request({ host: "127.0.0.1", port: address.port });
      request.on("error", () => {});
      request.end();
      await received;
      await instance.dispose();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    } finally {
      host.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        host.close((error) => (error ? reject(error) : resolve()));
      });
    }
  } else if (scenario === "accepted-socket") {
    const owned = instance.loadBuiltin("node:net", require) as typeof net;
    let accepted!: net.Socket;
    let nativeAccepted!: net.Socket;
    let prepended!: net.Socket;
    let receive!: () => void;
    const received = new Promise<void>((resolve) => {
      receive = resolve;
    });
    const server = owned.createServer((socket) => {
      accepted = socket;
      receive();
    });
    EventEmitter.prototype.on.call(server, "connection", (socket: net.Socket) => {
      nativeAccepted = socket;
    });
    server.prependListener("connection", (socket) => {
      prepended = socket;
    });
    server.listen({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const client = net.connect((server.address() as net.AddressInfo).port, "127.0.0.1");
    client.on("error", () => {});
    try {
      await received;
      assert.equal(accepted, nativeAccepted, "factory callback received a different socket");
      assert.equal(prepended, nativeAccepted, "prepended callback received a different socket");
      await instance.dispose();
      assert.equal(accepted.destroyed, true, "accepted socket survived retirement");
      assert.throws(() => accepted.emit("close"), /reloaded|disabled|retiring/);
    } finally {
      client.destroy();
      await instance.dispose().catch(() => {});
    }
  } else if (
    scenario === "accepted-http-listeners" ||
    scenario === "accepted-http-upgrade-listeners"
  ) {
    const owned = instance.loadBuiltin("node:http", require) as typeof http;
    const received = createDeferred<net.Socket>();
    const first = createDeferred();
    let calls = 0;
    const accept = (socket: net.Socket) => {
      socket.on("data", () => {
        calls += 1;
        first.resolve();
      });
      received.resolve(socket);
    };
    const server = owned.createServer();
    const upgrade = scenario === "accepted-http-upgrade-listeners";
    if (upgrade) {
      server.on("upgrade", (request) => {
        // The first registration makes Node restore its listener methods after parser detachment.
        request.socket.on("data", () => {});
        accept(request.socket);
      });
    } else {
      server.on("request", (request) => accept(request.socket));
    }
    server.listen({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const client = net.connect((server.address() as net.AddressInfo).port, "127.0.0.1");
    client.on("error", () => {});
    try {
      client.write(
        upgrade
          ? "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: owned-test\r\n\r\n"
          : "POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\n",
      );
      const socket = await received.promise;
      client.write("a");
      await first.promise;
      assert.equal(calls, 1);
      instance.quiesce();
      const second = new Promise<void>((resolve) => {
        EventEmitter.prototype.on.call(socket, "data", resolve);
      });
      client.write("b");
      await second;
      assert.equal(calls, 1, "HTTP socket listener executed after quiescence");
    } finally {
      client.destroy();
      await instance.dispose();
    }
  } else if (scenario === "pipe-identity" || scenario === "pipe-drain") {
    const host = net.createServer((socket) => socket.end("payload"));
    host.listen({ host: "127.0.0.1", port: 0 });
    await once(host, "listening");
    const owned = instance.loadBuiltin("node:net", require) as typeof net;
    const socket = owned.connect((host.address() as net.AddressInfo).port, "127.0.0.1");
    const destination = new PassThrough();
    destination.resume();
    const ended = once(socket, "end");
    try {
      const result = socket.pipe(destination, { end: false });
      await ended;
      if (scenario === "pipe-identity") {
        assert.equal(result, destination, "pipe changed the borrowed destination identity");
      } else {
        await instance.drain();
        await instance.dispose();
        assert.equal(destination.destroyed, false, "retirement destroyed a borrowed destination");
        destination.write("still usable");
      }
    } finally {
      destination.destroy();
      await instance.dispose().catch(() => {});
      await new Promise<void>((resolve, reject) => {
        host.close((error) => (error ? reject(error) : resolve()));
      });
    }
  } else if (scenario === "errored-watcher") {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-errored-watcher-"));
    try {
      const owned = instance.loadBuiltin("node:fs", require) as typeof fs;
      const watcher = owned.watch(root);
      let failure: Error | undefined;
      let closed = false;
      watcher.on("error", (error) => {
        failure = error;
      });
      watcher.on("close", () => {
        closed = true;
      });
      // Drive Node's real native-error callback without exhausting the OS watcher limit.
      const handle = Reflect.get(watcher, "_handle");
      Reflect.apply(handle.onchange, handle, [-os.constants.errno.ENOSPC, "change", root]);
      assert.ok(failure);
      assert.equal(Reflect.get(watcher, "_handle"), null);
      assert.equal(closed, false);
      await instance.dispose();
    } finally {
      await instance.dispose().catch(() => {});
      fs.rmSync(root, { recursive: true, force: true });
    }
  } else if (scenario === "requested-http2-stream") {
    const received = createDeferred();
    const host = http2.createServer();
    host.on("stream", (stream) => {
      stream.on("error", () => {});
      received.resolve();
    });
    host.listen({ host: "127.0.0.1", port: 0 });
    await once(host, "listening");
    const owned = instance.loadBuiltin("node:http2", require) as typeof http2;
    const session = owned.connect(`http://127.0.0.1:${(host.address() as net.AddressInfo).port}`);
    session.on("error", () => {});
    let nativeStream: unknown;
    const created = channel("http2.client.stream.created");
    const observe = (message: unknown) => {
      assert.ok(message && typeof message === "object");
      nativeStream = Reflect.get(message, "stream");
    };
    created.subscribe(observe);
    const request = session.request({ ":path": "/" });
    created.unsubscribe(observe);
    request.on("error", () => {});
    request.end();
    try {
      await received.promise;
      assert.equal(request, nativeStream, "request changed the native HTTP/2 stream identity");
      await instance.drain();
      await instance.dispose();
      assert.equal(request.destroyed, true, "requested HTTP/2 stream survived retirement");
      assert.equal(session.destroyed, true);
    } finally {
      await instance.dispose().catch(() => {});
      await new Promise<void>((resolve, reject) => {
        host.close((error) => (error ? reject(error) : resolve()));
      });
    }
  } else if (scenario.startsWith("signal-") || scenario.startsWith("borrowed-process-stdin")) {
    await verifyNativeSignalLifecycle(scenario, instance);
  } else if (scenario === "never-listening-server") {
    const owned = instance.loadBuiltin("node:http", require) as typeof http;
    owned.createServer();
    await instance.dispose();
  } else if (scenario === "emitter-controls") {
    const owned = instance.loadBuiltin("node:http", require) as typeof http;
    const server = owned.createServer();
    try {
      let calls = 0;
      const listening = () => {
        calls += 1;
      };
      server.listen({ host: "127.0.0.1", port: 0 }, listening);
      server.removeListener("listening", listening);
      await once(server, "listening");
      assert.equal(calls, 0, "listen callback survived removeListener");
      const payload = () => "payload";
      let received: unknown;
      server.on("payload", (value) => {
        received = value;
      });
      server.emit("payload", payload);
      assert.equal(received, payload, "emit changed function payload identity");
      const listener = () => {
        calls += 1;
      };
      const added: Function[] = [];
      const removed: Function[] = [];
      server.on("newListener", (event, callback) => {
        if (event === "count") {
          added.push(callback);
        }
      });
      server.on("removeListener", (event, callback) => {
        if (event === "count") {
          removed.push(callback);
        }
      });
      server.on("count", listener);
      server.once("count", listener);
      assert.deepEqual(added, [listener, listener]);
      assert.equal(server.listenerCount("count", listener), 2);
      server.removeListener("count", listener);
      assert.deepEqual(removed, [listener]);
      assert.equal(server.listenerCount("count", listener), 1);
      server.emit("count");
      assert.equal(calls, 1);
      let removedRaw: Function | undefined;
      server.on("removeListener", (event, callback) => {
        if (event === "raw") {
          removedRaw = callback;
        }
      });
      server.on("raw", listener);
      server.once("raw", listener);
      const raw = server.rawListeners("raw");
      assert.equal(raw[0], listener, "rawListeners changed persistent callback identity");
      const onceRaw = raw[1];
      assert.ok(onceRaw);
      assert.equal(Reflect.get(onceRaw, "listener"), listener);
      server.removeListener("raw", onceRaw);
      assert.equal(removedRaw, onceRaw, "explicit raw removal changed native metadata identity");
      server.removeListener("raw", listener);
      assert.equal(removedRaw, listener);
      server.on("raw", listener);
      server.once("raw", listener);
      const allRaw = server.rawListeners("raw");
      const removedAll: Function[] = [];
      server.on("removeListener", (event, callback) => {
        if (event === "raw") {
          removedAll.push(callback);
        }
      });
      server.removeAllListeners("raw");
      assert.deepEqual(removedAll, [allRaw[1], listener]);
    } finally {
      await instance.dispose();
    }
  } else if (scenario === "closed-watcher") {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-owned-watcher-"));
    try {
      const owned = instance.loadBuiltin("node:fs", require) as typeof fs;
      const watcher = owned.watch(root);
      const closed = once(watcher, "close");
      watcher.close();
      await closed;
      watcher.ref();
      await instance.dispose();
    } finally {
      await instance.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  } else if (scenario === "reopened-server") {
    const owned = instance.loadBuiltin("node:net", require) as typeof net;
    const server = owned.createServer();
    try {
      server.listen({ host: "127.0.0.1", port: 0 });
      await once(server, "listening");
      const closed = once(server, "close");
      server.close();
      await closed;
      server.listen({ host: "127.0.0.1", port: 0 });
      await once(server, "listening");
      await instance.dispose();
      assert.equal(server.listening, false);
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
      await instance.dispose();
    }
  } else if (scenario === "timer-handle") {
    const timers = instance.loadBuiltin("node:timers", require) as typeof import("node:timers");
    let fired!: () => void;
    const first = new Promise<void>((resolve) => {
      fired = resolve;
    });
    const receivers: unknown[] = [];
    const handle = timers.setTimeout(function (this: unknown) {
      receivers.push(this);
      fired();
    }, 1);
    try {
      await first;
      assert.equal(handle.refresh(), handle);
      handle[Symbol.dispose]();
      assert.equal(handle.refresh(), handle);
      await instance.dispose();
      assert.throws(() => handle.refresh(), /reloaded|disabled|retiring/);
      assert.equal(receivers.at(-1), handle, "timeout callback lost its native receiver");
      handle[Symbol.dispose]();
    } finally {
      clearTimeout(handle);
      await instance.dispose();
    }
  } else if (scenario === "accepted-http2-stream") {
    const owned = instance.loadBuiltin("node:http2", require) as typeof http2;
    const server = owned.createServer();
    let accepted!: http2.Http2Stream;
    let nativeAccepted!: http2.Http2Stream;
    let receive!: () => void;
    const received = new Promise<void>((resolve) => {
      receive = resolve;
    });
    EventEmitter.prototype.on.call(server, "stream", (stream: http2.Http2Stream) => {
      nativeAccepted = stream;
    });
    server.on("stream", (stream) => {
      accepted = stream;
      stream.on("error", () => {});
      receive();
    });
    server.listen({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const client = http2.connect(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`);
    client.on("error", () => {});
    const closed = new Promise<void>((resolve) => {
      client.on("close", resolve);
    });
    const request = client.request({ ":path": "/" });
    request.on("error", () => {});
    request.end();
    try {
      await received;
      assert.equal(accepted, nativeAccepted);
      await instance.dispose();
      assert.equal(accepted.destroyed, true, "accepted HTTP/2 stream survived retirement");
      assert.equal(server.listening, false);
      assert.throws(() => accepted.emit("close"), /reloaded|disabled|retiring/);
    } finally {
      client.destroy();
      await closed;
      await instance.dispose().catch(() => {});
    }
  } else if (scenario === "client-http-upgrade" || scenario === "client-http-connect") {
    const connect = scenario === "client-http-connect";
    const event = connect ? "connect" : "upgrade";
    const agent = new http.Agent({ keepAlive: true });
    const peers = new Set<net.Socket>();
    const host = http.createServer();
    host.on("connection", (socket) => peers.add(socket));
    host.on(event, (_request, socket) => {
      socket.write(
        connect
          ? "HTTP/1.1 200 Connection Established\r\n\r\n"
          : "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: owned-test\r\n\r\n",
      );
    });
    host.listen({ host: "127.0.0.1", port: 0 });
    await once(host, "listening");
    let rawSocket: net.Socket | undefined;
    try {
      const owned = instance.loadBuiltin("node:http", require) as typeof http;
      const request = owned.request({
        host: "127.0.0.1",
        port: (host.address() as net.AddressInfo).port,
        agent,
        method: connect ? "CONNECT" : "GET",
        ...(connect ? {} : { headers: { Connection: "Upgrade", Upgrade: "owned-test" } }),
      });
      const transferred = createDeferred<net.Socket>();
      const closed = new Promise<void>((resolve) => {
        EventEmitter.prototype.on.call(request, "close", resolve);
      });
      EventEmitter.prototype.on.call(request, event, (_response: unknown, socket: net.Socket) => {
        rawSocket = socket;
      });
      request.prependOnceListener(event, (_response, socket) => transferred.resolve(socket));
      request.end();
      const delivered = await transferred.promise;
      await closed;
      assert.ok(rawSocket);
      assert.equal(request.destroyed, true, "request did not finish transferring its socket");
      assert.equal(Object.values(agent.sockets).flat().includes(rawSocket), false);
      await instance.dispose();
      assert.equal(rawSocket.destroyed, true, "HTTP transferred socket survived retirement");
      assert.equal(delivered, rawSocket, "transfer callback lost native socket identity");
    } finally {
      if (rawSocket && !rawSocket.destroyed) {
        rawSocket.destroy();
      }
      for (const peer of peers) {
        peer.destroy();
      }
      agent.destroy();
      await new Promise<void>((resolve, reject) => {
        host.close((error) => (error ? reject(error) : resolve()));
      });
      await instance.dispose().catch(() => {});
    }
  } else if (scenario === "pooled-agent") {
    const successor = new PluginInstance("resource-successor");
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    let held!: http.ServerResponse;
    let receive!: () => void;
    const received = new Promise<void>((resolve) => {
      receive = resolve;
    });
    const host = http.createServer((request, response) => {
      if (request.url === "/first") {
        response.end("first");
      } else {
        held = response;
        receive();
      }
    });
    host.listen({ host: "127.0.0.1", port: 0 });
    await once(host, "listening");
    const options = { host: "127.0.0.1", port: (host.address() as net.AddressInfo).port, agent };
    const read = (request: http.ClientRequest) =>
      new Promise<string>((resolve, reject) => {
        request.on("error", reject);
        request.on("response", (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () => resolve(Buffer.concat(chunks).toString()));
        });
        request.end();
      });
    try {
      const first = (instance.loadBuiltin("node:http", require) as typeof http).request({
        ...options,
        path: "/first",
      });
      let firstSocket!: net.Socket;
      EventEmitter.prototype.on.call(first, "socket", (socket: net.Socket) => {
        firstSocket = socket;
      });
      const free = once(agent, "free");
      assert.equal(await read(first), "first");
      await free;
      const second = (successor.loadBuiltin("node:http", require) as typeof http).request({
        ...options,
        path: "/second",
      });
      let secondSocket!: net.Socket;
      EventEmitter.prototype.on.call(second, "socket", (socket: net.Socket) => {
        secondSocket = socket;
      });
      const result = read(second);
      void result.catch(() => {});
      await received;
      assert.equal(secondSocket, firstSocket, "fixture did not reuse the Agent socket");
      await instance.dispose();
      assert.equal(
        secondSocket.destroyed,
        false,
        "retiring the prior request destroyed another owner's socket",
      );
      held.end("second");
      assert.equal(await result, "second");
      await successor.dispose();
    } finally {
      agent.destroy();
      host.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        host.close((error) => (error ? reject(error) : resolve()));
      });
      await Promise.allSettled([instance.dispose(), successor.dispose()]);
    }
  } else if (scenario === "late-native-close") {
    const owned = instance.loadBuiltin("node:child_process", require) as typeof childProcess;
    const child = owned.spawn(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('ready');",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const closed = new Promise<void>((resolve) => {
      EventEmitter.prototype.on.call(child, "close", resolve);
    });
    try {
      await once(child.stdout!, "data");
      await assert.rejects(instance.dispose(), /cleanup failed/);
      process.kill(child.pid!, "SIGKILL");
      await closed;
      assert.throws(() => child.stdout!.resume(), /reloaded|disabled|retiring/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        process.kill(child.pid!, "SIGKILL");
      }
      await closed;
      await instance.dispose().catch(() => {});
    }
  } else {
    throw new Error("Unknown scenario");
  }
}
