import { execFile } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { rawDataToString } from "../../packages/gateway-client/src/websocket-data.js";
import {
  createWorkerDeployBuildPlugin,
  WORKER_DEPLOY_OPTIONAL_NATIVE_MODULE_ID,
} from "../../scripts/lib/worker-deploy-build-plugin.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const fail = (message: string): never => {
  throw new Error(message);
};
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("worker deploy build plugin", () => {
  it("preserves WebSocket transport and lazy transcription in relocated worker output", async () => {
    const { build } = await import("tsdown");
    const { default: buildConfigs } = await import("../../tsdown.config.ts");
    const configs = Array.isArray(buildConfigs) ? buildConfigs : [buildConfigs];
    const workerConfig = configs.find(
      (config) =>
        typeof config.entry === "object" &&
        config.entry !== null &&
        !Array.isArray(config.entry) &&
        config.entry["worker/worker"] === "src/worker/worker-deploy-entry.ts",
    );
    expect(workerConfig).toBeDefined();
    const root = tempDirs.make("openclaw-worker-websocket-");
    const source = path.join(root, "transport.ts");
    const output = path.join(root, "output");
    const relocated = path.join(root, "relocated");
    fs.writeFileSync(
      source,
      [
        `export { WebSocket } from ${JSON.stringify(path.resolve("packages/gateway-client/src/websocket.ts"))};`,
        `export { createRealtimeTranscriptionWebSocketSession } from ${JSON.stringify(path.resolve("src/realtime-transcription/websocket-session.ts"))};`,
      ].join("\n"),
    );
    const bundles = await build({
      ...workerConfig,
      config: false,
      entry: { "worker/worker": source },
      outDir: output,
      dts: false,
      logLevel: "silent",
    });
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const requests: Array<{ path: string | undefined; header: string | string[] | undefined }> = [];
    const closes: Promise<unknown>[] = [];
    server.on("connection", (socket, request) => {
      requests.push({ path: request.url, header: request.headers["x-worker-proof"] });
      closes.push(once(socket, "close"));
      socket.on("message", (data) => {
        const text = rawDataToString(data);
        if (request.url === "/transcription") {
          socket.send(JSON.stringify({ transcript: text }));
        } else {
          socket.send(text);
        }
      });
    });
    try {
      await once(server, "listening");
      const address = server.address();
      expect(address && typeof address === "object").toBeTruthy();
      if (!address || typeof address === "string") {
        throw new Error("WebSocket proof server has no bound port");
      }
      fs.renameSync(output, relocated);
      const probe = `
import assert from "node:assert/strict";
import { once } from "node:events";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const [entry, url] = process.argv.slice(1);
assert.throws(() => createRequire(pathToFileURL(entry)).resolve("ws/package.json"), { code: "MODULE_NOT_FOUND" });
const { WebSocket, createRealtimeTranscriptionWebSocketSession } = await import(pathToFileURL(entry).href);
const socket = new WebSocket(url + "/client", { headers: { "x-worker-proof": "client-header" } });
await once(socket, "open");
const message = once(socket, "message");
socket.send("worker echo");
assert.equal((await message)[0].toString(), "worker echo");
const closed = once(socket, "close");
socket.close(1000, "proof complete");
assert.equal((await closed)[0], 1000);
let resolveTranscript, rejectTranscript;
const transcript = new Promise((resolve, reject) => { resolveTranscript = resolve; rejectTranscript = reject; });
const session = createRealtimeTranscriptionWebSocketSession({
  providerId: "fixture", url: url + "/transcription", readyOnOpen: true,
  headers: { "x-worker-proof": "transcription-header" },
  callbacks: { onError: rejectTranscript },
  sendAudio: (audio, transport) => transport.sendBinary(audio),
  onMessage: event => resolveTranscript(event.transcript),
  onClose: transport => transport.closeNow(),
});
try {
  await session.connect();
  assert.equal(session.isConnected(), true);
  session.sendAudio(Buffer.from("worker audio"));
  assert.equal(await transcript, "worker audio");
} finally { session.close(); }
console.log("relocated worker WebSocket and transcription passed");
`;
      const result = await promisify(execFile)(
        process.execPath,
        [
          ...(process.versions.bun ? ["--no-install"] : []),
          "--input-type=module",
          "--eval",
          probe,
          path.join(relocated, "worker/worker.mjs"),
          `ws://127.0.0.1:${address.port}`,
        ],
        {
          cwd: relocated,
          timeout: 30_000,
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            WINDIR: process.env.WINDIR,
            HOME: root,
            USERPROFILE: root,
            TMPDIR: root,
            TMP: root,
            TEMP: root,
          },
        },
      );
      expect(result.stdout.trim()).toBe("relocated worker WebSocket and transcription passed");
      expect(requests).toEqual([
        { path: "/client", header: "client-header" },
        { path: "/transcription", header: "transcription-header" },
      ]);
      await Promise.all(closes);
    } finally {
      for (const client of server.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      for (const bundle of bundles) {
        await bundle[Symbol.asyncDispose]();
      }
    }
  });

  it("replaces optional host-native modules with a failing virtual module", () => {
    const plugin = createWorkerDeployBuildPlugin();

    expect(plugin.load(WORKER_DEPLOY_OPTIONAL_NATIVE_MODULE_ID)).toContain(
      "optional host-native dependency unavailable",
    );
  });

  it("initializes the composed Browser runtime only when its factory is called", async () => {
    const bridgePath = path.resolve("src/worker/worker-deploy-browser-runtime.ts");
    const source = fs.readFileSync(bridgePath, "utf8");
    const plugin = createWorkerDeployBuildPlugin();

    const transformed = plugin.transform.call({ error: fail }, source, bridgePath);

    const root = tempDirs.make("openclaw-worker-browser-composition-");
    const outputPath = path.join(root, "src/worker/browser.mjs");
    const runtimePath = path.join(root, "extensions/browser/runtime-api.js");
    const eventsPath = path.join(root, "events.txt");
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
    fs.writeFileSync(outputPath, transformed!);
    fs.writeFileSync(
      runtimePath,
      `import { appendFileSync } from "node:fs";
const record = event => appendFileSync(${JSON.stringify(eventsPath)}, event + "\\n");
record("initialized");
export async function createAttachedBrowserToolRuntime(params) {
  await params.ensureAttachTarget();
  return { tool: params, dispose: async () => record("disposed") };
}`,
    );

    const { default: browser } = await import(pathToFileURL(outputPath).href);
    expect(fs.existsSync(eventsPath)).toBe(false);
    let attached = 0;
    const params = {
      cdpUrl: "http://127.0.0.1:9222",
      ensureAttachTarget: async () => {
        attached += 1;
      },
      agentSessionKey: "worker:session-1",
      agentDir: path.join(root, "agent"),
      workspaceDir: path.join(root, "workspace"),
    };
    const [first, second] = await Promise.all([
      browser.createAttachedBrowserToolRuntime(params),
      browser.createAttachedBrowserToolRuntime(params),
    ]);
    expect(attached).toBe(2);
    expect(first.tool).toBe(params);
    expect(second.tool).toBe(params);
    expect(fs.readFileSync(eventsPath, "utf8")).toBe("initialized\n");
    await first.dispose();
    await second.dispose();
    expect(fs.readFileSync(eventsPath, "utf8")).toBe("initialized\ndisposed\ndisposed\n");
  });

  it("binds the lazy Playwright accessor to bundled modules", () => {
    const runtimePath = path.resolve("extensions/browser/src/browser/playwright-core.runtime.ts");
    const source = fs.readFileSync(runtimePath, "utf8");
    const plugin = createWorkerDeployBuildPlugin();

    const transformed = plugin.transform.call({ error: fail }, source, runtimePath);

    expect(transformed).toContain('import * as playwrightCore from "playwright-core";');
    expect(transformed).toContain('import { getUserAgent } from "playwright-core/lib/coreBundle";');
    expect(transformed).toContain("return playwrightCore;");
    expect(transformed).not.toContain("createRequire");
    expect(transformed).not.toContain('require("playwright-core")');
  });

  it("bundles the undici dispatcher dependency without a worker runtime require", () => {
    const dispatcherPath = path.resolve("src/infra/net/undici-dispatcher-options.ts");
    const source = fs.readFileSync(dispatcherPath, "utf8");
    const plugin = createWorkerDeployBuildPlugin();

    const transformed = plugin.transform.call({ error: fail }, source, dispatcherPath);

    expect(transformed).toContain('import * as bundledUndici from "undici/index.js";');
    expect(transformed).toContain("return bundledUndici;");
    expect(transformed).toContain('return override as typeof import("undici");');
    expect(transformed).not.toContain('import { createRequire } from "node:module";');
    expect(transformed).not.toContain("const requireUndici = createRequire(import.meta.url);");
    expect(transformed).not.toContain('requireUndici("undici/index.js")');
  });

  it("leaves fs-safe native package resolution to the dependency", () => {
    const nativePath = path.resolve("node_modules/@openclaw/fs-safe/dist/native.js");
    const source = fs.readFileSync(nativePath, "utf8");
    const plugin = createWorkerDeployBuildPlugin();

    const transformed = plugin.transform.call({ error: fail }, source, nativePath);

    expect(transformed).toBeNull();
  });

  it("fails closed when the undici dispatcher bootstrap shape changes", () => {
    const dispatcherPath = path.resolve("src/infra/net/undici-dispatcher-options.ts");
    const source = fs.readFileSync(dispatcherPath, "utf8");
    const plugin = createWorkerDeployBuildPlugin();

    expect(() =>
      plugin.transform.call(
        { error: fail },
        source.replace(
          'return requireUndici("undici/index.js")',
          'return changedUndici("undici/index.js")',
        ),
        dispatcherPath,
      ),
    ).toThrow("undici dispatcher bootstrap changed");
  });

  it("inlines Playwright package identity without a runtime manifest read", () => {
    const coreBundlePath = path.resolve("node_modules/playwright-core/lib/coreBundle.js");
    const source = fs.readFileSync(coreBundlePath, "utf8");
    const plugin = createWorkerDeployBuildPlugin();

    const transformed = plugin.transform.call({ error: fail }, source, coreBundlePath);

    expect(transformed).toContain('packageJSON = {"name":"playwright-core","version":"1.62.1"};');
    expect(transformed).not.toContain(
      'packageJSON = require(import_path9.default.join(packageRoot, "package.json"));',
    );
    expect(transformed).toContain(
      'registry = new Registry({"comment":"Do not edit this file, use utils/roll_browser.js"',
    );
    expect(transformed).not.toContain(
      'registry = new Registry(require(import_path20.default.join(packageRoot, "browsers.json")));',
    );
  });

  it("matches the canonical dependency path behind a pnpm-style symlink", () => {
    const sourceRoot = path.resolve("node_modules/playwright-core");
    const source = fs.readFileSync(path.join(sourceRoot, "lib/coreBundle.js"), "utf8");
    const tempRoot = tempDirs.make("openclaw-worker-build-plugin-");
    const linkedRoot = path.join(tempRoot, "node_modules", "playwright-core");
    fs.mkdirSync(path.dirname(linkedRoot), { recursive: true });
    fs.symlinkSync(sourceRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    const plugin = createWorkerDeployBuildPlugin(tempRoot);
    const resolvedId = fs.realpathSync(path.join(linkedRoot, "lib/coreBundle.js"));

    const transformed = plugin.transform.call({ error: fail }, source, resolvedId);

    expect(transformed).toContain('packageJSON = {"name":"playwright-core","version":"1.62.1"};');
  });

  it("fails closed when the dependency-owned bootstrap shape changes", () => {
    const coreBundlePath = path.resolve("node_modules/playwright-core/lib/coreBundle.js");
    const plugin = createWorkerDeployBuildPlugin();

    expect(() =>
      plugin.transform.call({ error: fail }, "changed upstream source", coreBundlePath),
    ).toThrow("playwright-core package bootstrap changed");
  });
});
