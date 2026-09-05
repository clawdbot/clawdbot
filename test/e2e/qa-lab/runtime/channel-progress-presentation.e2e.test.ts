import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type RequestListener, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startOpenClawCrablineAdapter } from "@openclaw/crabline";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  createQaGatewayChild,
  startQaMockOpenAiServer,
} from "../../../../extensions/qa-lab/api.js";
import {
  listSessionEntriesReadOnly,
  loadSessionEntryReadOnly,
  updateSessionEntry,
} from "../../../../src/config/sessions/session-accessor.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

const MODEL = "mock-openai/progress-fixture";
const FINAL_MARKER = "TOOL-PROGRESS-FINAL";
const HEADLINE = "Checking the requested work";
// The exec tool renders as a compact tool row on every progress surface.
const toolRow = /🛠️ (?:Exec|Bash)\b/u;
type WireWrite = {
  at: number;
  method: string;
  route: string;
  body: Record<string, unknown>;
  accepted?: { id: string; action: string; text: string };
  rejected?: string;
  identityOmitted?: true;
};
type CrablineAdapter = Awaited<ReturnType<typeof startOpenClawCrablineAdapter>>;

function parseBody(text: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return Object.fromEntries(new URLSearchParams(text));
  }
}

function readChunks(value: unknown): Array<Record<string, unknown>> {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? parsed.map(asRecord) : [];
}

