import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import {
  closeQaHttpServer,
  createQaGatewayChild,
  startQaMockOpenAiServer,
} from "../../../../extensions/qa-lab/api.js";
import type {
  TerminalAckResult,
  TerminalDataEvent,
  TerminalOpenResult,
} from "../../../../packages/gateway-protocol/src/schema/terminal.js";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import {
  connectHotReloadClient,
  waitForHotReloadFact,
  type HotReloadConnection,
} from "./gateway-config-hot-reload-fixtures.js";

const PREFIX = "gateway.terminal.enabled.deferredRestart";
const MODEL = "mock-openai/gpt-5.6-luna";
const REPLY = "TERMINAL_DEFERRED_RESTART_FINISHED";
type Evidence = { prefix: string; observation: string; bootId: string; pid: number };
type ConfigAck = { sentinel: { payload: { stats: { requiresRestart: boolean } } } };

export async function proveHotReloadTerminalDeferredRestart({
  repoRoot,
  outputDir,
  appendLog,
}: {
  repoRoot: string;
  outputDir: string;
  appendLog: (text: string) => void;
}) {
  const owner = createQaGatewayChild();
  const mock = await startQaMockOpenAiServer();
  const release = createDeferredCore();
  const evidence: Evidence[] = [];
  const failures: Array<{ prefix: string; message: string }> = [];
  const transportErrors: unknown[] = [];
  let held = false;
  let released = false;
  let closedBeforeRelease = false;
  let primary: HotReloadConnection | undefined;
  let startupOnlyControl:
    | { prefix: string; originalBootId: string; replacementBootId: string }
    | undefined;
  const releaseResponse = () => {
    released = true;
    release.resolve();
  };
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks);
      const upstream = await fetch(`${mock.baseUrl}${req.url}`, {
        method: req.method,
        headers: { "content-type": "application/json" },
        ...(body.length ? { body } : {}),
      });
      const response = Buffer.from(await upstream.arrayBuffer());
      if (req.url === "/v1/responses" && body.includes(REPLY)) {
        assert(upstream.ok, "Stock mock provider must produce the held response");
        held = true;
        res.once("close", () => {
          closedBeforeRelease ||= !released;
        });
        // Keep real inference active until terminal admission is checked; a timer
        // must not drain the restart blocker ahead of the proof.
        await release.promise;
      }
      res.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      });
      res.end(response);
    })().catch((error: unknown) => {
      transportErrors.push(error);
      res.writeHead(500).end();
    });
  });

  await runQaGatewayFixture(
    async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        assert(address && typeof address !== "string");
        const gateway = await owner.start({
          repoRoot,
          useRepoCli: true,
          command: {
            executablePath: process.execPath,
            argsPrefix: [path.join(repoRoot, "dist/index.js")],
            cwd: repoRoot,
            usePackagedPlugins: true,
          },
          providerMode: "mock-openai",
          forcedRuntime: "openclaw",
          providerBaseUrl: `http://127.0.0.1:${address.port}/v1`,
          primaryModel: MODEL,
          transportBaseUrl: "http://127.0.0.1:1",
          controlUiEnabled: true,
          mutateConfig: (cfg) => ({
            ...cfg,
            gateway: {
              ...cfg.gateway,
              reload: { mode: "hybrid" },
              terminal: { enabled: false, shell: "/bin/sh" },
            },
          }),
        });
        primary = await connectHotReloadClient(gateway);
        const connection = primary;
        const bootId = connection.bootId;
        const pid = gateway.pid;
        assert(pid && bootId);
        const rpc = <T>(method: string, params: unknown = {}) =>
          connection.client.request<T>(method, params, { timeoutMs: 40_000 });
        const patch = async (change: unknown) => {
          const { hash } = await rpc<{ hash: string }>("config.get");
          return await rpc<ConfigAck>("config.patch", {
            baseHash: hash,
            raw: JSON.stringify(change),
          });
        };
        await assert.rejects(
          rpc("terminal.open", { agentId: "qa", cols: 80, rows: 24 }),
          /terminal is disabled/,
        );
        const sessionKey = `agent:qa:deferred-terminal-${randomUUID()}`;
        const { runId } = await rpc<{ runId: string }>("chat.send", {
          sessionKey,
          message: `Reply exactly \`${REPLY}\``,
          deliver: false,
          idempotencyKey: randomUUID(),
        });
        await waitForHotReloadFact("real model response held", () => {
          assert.ifError(transportErrors[0]);
          return held ? true : undefined;
        });
        const preflight = await rpc<{ safe: boolean; counts: { embeddedRuns: number } }>(
          "gateway.restart.preflight",
        );
        assert.equal(preflight.safe, false);
        assert(preflight.counts.embeddedRuns > 0, "The held response must own an active agent run");
        const restart = await patch({ gateway: { controlUi: { enabled: false } } });
        assert.equal(restart.sentinel.payload.stats.requiresRestart, true);
        await waitForHotReloadFact("startup-only change deferred for active work", () =>
          gateway
            .logs()
            .split("\n")
            .some(
              (line) =>
                line.includes("gateway.controlUi.enabled") && line.includes("deferring until"),
            )
            ? true
            : undefined,
        );
        // A committed hot write reports the outstanding restart instead of a
        // success receipt. Require that exact outcome, not a rejected candidate.
        await assert.rejects(patch({ gateway: { terminal: { enabled: true } } }), {
          code: "UNAVAILABLE",
          message:
            /^config\.patch persisted and updated the active Gateway, but a recovery restart is required;/,
        });
        const configured = await rpc<{ config: { gateway: { terminal: { enabled: boolean } } } }>(
          "config.get",
        );
        assert.equal(configured.config.gateway.terminal.enabled, true);
        assert(gateway.logs().includes("config hot reload applied (gateway.terminal.enabled)"));
        const terminal = await rpc<TerminalOpenResult>("terminal.open", {
          agentId: "qa",
          cols: 80,
          rows: 24,
        });
        const cursor = connection.events.length;
        assert.equal(
          (
            await rpc<TerminalAckResult>("terminal.input", {
              sessionId: terminal.sessionId,
              data: "printf '%s%s\\n' 'DEFERRED_' 'TERMINAL_RUNNING'\n",
            })
          ).ok,
          true,
        );
        await waitForHotReloadFact("PTY executes before the deferred restart", () => {
          const output = connection.events
            .slice(cursor)
            .flatMap((event) => {
              const payload = event.payload as TerminalDataEvent | undefined;
              return event.event === "terminal.data" && payload?.sessionId === terminal.sessionId
                ? [payload.data]
                : [];
            })
            .join("");
          return output.includes("DEFERRED_TERMINAL_RUNNING") ? true : undefined;
        });
        assert.equal((await rpc<{ pid: number }>("system.info")).pid, pid);
        assert.equal(connection.closes, 0);
        assert.equal(connection.hellos, 1);
        assert.equal(closedBeforeRelease, false);
        const fresh = await connectHotReloadClient(gateway);
        try {
          assert.equal(fresh.bootId, bootId);
        } finally {
          await fresh.client.stopAndWait();
        }
        await rpc("terminal.close", { sessionId: terminal.sessionId });
        const completion = rpc<{ status: string }>("agent.wait", { runId, timeoutMs: 30_000 });
        releaseResponse();
        assert.equal((await completion).status, "ok");
        await waitForHotReloadFact(
          "deferred restart replaces the boot after model completion",
          () =>
            connection.closes > 0 && connection.hellos > 1 && connection.bootId !== bootId
              ? true
              : undefined,
        );
        const history = await rpc<{
          messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
        }>("chat.history", { sessionKey });
        assert(
          history.messages.some(
            (message) =>
              message.role === "assistant" &&
              message.content.some((part) => part.type === "text" && part.text === REPLY),
          ),
        );
        assert.equal((await fetch(`${gateway.baseUrl}/chat/qa`)).status, 404);
        startupOnlyControl = {
          prefix: "gateway.controlUi.enabled (deferred)",
          originalBootId: bootId,
          replacementBootId: connection.bootId,
        };
        const observation =
          "A real model response held the restart pending while hot enablement opened and executed a PTY on the original boot/PID/WebSocket; releasing the response completed the turn and then replaced the Gateway boot";
        evidence.push({ prefix: PREFIX, observation, bootId, pid });
        appendLog(`PASS ${PREFIX}: ${observation}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ prefix: PREFIX, message });
        appendLog(`FAIL ${PREFIX}: ${message}\n`);
      } finally {
        releaseResponse();
      }
    },
    () => primary?.client.stopAndWait(),
    () =>
      stopQaGatewayFixture(owner, {
        preserveToDir: path.join(outputDir, "terminal-deferred-gateway"),
      }),
    () => closeQaHttpServer(server),
    () => mock.stop(),
    async () => {
      await fs.mkdir(outputDir, { recursive: true });
      await fs.writeFile(
        path.join(outputDir, "gateway-config-hot-reload-terminal-deferred.json"),
        `${JSON.stringify({ evidence, failures, startupOnlyControl }, null, 2)}\n`,
      );
    },
  );
  return { evidence, failures, startupOnlyControl };
}
