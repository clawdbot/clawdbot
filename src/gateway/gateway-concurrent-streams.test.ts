import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/index.js";
import { stopChild } from "../../scripts/lib/gateway-bench-child.js";
import { getFreePort } from "../../scripts/lib/gateway-bench-probes.js";
import { createGatewayWsClient } from "../../scripts/lib/gateway-ws-client.js";
import {
  BUILD_STAMP_FILE,
  RUNTIME_POSTBUILD_STAMP_FILE,
} from "../../scripts/lib/local-build-metadata-paths.mts";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { hasErrnoCode } from "../infra/errno.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

type StreamFrame = {
  id?: string;
  type?: string;
  delta?: string;
  choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
  response?: { id: string; status: string };
};

const cases = [
  {
    endpoint: "/v1/chat/completions",
    sessionKey: "agent:main:fanout-alpha",
    marker: "FANOUT_ALPHA first second",
  },
  {
    endpoint: "/v1/responses",
    sessionKey: "agent:main:fanout-beta",
    marker: "FANOUT_BETA first second",
  },
] as const;

describe("Gateway concurrent HTTP streams", () => {
  it("keeps both streams isolated while global observers retain every run", async () => {
    const cwd = process.cwd();
    const checkoutSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
    }).trim();
    // Require this checkout's complete runtime before the shared helper can
    // prepare a source fallback. The child must own one coherent built graph.
    await fs.access(path.join(cwd, "dist/index.js"));
    for (const stamp of [BUILD_STAMP_FILE, RUNTIME_POSTBUILD_STAMP_FILE]) {
      const metadata = JSON.parse(await fs.readFile(path.join(cwd, "dist", stamp), "utf8"));
      expect(metadata.head, stamp).toBe(checkoutSha);
    }
    const buildInfo = JSON.parse(await fs.readFile(path.join(cwd, "dist/build-info.json"), "utf8"));
    expect(buildInfo.commit).toBe(checkoutSha);
    const token = `fanout-${randomUUID()}`;
    const gateway = await createOpenClawTestInstance({
      name: "concurrent-streams",
      cwd,
      gatewayToken: token,
      env: {
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_GATEWAY_STARTUP_TRACE: "1",
        OPENCLAW_TEST_CONSOLE: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      },
    });
    const { state, port } = gateway;
    const controlPath = state.path("response-control.json");
    const requestLogPath = state.path("provider-requests.jsonl");
    const events: AgentEventPayload[] = [];
    const abort = new AbortController();
    let client: ReturnType<typeof createGatewayWsClient> | undefined;
    let mock: ChildProcessWithoutNullStreams | undefined;
    const streams: Array<{
      item: (typeof cases)[number];
      settled: Promise<PromiseSettledResult<StreamFrame[]>>;
    }> = [];
    const writeControl = async (hold: boolean) => {
      await fs.writeFile(
        `${controlPath}.next`,
        JSON.stringify({
          scriptVersion: "fanout-proof",
          hold,
          responses: cases.map(({ marker }) => ({ text: marker, chunkDelayMs: 100 })),
        }),
      );
      await fs.rename(`${controlPath}.next`, controlPath);
    };
    const requestBodies = async () => {
      const raw = await fs.readFile(requestLogPath, "utf8").catch((error: unknown) => {
        if (hasErrnoCode(error, "ENOENT")) {
          return "";
        }
        throw error;
      });
      return raw.trim()
        ? raw
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line).body as string)
        : [];
    };
    try {
      expect(await gateway.entrypoint()).toEqual(["dist/index.js"]);
      const mockPort = await getFreePort();
      const provider = buildMockOpenAiResponsesProvider(
        `http://127.0.0.1:${mockPort}/v1`,
        "gpt-5.6-luna",
      );
      await writeControl(true);
      mock = spawn(process.execPath, ["scripts/e2e/mock-openai-server.mjs"], {
        cwd: process.cwd(),
        detached: process.platform !== "win32",
        env: {
          PATH: process.env.PATH,
          MOCK_PORT: String(mockPort),
          MOCK_RESPONSE_CONTROL: controlPath,
          MOCK_REQUEST_LOG: requestLogPath,
        },
      });
      mock.stdout.resume();
      mock.stderr.resume();
      await vi.waitFor(async () => {
        expect((await fetch(`http://127.0.0.1:${mockPort}/health`)).status).toBe(200);
      });
      const cfg = {
        gateway: {
          port,
          auth: { mode: "token", token },
          controlUi: { enabled: false },
          http: {
            endpoints: { chatCompletions: { enabled: true }, responses: { enabled: true } },
          },
        },
        hooks: { enabled: false },
        agents: {
          defaults: {
            workspace: state.workspaceDir,
            skipBootstrap: true,
            maxConcurrent: 2,
            heartbeat: { every: "0m" },
            model: { primary: provider.modelRef },
            models: {
              [provider.modelRef]: {
                agentRuntime: { id: "openclaw" },
                params: { transport: "sse", openaiWsWarmup: false },
              },
            },
          },
        },
        models: {
          mode: "replace",
          providers: {
            [provider.providerId]: { ...provider.config, request: { allowPrivateNetwork: true } },
          },
        },
        plugins: { slots: { memory: "none" } },
        tools: { profile: "minimal" },
      } satisfies OpenClawConfig;
      await state.writeConfig(cfg);
      await gateway.startGateway();
      client = createGatewayWsClient({
        url: gateway.url,
        onEvent: (event) => {
          if (event.event === "agent") {
            events.push(event.payload as AgentEventPayload);
          }
        },
      });
      await client.waitOpen();
      const connected = await client.request("connect", {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: "gateway-client",
          displayName: "concurrent-stream-proof",
          version: "dev",
          platform: process.platform,
          mode: "backend",
        },
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write"],
        auth: { token },
      });
      expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
      for (const [index, item] of cases.entries()) {
        const subscribed = await client.request("sessions.messages.subscribe", {
          key: item.sessionKey,
        });
        expect(subscribed.ok, JSON.stringify(subscribed.error)).toBe(true);
        const body = {
          model: "openclaw:main",
          stream: true,
          ...(item.endpoint === "/v1/responses"
            ? { input: item.marker }
            : { messages: [{ role: "user", content: item.marker }] }),
        };
        const pending = (async () => {
          const response = await fetch(`http://127.0.0.1:${port}${item.endpoint}`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              "x-openclaw-session-key": item.sessionKey,
            },
            body: JSON.stringify(body),
            signal: abort.signal,
          });
          expect(response.status).toBe(200);
          const wire = await response.text();
          expect(wire.match(/^data: \[DONE\]$/gm)).toHaveLength(1);
          return wire
            .split("\n")
            .flatMap((line) =>
              line.startsWith("data: ") && line !== "data: [DONE]"
                ? [JSON.parse(line.slice(6)) as StreamFrame]
                : [],
            );
        })();
        streams.push({ item, settled: Promise.allSettled([pending]).then(([result]) => result!) });
        // Reserve each scripted response in arrival order, but hold both provider
        // requests open together before either may deliver a delta or terminal.
        await vi.waitFor(async () => expect(await requestBodies()).toHaveLength(index + 1), {
          timeout: 30_000,
        });
      }
      const requests = await requestBodies();
      for (const [index, item] of cases.entries()) {
        expect(requests[index]).toContain(item.marker);
      }
      await writeControl(false);
      for (const stream of streams) {
        const { item } = stream;
        const settled = await stream.settled;
        if (settled.status === "rejected") {
          throw settled.reason;
        }
        const frames = settled.value;
        const runId = frames[0]?.id ?? frames[0]?.response?.id;
        expect(runId).toEqual(expect.any(String));
        const text = frames
          .map((frame) => frame.delta ?? frame.choices?.[0]?.delta?.content ?? "")
          .join("");
        expect(text).toBe(item.marker);
        const terminals = frames.filter(
          (frame) =>
            frame.type === "response.completed" || frame.choices?.[0]?.finish_reason === "stop",
        );
        expect(terminals).toHaveLength(1);
        const result = await client.request("agent.wait", {
          runId,
          timeoutMs: 10_000,
        });
        expect(result.ok, JSON.stringify(result.error)).toBe(true);
        expect(result.payload).toMatchObject({ status: "ok" });
        await vi.waitFor(() => {
          const own = events.filter((event) => event.runId === runId);
          const lifecycle = own.filter((event) => event.stream === "lifecycle");
          expect(lifecycle.filter((event) => event.data.phase === "start")).toHaveLength(1);
          expect(lifecycle.filter((event) => event.data.phase === "end")).toHaveLength(1);
          const assistant = own.filter((event) => event.stream === "assistant");
          expect(assistant.at(-1)?.data.text).toBe(item.marker);
          for (const event of assistant) {
            expect(item.marker.startsWith(String(event.data.text))).toBe(true);
          }
        });
      }
    } catch (error) {
      console.error(gateway.logs());
      throw error;
    } finally {
      abort.abort();
      try {
        client?.close();
        await gateway.stopGateway();
      } finally {
        try {
          if (mock) {
            await stopChild(mock);
          }
          await Promise.all(streams.map((stream) => stream.settled));
        } finally {
          await gateway.cleanup();
        }
      }
    }
  }, 120_000);
});