// Crabline owns ingress, auth, channel metadata and history. Its released local
// servers lack native Slack streams and normal Discord edits, so this fixture
// completes those HTTP contracts without replacing the channel or SDK runtime.
async function startPresentationApi(
  adapter: CrablineAdapter,
  writes: WireWrite[],
  directory: string,
  {
    rejectStop = false,
    clearOrigin,
    unidentifiedFinalMarker,
  }: {
    rejectStop?: boolean;
    clearOrigin?: () => Promise<void>;
    unidentifiedFinalMarker?: string;
  } = {},
) {
  const manifest = adapter.manifest;
  const messages = new Map<string, Record<string, unknown>>();
  let nextMessage = 0;
  const listener: RequestListener = (request, response) => {
    void (async () => {
      const buffers: Buffer[] = [];
      for await (const chunk of request) {
        buffers.push(Buffer.from(chunk));
      }
      const raw = Buffer.concat(buffers).toString("utf8");
      const body = parseBody(raw);
      const route = request.url ?? "/";
      const method = request.method ?? "GET";
      // Tokens are synthetic, but evidence never needs authentication fields.
      const { token: _token, ...visibleBody } = body;
      const wire: WireWrite = { at: Date.now(), method, route, body: visibleBody };
      writes.push(wire);
      const recordAccepted = (id: string, action: string) => {
        const message = messages.get(id);
        wire.accepted = {
          id,
          action,
          text: (readStringValue(message?.text ?? message?.content) ?? "").slice(0, 250),
        };
      };
      const reply = (result: unknown, status = 200) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
      };
      if (manifest.provider === "slack") {
        const operation = route.replace(/^\/api\//u, "");
        const ts =
          typeof body.ts === "string"
            ? body.ts
            : `1800000000.${String(++nextMessage).padStart(6, "0")}`;
        if (["chat.startStream", "chat.appendStream", "chat.stopStream"].includes(operation)) {
          // The admitted final waits for this progress stream to start, so route
          // loss here is deterministic without changing the agent's tool call.
          if (rejectStop && operation === "chat.startStream") {
            await clearOrigin?.();
          }
          if (rejectStop && operation === "chat.stopStream") {
            reply({ ok: false, error: "internal_error" });
            return;
          }
          if (operation !== "chat.startStream" && !messages.has(ts)) {
            reply({ ok: false, error: "message_not_found" });
            return;
          }
          const previous = messages.get(ts) ?? {
            text: "",
            channel: body.channel,
            thread_ts: body.thread_ts,
          };
          const text = readChunks(body.chunks)
            .filter((chunk) => chunk.type === "markdown_text")
            .map((chunk) => readStringValue(chunk.text) ?? "")
            .join("");
          messages.set(ts, { ...previous, text: (readStringValue(previous.text) ?? "") + text });
          recordAccepted(ts, operation);
          reply({ ok: true, channel: body.channel, ts });
          return;
        }
        if (operation === "chat.update") {
          if (!messages.has(ts)) {
            reply({ ok: false, error: "message_not_found" });
            return;
          }
          messages.set(ts, body);
          recordAccepted(ts, operation);
          reply({ ok: true, channel: body.channel, ts, message: body });
          return;
        }
        if (operation === "chat.delete") {
          recordAccepted(ts, operation);
          messages.delete(ts);
          reply({ ok: true, channel: body.channel, ts });
          return;
        }
        if (operation.startsWith("reactions.") || operation === "assistant.threads.setStatus") {
          reply({ ok: true });
          return;
        }
        if (operation === "users.info") {
          reply({
            ok: true,
            user: { id: body.user, team_id: "TCRABLINE", name: "progress-operator" },
          });
          return;
        }
      } else if (
        manifest.provider === "discord" &&
        /\/channels\/\d+\/messages\/\d+$/u.test(route)
      ) {
        const messageId = route.split("/").at(-1)!;
        if (method === "PATCH") {
          const updated = { ...messages.get(messageId), ...body };
          messages.set(messageId, updated);
          recordAccepted(messageId, "updated");
          reply(updated);
          return;
        }
        if (method === "DELETE") {
          recordAccepted(messageId, "deleted");
          messages.delete(messageId);
          response.writeHead(204).end();
          return;
        }
      }
      const upstream = await fetch(new URL(route, manifest.baseUrl), {
        method,
        headers: {
          ...(request.headers.authorization
            ? { authorization: request.headers.authorization }
            : {}),
          ...(request.headers["content-type"]
            ? { "content-type": request.headers["content-type"] }
            : {}),
        },
        ...(method !== "GET" && method !== "HEAD" ? { body: raw } : {}),
      });
      let responseText = await upstream.text();
      if (upstream.ok && method === "POST") {
        const result = parseBody(responseText);
        if (result.ok === false) {
          wire.rejected = readStringValue(result.error);
        }
        if (
          manifest.provider === "discord" &&
          /\/channels\/\d+\/messages$/u.test(route) &&
          typeof result.id === "string"
        ) {
          messages.set(result.id, result);
          recordAccepted(result.id, "sent");
          if (
            unidentifiedFinalMarker &&
            (readStringValue(body.content) ?? "").includes(unidentifiedFinalMarker)
          ) {
            // Preserve the accepted platform message, but lose its response identity.
            // Discord's real adapter must report ambiguity, never policy cancellation.
            const { id: _id, ...unidentified } = result;
            responseText = JSON.stringify(unidentified);
            wire.identityOmitted = true;
          }
        } else if (
          manifest.provider === "slack" &&
          route.endsWith("chat.postMessage") &&
          typeof result.ts === "string"
        ) {
          messages.set(result.ts, asRecord(result.message));
          recordAccepted(result.ts, "sent");
        }
      }
      response.writeHead(upstream.status, { "content-type": "application/json" });
      response.end(responseText);
    })().catch(() => {
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end("presentation fixture request failed");
    });
  };
  const caPath = path.join(directory, "discord-ca.pem");
  const keyPath = path.join(directory, "discord-key.pem");
  if (manifest.provider === "discord") {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        caPath,
        "-days",
        "1",
        "-subj",
        "/CN=discord.com",
        "-addext",
        "subjectAltName=DNS:discord.com",
      ],
      { stdio: "ignore" },
    );
  }
  const server =
    manifest.provider === "discord"
      ? createHttpsServer(
          { key: await fs.readFile(keyPath), cert: await fs.readFile(caPath) },
          listener,
        )
      : createServer(listener);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("presentation API did not bind a loopback port");
  }
  const tunnelSockets = new Set<Socket>();
  const proxy = createServer((_request, response) => response.writeHead(405).end());
  proxy.on("connect", (request, socket, head) => {
    const localGateway =
      manifest.provider === "discord" ? new URL(manifest.endpoints.gatewayUrl) : undefined;
    const targetPort =
      request.url === "discord.com:443"
        ? address.port
        : localGateway && request.url === localGateway.host
          ? Number(localGateway.port)
          : undefined;
    if (!targetPort) {
      socket.destroy();
      return;
    }
    const upstream = connect(targetPort, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) {
        upstream.write(head);
      }
      socket.pipe(upstream).pipe(socket);
    });
    tunnelSockets.add(upstream);
    upstream.on("close", () => {
      tunnelSockets.delete(upstream);
      socket.destroy();
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
  });
  await new Promise<void>((resolve) => {
    proxy.listen(0, "127.0.0.1", resolve);
  });
  const proxyAddress = proxy.address();
  if (!proxyAddress || typeof proxyAddress === "string") {
    throw new Error("proxy failed to bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    proxyUrl: `http://127.0.0.1:${proxyAddress.port}`,
    caPath,
    messages,
    stop: async () => {
      for (const socket of tunnelSockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        proxy.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function isCompletionUserText(text: string): boolean {
  return (
    text.includes("Internal task completion event") ||
    text.includes("[Subagent Context] Every subagent spawned from this session has now settled")
  );
}

function readCurrentProviderUserText(body: Record<string, unknown>): string {
  // Ignore trailing context carriers, but a protected task completion is
  // itself a new request. Older prompts cannot override a newer user turn.
  const userTexts = Array.isArray(body.input)
    ? body.input
        .map(asRecord)
        .filter((item) => item.role === "user")
        .map((item) =>
          Array.isArray(item.content)
            ? item.content.map((part) => readStringValue(asRecord(part).text) ?? "").join("\n")
            : (readStringValue(item.content) ?? ""),
        )
    : [];
  const currentText =
    userTexts.findLast(
      (text) =>
        text.trim() &&
        (isCompletionUserText(text) ||
          !(
            text.includes("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>") &&
            text.trimEnd().endsWith("<<<END_OPENCLAW_INTERNAL_CONTEXT>>>")
          )),
    ) ?? "";
  return currentText;
}

function sendCompletionResponse(response: ServerResponse, marker: string, sequence: number) {
  const item = {
    type: "message",
    id: `announce-${sequence}`,
    role: "assistant",
    phase: "final_answer",
    status: "completed",
    content: [{ type: "output_text", text: marker, annotations: [] }],
  };
  const preamble = {
    ...item,
    id: `announce-preamble-${sequence}`,
    phase: "commentary",
    content: [{ type: "output_text", text: "Checking the delegated result", annotations: [] }],
  };
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...preamble, status: "in_progress", content: [] },
    },
    { type: "response.output_item.done", output_index: 0, item: preamble },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { ...item, status: "in_progress", content: [] },
    },
    { type: "response.output_item.done", output_index: 1, item },
    {
      type: "response.completed",
      response: {
        id: `announce-response-${sequence}`,
        status: "completed",
        output: [preamble, item],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ];
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
  );
}

function progressConfig(
  config: OpenClawConfig,
  channel: "discord" | "slack",
  native: boolean,
  toolProgress: boolean,
): OpenClawConfig {
  const streaming = {
    mode: "progress" as const,
    progress: {
      label: HEADLINE,
      toolProgress,
      ...(channel === "slack" ? { style: "card" as const } : {}),
    },
  };
  return {
    ...config,
    agents: {
      ...config.agents,
      defaults: { ...config.agents?.defaults, model: { primary: MODEL, fallbacks: [] } },
      entries: {
        ...config.agents?.entries,
        qa: {
          ...config.agents?.entries?.qa,
          identity: { name: "Progress QA" },
          model: { primary: MODEL, fallbacks: [] },
        },
      },
    },
    messages: {
      ackReaction: "eyes",
      ackReactionScope: "all",
      statusReactions: { enabled: true },
    },
    channels: {
      ...config.channels,
      ...(channel === "slack"
        ? {
            slack: {
              ...config.channels?.slack,
              replyToMode: "all",
              streaming: { ...streaming, nativeTransport: native },
            },
          }
        : {
            discord: {
              ...config.channels?.discord,
              // Crabline emits a fresh guild join with the first input. This proof
              // owns the ordinary user turn, not the separate welcome-message turn.
              joinIntro: false,
              ackReaction: "👀",
              streaming,
              commands: { native: false, nativeSkills: false },
            },
          }),
    },
  };
}

async function waitForFact(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 60_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await sleep(50);
  }
}

