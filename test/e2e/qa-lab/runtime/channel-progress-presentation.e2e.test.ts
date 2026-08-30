import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startOpenClawCrablineAdapter } from "@openclaw/crabline";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  createQaGatewayChild,
  startQaMockOpenAiServer,
} from "../../../../extensions/qa-lab/api.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

const MODEL = "mock-openai/progress-fixture";
const FINAL_MARKER = "QUIET-PROGRESS-FINAL";
const HEADLINE = "Checking the requested work";
const synthesizedDecoration =
  /\p{Extended_Pictographic}|\b(?:Exec|Bash)\b|\btool calls?\b|elapsed/iu;
type WireWrite = {
  at: number;
  method: string;
  route: string;
  body: Record<string, unknown>;
  accepted?: { id: string; action: string; text: string };
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
          text: String(message?.text ?? message?.content ?? "").slice(0, 250),
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
          if (operation !== "chat.startStream" && !messages.has(ts)) {
            reply({ ok: false, error: "message_not_found" });
            return;
          }
          const previous = messages.get(ts) ?? { text: "" };
          const text = readChunks(body.chunks)
            .filter((chunk) => chunk.type === "markdown_text")
            .map((chunk) => String(chunk.text ?? ""))
            .join("");
          messages.set(ts, { ...previous, text: String(previous.text ?? "") + text });
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
      const responseText = await upstream.text();
      if (upstream.ok && method === "POST") {
        const result = parseBody(responseText);
        if (
          manifest.provider === "discord" &&
          /\/channels\/\d+\/messages$/u.test(route) &&
          typeof result.id === "string"
        ) {
          messages.set(result.id, result);
          recordAccepted(result.id, "sent");
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
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
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
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
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

function progressConfig(
  config: OpenClawConfig,
  channel: "discord" | "slack",
  native: boolean,
): OpenClawConfig {
  const streaming = {
    mode: "progress" as const,
    progress: { label: HEADLINE },
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
      removeAckAfterReply: true,
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

  it.each([
    { channel: "discord" as const, native: false },
    { channel: "slack" as const, native: true },
    { channel: "slack" as const, native: false },
  ])(
    "keeps $channel progress quiet (native=$native)",
    async ({ channel, native }) => {
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
      const api = await startPresentationApi(adapter, writes, directory);
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
        useRepoCli: true,
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
          const configured = progressConfig(config, channel, native);
          if (channel === "discord") {
            configured.channels!.discord!.proxy = api.proxyUrl;
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
      const inbound = adapter.createInbound({
        input: {
          conversation: {
            id: channel === "slack" ? "C12345678" : "123456789012345678",
            kind: "group",
          },
          senderId: channel === "slack" ? "U12345678" : "123456789012345679",
          text: `Tool progress QA check: call the exec tool exactly once with this exact command before answering: \`sleep 3\`. After that command completes, reply exactly \`${FINAL_MARKER}\`.`,
        },
      });
      const injected = await fetch(inbound.providerUrl, {
        method: "POST",
        headers: inbound.providerHeaders,
        body: JSON.stringify(inbound.providerBody),
      });
      expect(injected.ok).toBe(true);
      if (adapter.manifest.provider === "slack") {
        const payload = asRecord(await injected.json());
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
        expect(delivered.ok).toBe(true);
      } else {
        await injected.arrayBuffer();
      }
      const finalWrites = () =>
        writes.filter((write) => JSON.stringify(write.body).includes(FINAL_MARKER));
      const finalMessages = () =>
        [...api.messages.values()].filter((message) =>
          String(message.text ?? message.content ?? "").includes(FINAL_MARKER),
        );
      await waitForFact(() => finalMessages().length > 0, "accepted final answer");
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
            ? String(body.content ?? "")
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
      expect(progressText).not.toMatch(synthesizedDecoration);
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
      await fs.mkdir(evidenceDir, { recursive: true });
      await fs.writeFile(
        path.join(evidenceDir, `${channel}-${native ? "native" : "draft"}-diagnostic.json`),
        JSON.stringify(
          {
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
                    String(
                      typeof body[key] === "string" ? body[key] : JSON.stringify(body[key]),
                    ).slice(0, 250),
                  ]),
              ),
              ...(accepted ? { accepted } : {}),
            })),
            acceptedMessages: [...api.messages].slice(-80).map(([id, message]) => ({
              id,
              text: String(message.text ?? message.content ?? "").slice(0, 250),
            })),
          },
          null,
          2,
        ),
      );
      expect(finalWrites()).toHaveLength(1);
      expect(finalMessages()).toHaveLength(1);
      const tasks = writes
        .flatMap((write) => readChunks(write.body.chunks))
        .filter((chunk) => chunk.type === "task_update");
      if (native) {
        expect(new Set(tasks.map((task) => task.id)).size).toBe(1);
        expect(new Set(tasks.map((task) => task.title)).size).toBe(1);
        expect(tasks.at(-1)?.status).toBe("complete");
      }
      await fs.writeFile(
        path.join(evidenceDir, `${channel}-${native ? "native" : "draft"}.json`),
        JSON.stringify(
          {
            kind: "mock-gateway",
            channel,
            native,
            status: "pass",
            progressWrites: progressWrites.length,
            finalWrites: finalWrites().length,
            distinctWorkingReactions: reactionNames.size,
            taskIds: new Set(tasks.map((task) => task.id)).size,
            syntheticDecoration: false,
          },
          null,
          2,
        ),
      );
    },
    180_000,
  );
});
