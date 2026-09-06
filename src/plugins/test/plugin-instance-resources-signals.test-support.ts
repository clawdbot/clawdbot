import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Worker, parentPort } from "node:worker_threads";
import { createDeferredCore } from "../../shared/deferred.js";
import { PluginInstance } from "../plugin-instance.js";

const require = createRequire(import.meta.url);

export async function verifyNativeSignalLifecycle(
  scenario: string,
  instance = new PluginInstance("resource-proof"),
): Promise<void> {
  if (scenario.startsWith("signal-")) {
    const [, kind, origin] = scenario.split("-");
    assert.ok(kind && origin, "signal fixture requires a resource kind and abort origin");
    const controller = new AbortController();
    const signal = origin === "lifecycle" ? instance.lifecycle.signal : controller.signal;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-native-signal-"));
    let resource: EventEmitter;
    let destroyedBySubclass = false;
    let finishConstruction: (() => void) | undefined;
    const cleanupFailure =
      kind === "subclassthrow" || kind === "subclasscallback"
        ? new Error("virtual destructor failed")
        : undefined;
    let closeHost = async () => {};
    if (
      kind === "subclass" ||
      kind === "subclasspromise" ||
      kind === "subclassthrow" ||
      kind === "subclassvoid" ||
      kind === "subclasscallback" ||
      kind === "subclassconstruct"
    ) {
      const owned = instance.loadBuiltin("node:net", require) as typeof net;
      class CleanupSocket extends owned.Socket {
        // oxlint-disable-next-line typescript/no-misused-promises -- Exercise a retained cleanup promise while still completing through Node's callback.
        override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
          const destroy = () => {
            destroyedBySubclass = true;
            // oxlint-disable-next-line no-underscore-dangle -- Node's virtual teardown completes through super._destroy.
            super._destroy(
              kind === "subclasscallback" && cleanupFailure ? cleanupFailure : error,
              callback,
            );
            if (kind === "subclassthrow" && cleanupFailure) {
              throw cleanupFailure;
            }
          };
          if (kind === "subclassvoid") {
            if (origin === "lifecycle") {
              // Natural subprocess exit proves terminal cleanup cancels this live handle.
              instance.globals.setInterval(() => {}, 60_000);
            }
            instance.globals.setImmediate(destroy);
            return;
          }
          return kind === "subclasspromise" ? Promise.resolve().then(destroy) : destroy();
        }
      }
      const constructing = createDeferredCore<() => void>();
      class ConstructingSocket extends CleanupSocket {
        override _construct(callback: (error?: Error | null) => void) {
          constructing.resolve(() => callback());
        }
      }
      resource =
        kind === "subclassconstruct"
          ? new ConstructingSocket({ signal })
          : new CleanupSocket({ signal });
      resource.on("error", () => {});
      if (kind === "subclassconstruct") {
        finishConstruction = await constructing.promise;
      }
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    } else if (kind === "watcher") {
      const owned = instance.loadBuiltin("node:fs", require) as typeof fs;
      resource = owned.watch(root, Object.freeze({ signal }));
    } else if (kind === "server") {
      const owned = instance.loadBuiltin("node:net", require) as typeof net;
      const server = owned.createServer();
      const options: net.ListenOptions = { host: "127.0.0.1", port: 0 };
      Object.setPrototypeOf(options, { signal });
      server.listen(options);
      await once(server, "listening");
      resource = server;
    } else if (kind === "http" || kind === "httpurl") {
      const host = http.createServer();
      host.listen({ host: "127.0.0.1", port: 0 });
      await once(host, "listening");
      closeHost = async () => {
        host.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          host.close((error) => (error ? reject(error) : resolve()));
        });
      };
      const owned = instance.loadBuiltin("node:http", require) as typeof http;
      const port = (host.address() as net.AddressInfo).port;
      const received = once(host, "request");
      const request =
        kind === "http"
          ? owned.request(Object.freeze({ host: "127.0.0.1", port, signal }))
          : owned.request(`http://127.0.0.1:${port}/`, Object.freeze({ signal }));
      request.on("error", () => {});
      request.end();
      await received;
      resource = request;
    } else if (kind === "socket" || kind === "connection") {
      const host = net.createServer();
      host.listen({ host: "127.0.0.1", port: 0 });
      await once(host, "listening");
      closeHost = () =>
        new Promise<void>((resolve, reject) => {
          host.close((error) => (error ? reject(error) : resolve()));
        });
      const owned = instance.loadBuiltin("node:net", require) as typeof net;
      const options = { host: "127.0.0.1", port: (host.address() as net.AddressInfo).port };
      const socket =
        kind === "socket"
          ? new owned.Socket(Object.freeze({ signal })).connect(options)
          : owned.connect(Object.freeze({ ...options, signal }));
      socket.on("error", () => {});
      await once(socket, "connect");
      resource = socket;
    } else if (kind.startsWith("child")) {
      const owned = instance.loadBuiltin("node:child_process", require) as typeof childProcess;
      const script = "setInterval(() => {}, 1000); process.stdout.write('ready');";
      let child: childProcess.ChildProcess;
      if (kind === "childspawn") {
        child = owned.spawn(process.execPath, undefined, { signal });
        child.stdin!.end(script);
      } else if (kind === "childfork") {
        const source = path.join(root, "child.cjs");
        fs.writeFileSync(source, script);
        child = owned.fork(source, undefined, { signal, silent: true, execArgv: [] });
      } else if (kind === "childexecnull" || kind === "childexecundefined") {
        child = owned.execFile(process.execPath, kind === "childexecnull" ? null : undefined, {
          signal,
        });
        child.stdin!.end(script);
      } else {
        child = owned.spawn(process.execPath, ["-e", script], {
          signal,
          stdio: ["ignore", "pipe", "pipe"],
        });
      }
      if (kind !== "childunhandled") {
        child.on("error", () => {});
      }
      await once(child.stdout!, "data");
      resource = child;
    } else {
      throw new Error("Unknown native signal resource");
    }
    let pluginAbortObserved = false;
    signal.addEventListener(
      "abort",
      () => {
        pluginAbortObserved = true;
        finishConstruction?.();
        assert.throws(
          () => resource.emit("plugin-probe"),
          /reloaded|disabled|retiring/,
          "plugin abort listeners must not inherit native resource admission",
        );
      },
      { once: true },
    );
    try {
      instance.quiesce();
      if (origin === "external") {
        controller.abort();
      }
      if (cleanupFailure) {
        await assert.rejects(instance.dispose(), (error) => {
          assert.ok(error instanceof AggregateError);
          assert.ok(
            error.errors.some(
              (entry) => entry instanceof AggregateError && entry.errors.includes(cleanupFailure),
            ),
            "retirement did not report the virtual destructor failure",
          );
          return true;
        });
      } else {
        await instance.dispose();
      }
      assert.equal(pluginAbortObserved, true);
      if (kind.startsWith("subclass")) {
        assert.equal(
          destroyedBySubclass,
          true,
          "native signal cleanup skipped the virtual destructor",
        );
      }
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    } finally {
      await instance.dispose().catch(() => {});
      await closeHost();
      fs.rmSync(root, { recursive: true, force: true });
    }
  } else if (scenario === "borrowed-process-stdin") {
    const worker = new Worker(
      `
      import(${JSON.stringify(import.meta.url)}).then(({ verifyNativeSignalLifecycle }) =>
        verifyNativeSignalLifecycle("borrowed-process-stdin-worker"));
    `,
      { eval: true, stdin: true },
    );
    const exited = new Promise<number>((resolve) => {
      worker.once("exit", resolve);
    });
    try {
      assert.deepEqual(await once(worker, "message"), ["ready"]);
      const delivered = once(worker, "message");
      worker.stdin!.end("after retirement");
      assert.deepEqual(await delivered, ["after retirement"]);
      assert.equal(await exited, 0);
    } finally {
      await worker.terminate();
      await exited;
    }
  } else if (scenario === "borrowed-process-stdin-worker") {
    assert.ok(parentPort);
    // Node's bootstrap returns its exact stdin; this legacy method is absent from some Node typings.
    const facade = instance.loadBuiltin("node:process", require) as {
      openStdin(): typeof process.stdin;
    };
    assert.equal(facade.openStdin(), process.stdin);
    await instance.dispose();
    assert.equal(process.stdin.destroyed, false, "retirement destroyed borrowed host stdin");
    process.stdin.once("data", (chunk: Buffer) => parentPort!.postMessage(chunk.toString(), []));
    parentPort.postMessage("ready", []);
  } else {
    throw new Error("Unknown native signal scenario");
  }
}