describe("channel progress presentation through an isolated Gateway", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    const errors: unknown[] = [];
    for (const cleanup of cleanups.splice(0).toReversed()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, "progress fixture cleanup failed");
    }
  });

  it("records suppressed Slack announcements without claiming delivery", async () => {
    const directory = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "slack-announce-"),
    );
    cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
    const cancelledMarker = "QA-SUBAGENT-TERMINAL-VISIBLE-OK";
    const deliveredMarker = "QA-SUBAGENT-TERMINAL-RESTART-OK";
    const observerModel = "mock-openai/observer-failure-fixture";
    const pluginId = "qa-announce-suppression";
    const pluginDir = path.join(directory, pluginId);
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: pluginId,
        activation: { onStartup: true },
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      }),
    );
    await fs.writeFile(
      path.join(pluginDir, "index.cjs"),
      `module.exports = {
      id: ${JSON.stringify(pluginId)},
      register(api) {
        api.on("message_sending", (event) => event.content.includes(${JSON.stringify(cancelledMarker)})
          ? { cancel: true, cancelReason: "synthetic announcement policy" } : undefined);
      }
    };`,
    );
    const writes: WireWrite[] = [];
    const adapter = await startOpenClawCrablineAdapter({
      channel: "slack",
      recorderPath: path.join(directory, "provider.jsonl"),
    });
    cleanups.push(() => adapter.close());
    const api = await startPresentationApi(adapter, writes, directory);
    cleanups.push(() => api.stop());
    const provider = await startQaMockOpenAiServer({ modelRefs: [MODEL, observerModel] });
    cleanups.push(() => provider.stop());
    const completions: string[] = [];
    const tasks: Array<Record<string, unknown>> = [];
    const inboundMessages: Array<Record<string, unknown>> = [];
    const providerRequests: Array<{ model: unknown; requester: boolean; completion: boolean }> = [];
    let observerRequests = 0;
    let releaseRequester: (() => void) | undefined;
    let requesterHeld = false;
    const slowRequesterCases = new Set<string>();
    const caseNames = ["visible", "restart"] as const;
    const settledRequesterCases: string[] = [];
    const observerFailures = () => {
      let attempts = 0;
      return gateway
        .logs()
        .split("\n")
        .flatMap((line) => {
          try {
            const value = asRecord(JSON.parse(line));
            const message = readStringValue(value.message) ?? "";
            if (
              value.subsystem === "provider-transport-fetch" &&
              message.startsWith("[model-fetch] start ") &&
              message.includes("model=observer-failure-fixture ")
            ) {
              attempts += 1;
            }
            if (message === "session observer disabled after consecutive failures") {
              const failure = {
                message,
                error: value.error,
                runId: value.runId,
                attempts,
              };
              attempts = 0;
              return [failure];
            }
            return [];
          } catch {
            return [];
          }
        });
    };
    // The shared terminal fixture intentionally requests a direct fallback.
    // Supply a visible model final over HTTP to exercise automatic-final receipts.
    const proxy = createServer((request, response) => {
      void (async () => {
        const buffers: Buffer[] = [];
        for await (const chunk of request) {
          buffers.push(Buffer.from(chunk));
        }
        const raw = Buffer.concat(buffers).toString("utf8");
        const body = parseBody(raw);
        const currentText = readCurrentProviderUserText(body);
        const completion = isCompletionUserText(currentText);
        providerRequests.push({
          model: body.model,
          requester: currentText.includes("Subagent terminal reply QA check:"),
          completion,
        });
        if (String(parseBody(raw).model).endsWith("observer-failure-fixture")) {
          observerRequests += 1;
          response.writeHead(400, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: { type: "invalid_request_error", message: "synthetic observer failure" },
            }),
          );
          return;
        }
        if (!requesterHeld && currentText.includes("Subagent terminal reply QA check:")) {
          requesterHeld = true;
          await new Promise<void>((resolve) => {
            releaseRequester = resolve;
          });
        }
        const marker = completion
          ? [deliveredMarker, cancelledMarker].find((candidate) => currentText.includes(candidate))
          : undefined;
        if (marker) {
          completions.push(marker);
          sendCompletionResponse(response, marker, completions.length);
          return;
        }
        const requesterCase = [
          ...currentText.matchAll(/Subagent terminal reply QA check: (visible|restart)/g),
        ].at(-1)?.[1];
        if (requesterCase && !slowRequesterCases.has(requesterCase)) {
          slowRequesterCases.add(requesterCase);
          // A deliberately slow provider crosses the observer's 30s final-digest
          // threshold; this is scenario input, not a wait for eventual delivery.
          await sleep(31_000);
        }
        const workerCase = /Subagent terminal reply QA worker:\s*(visible|restart)/i
          .exec(currentText)?.[1]
          ?.toLowerCase();
        if (workerCase) {
          // Child completion starts another requester run. Keep it pending until
          // the current observer records its outcome, or that run is superseded.
          await waitForFact(
            () =>
              observerFailures().length ===
              caseNames.findIndex((caseName) => caseName === workerCase) * 2 + 1,
            `${workerCase} requester observer settled before child completion`,
          );
          settledRequesterCases.push(workerCase);
        }
        const upstream = await fetch(new URL(request.url ?? "/", provider.baseUrl), {
          method: request.method,
          headers: { "content-type": "application/json" },
          ...(request.method === "POST" ? { body: raw } : {}),
        });
        response.writeHead(upstream.status, {
          "content-type": upstream.headers.get("content-type") ?? "application/json",
        });
        response.end(await upstream.text());
      })().catch(() => response.writeHead(500).end("synthetic provider proxy failed"));
    });
    await new Promise<void>((resolve) => {
      proxy.listen(0, "127.0.0.1", resolve);
    });
    cleanups.push(async () => {
      proxy.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        proxy.close((error) => (error ? reject(error) : resolve()));
      });
    });
    const address = proxy.address();
    if (!address || typeof address === "string") {
      throw new Error("provider proxy did not bind");
    }
    const owner = createQaGatewayChild();
    cleanups.push(() => stopQaGatewayFixture(owner));
    const gateway = await owner.start({
      repoRoot: process.cwd(),
      command: {
        executablePath: process.execPath,
        argsPrefix: [path.join(process.cwd(), "openclaw.mjs")],
        cwd: process.cwd(),
        usePackagedPlugins: true,
      },
      providerBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      providerMode: "mock-openai",
      primaryModel: MODEL,
      alternateModel: observerModel,
      controlUiEnabled: false,
      transportBaseUrl: api.baseUrl,
      transport: {
        requiredPluginIds: adapter.requiredPluginIds,
        createGatewayConfig: () => adapter.createGatewayConfig() as OpenClawConfig,
      },
      runtimeEnvPatch: {
        ...adapter.createProviderReadinessEnv({}),
        SLACK_API_URL: `${api.baseUrl}/api/`,
      },
      mutateConfig: (config) => ({
        ...config,
        logging: { ...config.logging, consoleStyle: "json" },
        agents: {
          ...config.agents,
          defaults: { ...config.agents?.defaults, utilityModel: observerModel },
          entries: {
            ...config.agents?.entries,
            qa: { ...config.agents?.entries?.qa, utilityModel: observerModel },
          },
        },
        plugins: {
          ...config.plugins,
          allow: [...(config.plugins?.allow ?? []), pluginId],
          load: {
            ...config.plugins?.load,
            paths: [...(config.plugins?.load?.paths ?? []), pluginDir],
          },
          entries: { ...config.plugins?.entries, [pluginId]: { enabled: true } },
        },
        channels: {
          ...config.channels,
          slack: { ...config.channels?.slack, replyToMode: "all", streaming: { mode: "off" } },
        },
      }),
    });
    cleanups.push(async () => {
      const evidenceDir = path.join(process.cwd(), ".artifacts", "channel-progress-presentation");
      await fs.mkdir(evidenceDir, { recursive: true });
      const root = inboundMessages[0];
      const mockThread =
        root && adapter.manifest.provider === "slack"
          ? asRecord(
              await (
                await fetch(`${adapter.manifest.baseUrl}/api/conversations.replies`, {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    authorization: `Bearer ${adapter.manifest.botToken}`,
                  },
                  body: JSON.stringify({ channel: root.channel, ts: root.ts, limit: 100 }),
                })
              ).json(),
            )
          : {};
      await fs.writeFile(
        path.join(evidenceDir, "slack-announcement-diagnostics.json"),
        JSON.stringify(
          {
            providerRequests,
            completions,
            tasks,
            inboundMessages,
            mockThreadMessages: Array.isArray(mockThread.messages)
              ? mockThread.messages
                  .map(asRecord)
                  .map(({ channel, ts, thread_ts }) => ({ channel, ts, thread_ts }))
              : mockThread,
            slackSends: writes
              .filter((write) => write.route.endsWith("chat.postMessage"))
              .map(({ body, accepted, rejected }) => ({
                channel: body.channel,
                thread_ts: body.thread_ts,
                text: body.text,
                accepted,
                rejected,
              })),
            logs: gateway.logs().replaceAll(gateway.token, "[redacted]"),
          },
          null,
          2,
        ),
      );
    });
    await waitForFact(async () => {
      const status = asRecord(await gateway.call("channels.status", { probe: false }));
      const accounts = asRecord(status.channelAccounts).slack;
      return (
        Array.isArray(accounts) && accounts.some((account) => asRecord(account).running === true)
      );
    }, "Slack ready");
    const observerEvents: Array<Record<string, unknown>> = [];
    const client = await connectGatewayClient({
      url: gateway.wsUrl,
      token: gateway.token,
      scopes: ["operator.admin", "operator.read", "operator.write"],
      onEvent: (event) => {
        if (event.event === "session.observer") {
          observerEvents.push(asRecord(event.payload));
        }
      },
    });
    cleanups.push(() => disconnectGatewayClient(client));
    await client.request("sessions.observer.visibility", { visible: true });
    let threadId: string | undefined;
    for (const [caseIndex, caseName] of caseNames.entries()) {
      const inbound = adapter.createInbound({
        input: {
          conversation: { id: "C12345678", kind: "group" },
          senderId: "U12345678",
          threadId,
          text: `Subagent terminal reply QA check: ${caseName}. Spawn one native worker, then finish the parent turn without waiting. Do not use ACP.`,
        },
      });
      const injected = await fetch(inbound.providerUrl, {
        method: "POST",
        headers: inbound.providerHeaders,
        body: JSON.stringify(inbound.providerBody),
      });
      expect(injected.ok).toBe(true);
      if (adapter.manifest.provider !== "slack") {
        throw new Error("expected Slack fixture");
      }
      const receipt = asRecord(await injected.json());
      const event = asRecord(asRecord(receipt.event).event);
      inboundMessages.push({ channel: event.channel, ts: event.ts, thread_ts: event.thread_ts });
      threadId ??= readStringValue(asRecord(receipt.message).ts);
      expect(threadId).toBeTypeOf("string");
      const body = JSON.stringify(receipt.event);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac("sha256", adapter.manifest.signingSecret)
        .update(`v0:${timestamp}:${body}`)
        .digest("hex");
      const delivered = await fetch(`${gateway.baseUrl}/slack/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": `v0=${signature}`,
        },
        body,
      });
      expect(delivered.ok, await delivered.text()).toBe(true);
      if (caseName === "visible") {
        await waitForFact(() => Boolean(releaseRequester), "requester model admission").catch(
          (error: unknown) => {
            throw new Error(
              `${String(error)}; requests=${JSON.stringify(providerRequests)}; logs=${gateway.logs().replaceAll(gateway.token, "[redacted]").slice(-8000)}`,
              { cause: error },
            );
          },
        );
        const listing = asRecord(await gateway.call("sessions.list", { agentId: "qa", limit: 20 }));
        const session = Array.isArray(listing.sessions)
          ? listing.sessions.map(asRecord).find((entry) => String(entry.key).includes(":slack:"))
          : undefined;
        expect(session?.key).toBeTypeOf("string");
        await client.request("sessions.messages.subscribe", { key: session!.key, agentId: "qa" });
        releaseRequester!();
      }
      let terminalTask: Record<string, unknown> | undefined;
      try {
        await waitForFact(async () => {
          const listing = asRecord(await gateway.call("tasks.list", { agentId: "qa", limit: 100 }));
          terminalTask = Array.isArray(listing.tasks)
            ? listing.tasks.map(asRecord).find((task) => task.title === `qa-terminal-${caseName}`)
            : undefined;
          return (
            terminalTask?.status === "completed" &&
            ["failed", "delivered"].includes(String(terminalTask.deliveryStatus))
          );
        }, `settled ${caseName} task`);
      } catch (error) {
        throw new Error(
          `${String(error)}; task=${JSON.stringify(terminalTask)}; completions=${JSON.stringify(completions)}; logs=${gateway.logs().slice(-6000)}`,
          { cause: error },
        );
      }
      tasks.push(terminalTask!);
      expect(terminalTask?.deliveryStatus, JSON.stringify(terminalTask)).toBe(
        caseName === "visible" ? "failed" : "delivered",
      );
      if (caseName === "visible") {
        expect(terminalTask?.error, JSON.stringify(terminalTask)).toContain(
          "cancelled_by_message_sending_hook",
        );
      }
      // Delivery settlement does not join the final observer digest. Wait before
      // admitting another turn on this session so its failure cannot be dropped.
      await waitForFact(
        () => observerFailures().length === (caseIndex + 1) * 2,
        `${caseName} completion observer settled before the next Slack turn`,
      );
    }
    expect(settledRequesterCases).toEqual(caseNames);
    expect(tasks[1]?.sessionKey).toBe(tasks[0]?.sessionKey);
    expect(completions.filter((marker) => marker === cancelledMarker)).toHaveLength(1);
    expect(
      writes.filter((write) => JSON.stringify(write.body).includes(cancelledMarker)),
    ).toHaveLength(0);
    expect(
      [...api.messages.values()].filter((message) =>
        (readStringValue(message.text) ?? "").includes(deliveredMarker),
      ),
    ).toHaveLength(1);
    expect(new Set(observerFailures().map((failure) => failure.runId)).size).toBe(4);
    // Isolated completion rejects an error stop reason before observer logging;
    // its bounded owner error, not the provider's raw body, is the recorded cause.
    expect(
      observerFailures().every((failure) =>
        String(failure.error).includes("Isolated completion failed with stop reason error"),
      ),
    ).toBe(true);
    // A failed connection can precede the proxy's HTTP receipt. Count starts at
    // the transport owner so those failures cannot hide an unbounded retry.
    expect(observerFailures().every((failure) => failure.attempts === 2)).toBe(true);
    expect(new Set(observerEvents.map((event) => event.runId)).size).toBeGreaterThanOrEqual(2);
    const evidenceDir = path.join(process.cwd(), ".artifacts", "channel-progress-presentation");
    await fs.mkdir(evidenceDir, { recursive: true });
    await fs.writeFile(
      path.join(evidenceDir, "slack-announcement-receipts.json"),
      JSON.stringify(
        {
          kind: "mock-gateway",
          channel: "slack",
          status: "pass",
          completions,
          tasks: tasks.map(({ title, status, deliveryStatus, error }) => ({
            title,
            status,
            deliveryStatus,
            error,
          })),
          suppressedSlackWrites: 0,
          deliveredSlackMessages: 1,
          observerRequests,
          observerFailures: observerFailures().map(({ message, error, runId, attempts }) => ({
            message,
            error,
            runId,
            attempts,
          })),
          observedRuns: new Set(observerEvents.map((event) => event.runId)).size,
        },
        null,
        2,
      ),
    );
  }, 240_000);

  it("retains ambiguous Discord announcement custody after an unidentified send", async () => {
    const directory = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "discord-announce-"),
    );
    cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
    const marker = "QA-SUBAGENT-TERMINAL-VISIBLE-OK";
    const writes: WireWrite[] = [];
    const adapter = await startOpenClawCrablineAdapter({
      channel: "discord",
      recorderPath: path.join(directory, "provider.jsonl"),
    });
    cleanups.push(() => adapter.close());
    const api = await startPresentationApi(adapter, writes, directory, {
      unidentifiedFinalMarker: marker,
    });
    cleanups.push(() => api.stop());
    const provider = await startQaMockOpenAiServer({ modelRefs: [MODEL] });
    cleanups.push(() => provider.stop());
    let completions = 0;
    const requesterKey = "agent:qa:discord:channel:123456789012345678";
    let requesterSessionId: string | undefined;
    let requesterSettledBeforeWorker = false;
    let parentAcknowledged = false;
    let taskRunId: string | undefined;
    let childSessionKey: string | undefined;
    const providerRequests: Array<Record<string, unknown>> = [];
    const proxy = createServer((request, response) => {
      void (async () => {
        const buffers: Buffer[] = [];
        for await (const chunk of request) {
          buffers.push(Buffer.from(chunk));
        }
        const raw = Buffer.concat(buffers).toString("utf8");
        const currentText = readCurrentProviderUserText(parseBody(raw));
        const completion = isCompletionUserText(currentText);
        const worker =
          !completion && /Subagent terminal reply QA worker:\s*visible/i.test(currentText);
        const requester =
          !completion && !worker && currentText.includes("Subagent terminal reply QA check:");
        providerRequests.push({
          requester,
          worker,
          completion,
          currentText: currentText.slice(0, 500),
        });
        if ((requester && !requesterSessionId) || worker) {
          await waitForFact(
            async () => {
              const listing = asRecord(await gateway.call("sessions.list", { limit: 100 }));
              const row = Array.isArray(listing.sessions)
                ? listing.sessions.map(asRecord).find((session) => session.key === requesterKey)
                : undefined;
              if (requester) {
                if (row?.hasActiveRun !== true || typeof row.sessionId !== "string") {
                  return false;
                }
                requesterSessionId = row.sessionId;
                return true;
              }
              // Exercise idle announcement delivery, not the active-requester handoff.
              // The exact admitted session must finish before the child provider replies.
              requesterSettledBeforeWorker = Boolean(
                requesterSessionId &&
                row?.sessionId === requesterSessionId &&
                row.hasActiveRun === false,
              );
              return requesterSettledBeforeWorker;
            },
            requester ? "requester admission" : "requester terminal before worker completion",
          );
        }
        if (completion && currentText.includes(marker)) {
          sendCompletionResponse(response, marker, ++completions);
          return;
        }
        const upstream = await fetch(new URL(request.url ?? "/", provider.baseUrl), {
          method: request.method,
          headers: { "content-type": "application/json" },
          ...(request.method === "POST" ? { body: raw } : {}),
        });
        const upstreamText = await upstream.text();
        if (requester && upstream.ok) {
          const snapshots: unknown = await fetch(`${provider.baseUrl}/debug/requests`).then(
            (snapshotResponse) => snapshotResponse.json(),
          );
          const snapshot = Array.isArray(snapshots)
            ? snapshots.map(asRecord).findLast((entry) => entry.raw === raw)
            : undefined;
          const spawned = parseBody(readStringValue(snapshot?.toolOutput) ?? "");
          const acceptedRunId = readStringValue(spawned.runId);
          const acceptedChildSessionKey = readStringValue(spawned.childSessionKey);
          if (
            snapshot?.requestKind === "tool-continuation" &&
            spawned.status === "accepted" &&
            acceptedRunId &&
            acceptedChildSessionKey
          ) {
            // A normal final acknowledgement leaves completion with the child;
            // the shared fixture's NO_REPLY intentionally yields requester custody.
            parentAcknowledged = true;
            taskRunId = acceptedRunId;
            childSessionKey = acceptedChildSessionKey;
            sendCompletionResponse(
              response,
              "The worker is running; I will send its result here.",
              0,
            );
            return;
          }
        }
        response.writeHead(upstream.status, {
          "content-type": upstream.headers.get("content-type") ?? "application/json",
        });
        response.end(upstreamText);
      })().catch(() => response.writeHead(500).end("synthetic provider proxy failed"));
    });
    await new Promise<void>((resolve) => {
      proxy.listen(0, "127.0.0.1", resolve);
    });
    cleanups.push(async () => {
      proxy.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        proxy.close((error) => (error ? reject(error) : resolve()));
      });
    });
    const address = proxy.address();
    if (!address || typeof address === "string") {
      throw new Error("provider proxy did not bind");
    }
    const owner = createQaGatewayChild();
    cleanups.push(() => stopQaGatewayFixture(owner));
    const gateway = await owner.start({
      repoRoot: process.cwd(),
      command: {
        executablePath: process.execPath,
        argsPrefix: [path.join(process.cwd(), "openclaw.mjs")],
        cwd: process.cwd(),
        usePackagedPlugins: true,
      },
      providerBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      providerMode: "mock-openai",
      primaryModel: MODEL,
      alternateModel: MODEL,
      controlUiEnabled: false,
      transportBaseUrl: api.baseUrl,
      transport: {
        requiredPluginIds: adapter.requiredPluginIds,
        createGatewayConfig: () => adapter.createGatewayConfig() as OpenClawConfig,
      },
      runtimeEnvPatch: {
        ...adapter.createProviderReadinessEnv({}),
        NODE_EXTRA_CA_CERTS: api.caPath,
      },
      mutateConfig: (config) => ({
        ...config,
        channels: {
          ...config.channels,
          discord: {
            ...config.channels?.discord,
            joinIntro: false,
            proxy: api.proxyUrl,
            streaming: { mode: "off" },
            commands: { native: false, nativeSkills: false },
          },
        },
      }),
    });
    let task: Record<string, unknown> | undefined;
    let taskRuns: unknown[] = [];
    let allTaskSummaries: unknown[] = [];
    let queued: { recoveryState?: string; lastError?: string } | undefined;
    let queueRows: unknown[] = [];
    let delivery:
      | { status?: string; disposition?: string; nextAttemptAt?: number; lastError?: string | null }
      | undefined;
    const evidenceDir = path.join(process.cwd(), ".artifacts", "channel-progress-presentation");
    cleanups.push(async () => {
      await fs.mkdir(evidenceDir, { recursive: true });
      await fs.writeFile(
        path.join(evidenceDir, "discord-announcement-diagnostics.json"),
        JSON.stringify(
          {
            task,
            taskRuns,
            taskRunId,
            childSessionKey,
            allTaskSummaries,
            requesterSessionId,
            requesterSettledBeforeWorker,
            parentAcknowledged,
            providerRequests,
            upstreamRequests: await fetch(`${provider.baseUrl}/debug/requests`).then(
              async (response) => {
                const requests: unknown = await response.json();
                return Array.isArray(requests)
                  ? requests.map((request) => {
                      const record = asRecord(request);
                      const args = asRecord(record.plannedToolArgs);
                      return {
                        requestKind: record.requestKind,
                        plannedToolName: record.plannedToolName,
                        label: args.label,
                        task: readStringValue(args.task)?.slice(0, 300),
                      };
                    })
                  : [];
              },
            ),
            queued,
            queueRows,
            delivery,
            completions,
            writes,
            logs: gateway.logs().replaceAll(gateway.token, "[redacted]"),
          },
          null,
          2,
        ),
      );
    });
    await waitForFact(async () => {
      const status = asRecord(await gateway.call("channels.status", { probe: false }));
      const accounts = asRecord(status.channelAccounts).discord;
      return (
        Array.isArray(accounts) && accounts.some((account) => asRecord(account).connected === true)
      );
    }, "Discord ready");
    const inbound = adapter.createInbound({
      input: {
        conversation: { id: "123456789012345678", kind: "group" },
        senderId: "123456789012345679",
        text: "Subagent terminal reply QA check: visible. Spawn one native worker, then finish the parent turn without waiting. Do not use ACP.",
      },
    });
    const injected = await fetch(inbound.providerUrl, {
      method: "POST",
      headers: inbound.providerHeaders,
      body: JSON.stringify(inbound.providerBody),
    });
    expect(injected.ok, await injected.text()).toBe(true);
    const { loadUnfinishedDeliveries } =
      await import("../../../../src/infra/outbound/delivery-queue-storage.js");
    const stateDir = gateway.runtimeEnv.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("isolated Gateway state directory missing");
    }
    const { openOpenClawStateDatabase, closeOpenClawStateDatabaseByPath } =
      await import("../../../../src/state/openclaw-state-db.js");
    const { readSubagentRun } =
      await import("../../../../src/agents/subagents/registry/subagent-registry.store.sqlite.js");
    const database = openOpenClawStateDatabase({ env: gateway.runtimeEnv });
    cleanups.push(async () => {
      closeOpenClawStateDatabaseByPath(database.path);
    });
    await waitForFact(async () => {
      const listing = asRecord(await gateway.call("tasks.list", { agentId: "qa", limit: 100 }));
      allTaskSummaries = Array.isArray(listing.tasks)
        ? listing.tasks.map((entry) => {
            const record = asRecord(entry);
            return {
              runId: record.runId,
              title: record.title,
              status: record.status,
              deliveryStatus: record.deliveryStatus,
            };
          })
        : [];
      const tasks = Array.isArray(listing.tasks)
        ? listing.tasks.map(asRecord).filter((entry) => entry.runId === taskRunId)
        : [];
      taskRuns = tasks.map(({ runId, status, deliveryStatus }) => ({
        runId,
        status,
        deliveryStatus,
      }));
      task = tasks.find((entry) => entry.runId === taskRunId);
      const run = taskRunId ? readSubagentRun(database, taskRunId) : undefined;
      delivery =
        run?.childSessionKey === childSessionKey && run?.delivery
          ? {
              status: run.delivery.status,
              disposition: run.delivery.disposition,
              nextAttemptAt: run.delivery.nextAttemptAt,
              lastError: run.delivery.lastError,
            }
          : undefined;
      const pendingRows = await loadUnfinishedDeliveries(stateDir);
      queueRows = pendingRows.map(({ id, channel, to, recoveryState, lastError }) => ({
        id,
        channel,
        to,
        recoveryState,
        lastError,
      }));
      const pending = pendingRows.find(
        (entry) =>
          entry.channel === "discord" &&
          entry.lastError === "platform send returned no delivery identity",
      );
      queued = pending
        ? { recoveryState: pending.recoveryState, lastError: pending.lastError }
        : undefined;
      return (
        task?.status === "completed" &&
        delivery?.disposition === "ambiguous" &&
        typeof delivery.nextAttemptAt === "number" &&
        Boolean(queued) &&
        gateway.logs().includes("automatic completion delivery could not be confirmed")
      );
    }, "ambiguous announcement settlement");
    expect(delivery?.status).toBe("pending");
    expect(requesterSettledBeforeWorker).toBe(true);
    expect(parentAcknowledged).toBe(true);
    expect(taskRuns).toHaveLength(1);
    expect(queued?.recoveryState).toBe("unknown_after_send");
    expect(writes.filter((write) => write.identityOmitted)).toHaveLength(1);
    expect(
      [...api.messages.values()].filter((message) =>
        (readStringValue(message.content) ?? "").includes(marker),
      ),
    ).toHaveLength(1);
    expect(completions).toBe(1);
    await fs.mkdir(evidenceDir, { recursive: true });
    await fs.writeFile(
      path.join(evidenceDir, "discord-announcement-receipts.json"),
      JSON.stringify(
        {
          kind: "mock-gateway",
          channel: "discord",
          status: "pass",
          taskDeliveryStatus: task?.deliveryStatus,
          delivery,
          queued,
          acceptedMessages: 1,
          omittedResponseIdentities: 1,
          completions,
        },
        null,
        2,
      ),
    );
  }, 180_000);

  it.each([
    { channel: "discord" as const, native: false, thread: "root", rejectStop: false, tools: true },
    { channel: "discord" as const, native: false, thread: "root", rejectStop: false, tools: false },
    { channel: "slack" as const, native: true, thread: "root", rejectStop: false, tools: true },
    { channel: "slack" as const, native: true, thread: "root", rejectStop: false, tools: false },
    { channel: "slack" as const, native: false, thread: "root", rejectStop: false, tools: true },
    { channel: "slack" as const, native: false, thread: "root", rejectStop: false, tools: false },
    { channel: "slack" as const, native: true, thread: "root", rejectStop: true, tools: true },
    { channel: "slack" as const, native: false, thread: "reply", rejectStop: false, tools: true },
    { channel: "slack" as const, native: false, thread: "current", rejectStop: false, tools: true },
  ])(
    "renders $channel progress (native=$native, thread=$thread, rejectStop=$rejectStop, toolProgress=$tools)",
    async ({ channel, native, thread, rejectStop, tools }) => {
      const directory = await fs.mkdtemp(
        path.join(await fs.realpath(os.tmpdir()), "channel-progress-"),
      );
      cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
      const writes: WireWrite[] = [];
      const adapter = await startOpenClawCrablineAdapter({
        channel,
        recorderPath: path.join(directory, "provider.jsonl"),
      });
      cleanups.push(() => adapter.close());
      let originCleared = false;
      const api = await startPresentationApi(adapter, writes, directory, {
        rejectStop,
        clearOrigin: async () => {
          await clearOrigin();
          originCleared = true;
        },
      });
      cleanups.push(() => api.stop());
      const provider = await startQaMockOpenAiServer({ modelRefs: [MODEL] });
      cleanups.push(() => provider.stop());
      const owner = createQaGatewayChild();
      cleanups.push(() => stopQaGatewayFixture(owner));
      const environment = adapter.createProviderReadinessEnv({});
      if (channel === "slack") {
        environment.SLACK_API_URL = `${api.baseUrl}/api/`;
      } else {
        environment.NODE_EXTRA_CA_CERTS = api.caPath;
      }
      const gateway = await owner.start({
        repoRoot: process.cwd(),
        // The E2E runner owns the build; child startups must not rebuild dist
        // beneath already-running test workers when the source tree is dirty.
        command: {
          executablePath: process.execPath,
          argsPrefix: [path.join(process.cwd(), "openclaw.mjs")],
          cwd: process.cwd(),
          usePackagedPlugins: true,
        },
        providerBaseUrl: `${provider.baseUrl}/v1`,
        providerMode: "mock-openai",
        primaryModel: MODEL,
        alternateModel: MODEL,
        controlUiEnabled: false,
        transportBaseUrl: api.baseUrl,
        transport: {
          requiredPluginIds: adapter.requiredPluginIds,
          createGatewayConfig: () => adapter.createGatewayConfig() as OpenClawConfig,
        },
        runtimeEnvPatch: environment,
        mutateConfig: (config) => {
          const configured = progressConfig(config, channel, native, tools);
          if (channel === "discord") {
            configured.channels!.discord!.proxy = api.proxyUrl;
            const qa = configured.agents!.entries!.qa!;
            qa.tools = {
              ...qa.tools,
              alsoAllow: [...(qa.tools?.alsoAllow ?? []), "message"],
            };
          }
          return configured;
        },
      });
      await waitForFact(async () => {
        const status = asRecord(await gateway.call("channels.status", { probe: false }));
        const accounts = asRecord(status.channelAccounts)[channel];
        return (
          Array.isArray(accounts) &&
          accounts.some((account) => {
            const state = asRecord(account);
            return state.running === true && (channel !== "discord" || state.connected === true);
          })
        );
      }, `${channel} ready`);
      const clearOrigin = async () => {
        const scope = {
          agentId: "qa",
          env: gateway.runtimeEnv,
          readConsistency: "latest" as const,
        };
        const sessions = listSessionEntriesReadOnly(scope).filter(
          ({ entry }) =>
            entry.delivery?.kind === "external" &&
            entry.delivery.context.channel === "slack" &&
            entry.delivery.context.to?.includes("C12345678"),
        );
        expect(sessions).toHaveLength(1);
        const { sessionKey, entry } = sessions[0]!;
        const target = { ...scope, sessionKey };
        await updateSessionEntry(
          target,
          (current) => {
            expect(current.sessionId).toBe(entry.sessionId);
            return { delivery: { kind: "none" }, updatedAt: Date.now() };
          },
          { skipMaintenance: true, requireWriteSuccess: true },
        );
        expect(loadSessionEntryReadOnly(target)?.delivery).toEqual({ kind: "none" });
      };
      let expectedThreadTs: unknown;
      const injectProviderMessage = async (text: string, threadId?: string) => {
        const inbound = adapter.createInbound({
          input: {
            conversation: {
              id: channel === "slack" ? "C12345678" : "123456789012345678",
              kind: "group",
            },
            senderId: channel === "slack" ? "U12345678" : "123456789012345679",
            text,
            ...(threadId ? { threadId } : {}),
          },
        });
        const injected = await fetch(inbound.providerUrl, {
          method: "POST",
          headers: inbound.providerHeaders,
          body: JSON.stringify(inbound.providerBody),
        });
        expect(injected.ok).toBe(true);
        return injected;
      };
      let threadId: string | undefined;
      let inboundMessageId: unknown;
      if (thread !== "root") {
        // Seed only the provider's root; the Gateway receives the child below.
        const root = asRecord(await (await injectProviderMessage("Original Slack thread")).json());
        threadId = readStringValue(asRecord(root.message).ts);
        expect(threadId).toEqual(expect.any(String));
      }
      const finalText = `${thread === "current" ? "[[reply_to_current]] " : ""}${FINAL_MARKER}`;
      const injected = await injectProviderMessage(
        `Tool progress QA check: call the exec tool exactly once with this exact command before answering: \`sleep 3\`. After that command completes, reply exactly \`${finalText}\`.`,
        threadId,
      );
      if (adapter.manifest.provider === "slack") {
        const payload = asRecord(await injected.json());
        const event = asRecord(asRecord(payload.event).event);
        expectedThreadTs = event.thread_ts ?? event.ts;
        inboundMessageId = event.ts;
        if (threadId) {
          expect(event.thread_ts).toBe(threadId);
          expect(inboundMessageId).not.toBe(threadId);
        }
        const body = JSON.stringify(payload.event);
        const timestamp = String(Math.floor(Date.now() / 1000));
        const signature = createHmac("sha256", adapter.manifest.signingSecret)
          .update(`v0:${timestamp}:${body}`)
          .digest("hex");
        const delivered = await fetch(`${gateway.baseUrl}/slack/events`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-slack-request-timestamp": timestamp,
            "x-slack-signature": `v0=${signature}`,
          },
          body,
        });
        expect(delivered.ok, await delivered.text()).toBe(true);
      } else {
        await injected.arrayBuffer();
      }
      const finalWrites = () =>
        writes.filter((write) => JSON.stringify(write.body).includes(FINAL_MARKER));
      const finalMessages = () =>
        [...api.messages.values()].filter((message) =>
          (readStringValue(message.text ?? message.content) ?? "").includes(FINAL_MARKER),
        );
      if (threadId) {
        await waitForFact(() => finalWrites().length > 0, "thread reply attempt");
        expect(finalWrites()[0]?.body.thread_ts).toBe(threadId);
      }
      if (!rejectStop) {
        await waitForFact(() => finalMessages().length > 0, "accepted final answer");
      }
      await waitForFact(
        () =>
          channel === "discord"
            ? writes.some(
                (write) => write.method === "DELETE" && !write.route.includes("/reactions/"),
              )
            : native
              ? writes.some((write) => write.route.endsWith("chat.stopStream"))
              : writes.some((write) => write.route.endsWith("chat.update")),
        "progress finalization",
      );

      const progressWrites = writes.filter(
        (write) =>
          !JSON.stringify(write.body).includes(FINAL_MARKER) &&
          (channel === "discord"
            ? /\/messages(?:\/\d+)?$/u.test(write.route) && ["POST", "PATCH"].includes(write.method)
            : /chat\.(?:postMessage|update|startStream|appendStream)$/u.test(write.route)),
      );
      expect(progressWrites.length).toBeGreaterThan(0);
      const progressText = progressWrites
        .map(({ body }) =>
          channel === "discord"
            ? (readStringValue(body.content) ?? "")
            : [
                body.text,
                JSON.stringify(readChunks(body.blocks)),
                JSON.stringify(readChunks(body.chunks)),
              ]
                .filter(Boolean)
                .join("\n"),
        )
        .join("\n");
      expect(progressText).toContain(HEADLINE);
      if (tools) {
        expect(progressText).toMatch(toolRow);
      } else {
        expect(progressText).not.toMatch(toolRow);
      }
      const reactionAdds = writes.filter((write) =>
        channel === "discord"
          ? write.method === "PUT" && write.route.includes("/reactions/")
          : write.route.endsWith("reactions.add"),
      );
      const reactionNames = new Set(
        reactionAdds.map((write) =>
          channel === "discord"
            ? decodeURIComponent(write.route.split("/reactions/")[1]!.split("/")[0]!)
            : String(write.body.name),
        ),
      );
      expect([...reactionNames]).toEqual([channel === "discord" ? "👀" : "eyes"]);
      const evidenceDir = path.join(process.cwd(), ".artifacts", "channel-progress-presentation");
      const evidenceName = `${channel}-${native ? "native" : "draft"}-${thread}${rejectStop ? "-stop-failure" : ""}${tools ? "" : "-quiet"}`;
      await fs.mkdir(evidenceDir, { recursive: true });
      await fs.writeFile(
        path.join(evidenceDir, `${evidenceName}-diagnostic.json`),
        JSON.stringify(
          {
            rejectStop,
            originCleared,
            writes: writes.slice(-80).map(({ at, method, route, body, accepted }) => ({
              at,
              method,
              route: route.slice(0, 250),
              markerFields: Object.entries(body)
                .filter(([, value]) => JSON.stringify(value)?.includes(FINAL_MARKER))
                .map(([key]) => key),
              rendered: Object.fromEntries(
                ["content", "text", "blocks", "chunks"]
                  .filter((key) => body[key] !== undefined)
                  .map((key) => [
                    key,
                    (typeof body[key] === "string" ? body[key] : JSON.stringify(body[key])).slice(
                      0,
                      250,
                    ),
                  ]),
              ),
              accepted,
            })),
            acceptedMessages: [...api.messages].slice(-80).map(([id, message]) => ({
              id,
              text: (readStringValue(message.text ?? message.content) ?? "").slice(0, 250),
            })),
          },
          null,
          2,
        ),
      );
      expect(finalWrites()).toHaveLength(1);
      expect(finalMessages()).toHaveLength(1);
      if (rejectStop) {
        expect(originCleared).toBe(true);
        expect(expectedThreadTs).toEqual(expect.any(String));
        expect(finalMessages()[0]).toMatchObject({
          channel: "C12345678",
          thread_ts: expectedThreadTs,
        });
        expect(finalWrites()[0]?.accepted).toBeDefined();
      }
      if (threadId) {
        expect(finalMessages()[0]?.thread_ts).toBe(threadId);
      }
      const tasks = writes
        .flatMap((write) => readChunks(write.body.chunks))
        .filter((chunk) => chunk.type === "task_update");
      if (native) {
        // Detailed cards give the exec call its own task row; quiet cards keep
        // one stable summary row. Both complete with the turn.
        expect(tasks.some((task) => toolRow.test(String(task.title)))).toBe(tools);
        if (!tools) {
          expect(new Set(tasks.map((task) => task.id)).size).toBe(1);
        }
        expect(tasks.at(-1)?.status).toBe("complete");
      }
      await fs.writeFile(
        path.join(evidenceDir, `${evidenceName}.json`),
        JSON.stringify(
          {
            kind: "mock-gateway",
            channel,
            native,
            rejectStop,
            originCleared,
            thread,
            threadId,
            inboundMessageId,
            status: "pass",
            progressWrites: progressWrites.length,
            finalWrites: finalWrites().length,
            distinctWorkingReactions: reactionNames.size,
            taskIds: new Set(tasks.map((task) => task.id)).size,
            toolRows: tools,
          },
          null,
          2,
        ),
      );
      if (channel === "discord") {
        const text = [
          "QA-PREFIX-REPORT",
          ...Array.from(
            { length: 80 },
            (_, index) =>
              `Section ${String(index).padStart(3, "0")} 😀 e\u0301: reviewed and ready.`,
          ),
          "QA-PREFIX-END",
        ].join("\n");
        expect(Array.from(text).length).toBeGreaterThan(1997);
        const client = await connectGatewayClient({
          url: gateway.wsUrl,
          token: gateway.token,
          scopes: ["operator.admin", "operator.read", "operator.write"],
        });
        cleanups.push(() => disconnectGatewayClient(client));
        const firstWrite = writes.length;
        const sent = asRecord(
          await client.request("tools.invoke", {
            name: "message",
            agentId: "qa",
            sessionKey: "agent:qa:discord:channel:123456789012345678",
            args: {
              action: "send",
              channel: "discord",
              target: "channel:123456789012345678",
              presentation: { blocks: [{ type: "text", text }] },
            },
          }),
        );
        expect(sent.ok).toBe(true);
        const portableWrites = () =>
          writes
            .slice(firstWrite)
            .filter(
              (write) => write.method === "POST" && /\/channels\/\d+\/messages$/u.test(write.route),
            );
        await waitForFact(
          () => portableWrites().some((write) => write.accepted),
          "portable presentation accepted",
        );
        expect(portableWrites()).toHaveLength(1);
        const write = portableWrites()[0]!;
        expect(write.accepted?.id).toEqual(expect.any(String));
        const containers = readChunks(write.body.components);
        expect(containers).toHaveLength(1);
        // Discord wire types are Container (17) and TextDisplay (10).
        expect(containers[0]?.type).toBe(17);
        const displays = readChunks(containers[0]?.components);
        expect(displays.length).toBeGreaterThan(1);
        for (const display of displays) {
          expect(display.type).toBe(10);
          expect(display.content).toEqual(expect.any(String));
          expect(Array.from(String(display.content)).length).toBeLessThanOrEqual(1997);
        }
        expect(displays.map((display) => display.content).join("")).toBe(text);
        await fs.writeFile(
          path.join(evidenceDir, `discord-portable-prefix-tool-progress-${tools}.json`),
          JSON.stringify(
            {
              kind: "mock-gateway",
              status: "pass",
              expectedText: text,
              body: write.body,
              accepted: write.accepted,
            },
            null,
            2,
          ),
        );
      }
    },
    180_000,
  );
});
