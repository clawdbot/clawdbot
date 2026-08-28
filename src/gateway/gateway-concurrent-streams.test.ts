import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stopChild } from "../../scripts/lib/gateway-bench-child.js";
import { getFreePort } from "../../scripts/lib/gateway-bench-probes.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import { hasErrnoCode } from "../infra/errno.js";
import { resetLogger } from "../logging/logger.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
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

afterEach(() => {
  resetAgentEventsForTest({ preserveListeners: true });
  resetLogger();
});

describe("Gateway concurrent HTTP streams", () => {
  it("keeps both streams isolated while global observers retain every run", async () => {
    const state = await createOpenClawTestState({
      label: "concurrent-streams",
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
    // Startup spans use the subsystem logger; discard Vitest's cached silent
    // settings after entering the isolated fixture so stalled startup is visible.
    resetLogger();
    const mockPort = await getFreePort();
    const controlPath = state.path("response-control.json");
    const requestLogPath = state.path("provider-requests.jsonl");
    const provider = buildMockOpenAiResponsesProvider(
      `http://127.0.0.1:${mockPort}/v1`,
      "gpt-5.6-luna",
    );
    const token = `fanout-${randomUUID()}`;
    const events: AgentEventPayload[] = [];
    const abort = new AbortController();
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
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
          auth: { mode: "token", token },
          http: {
            endpoints: { chatCompletions: { enabled: true }, responses: { enabled: true } },
          },
        },
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
      gateway = await startGatewayWithClient({
        cfg,
        configPath: state.configPath,
        token,
        scopes: ["operator.admin", "operator.read", "operator.write"],
        onEvent: (event) => {
          if (event.event === "agent") {
            events.push(event.payload as AgentEventPayload);
          }
        },
      });
      const { port, client } = gateway;
      for (const [index, item] of cases.entries()) {
        await client.request("sessions.messages.subscribe", { key: item.sessionKey });
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
        const result = await client.request<{ status: string }>("agent.wait", {
          runId,
          timeoutMs: 10_000,
        });
        expect(result.status).toBe("ok");
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
    } finally {
      abort.abort();
      try {
        if (gateway) {
          try {
            await disconnectGatewayClient(gateway.client);
          } finally {
            await gateway.server.close({ reason: "concurrent stream proof cleanup" });
          }
        }
      } finally {
        try {
          if (mock) {
            await stopChild(mock);
          }
          await Promise.all(streams.map((stream) => stream.settled));
        } finally {
          await state.cleanup();
        }
      }
    }
  }, 120_000);
});
