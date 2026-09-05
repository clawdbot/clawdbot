#!/usr/bin/env node
// Trusted observer only. Candidate shares a network, never this filesystem.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  OPENCLAW_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH,
  OPENCLAW_CRABLINE_PROVIDER_READINESS_PATH,
} from "@openclaw/crabline";
import { z } from "zod";
import { createQaCrablineTransportAdapter } from "../../extensions/qa-lab/src/crabline-transport.ts";
import { startQaGatewayRpcClient } from "../../extensions/qa-lab/src/gateway-rpc-client.ts";
import { readQaScenarioById } from "../../extensions/qa-lab/src/scenario-catalog.ts";
import { runScenarioFlow } from "../../extensions/qa-lab/src/scenario-flow-runner.ts";
import { runQaSuiteScenarioSteps } from "../../extensions/qa-lab/src/suite-runtime-flow.ts";
import {
  telegramQaObservationsSchema,
  telegramQaResultSchema,
  telegramQaScenario,
} from "./telegram-qa-proof.ts";

const output = path.resolve(process.argv[2] ?? "/out");
const scenario = readQaScenarioById(telegramQaScenario);
if (scenario.execution.kind !== "flow" || !scenario.execution.flow) {
  throw new Error("Trusted QA recipe is not a flow");
}
const transport = await createQaCrablineTransportAdapter({
  outputDir: output,
  selection: {
    channel: "telegram",
    channelDriver: "crabline",
    capabilityMatrixPath: OPENCLAW_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH,
    providerReadinessArtifactPath: OPENCLAW_CRABLINE_PROVIDER_READINESS_PATH,
  },
});
const channelConfig = transport.createGatewayConfig({ baseUrl: "http://127.0.0.1" });
const channel = z
  .object({ apiRoot: z.string().url(), botToken: z.string().min(1) })
  .parse(channelConfig.channels?.telegram);
const upstream = new URL(channel.apiRoot);
if (upstream.hostname !== "127.0.0.1" || upstream.protocol !== "http:") {
  throw new Error("Crabline must remain loopback-only");
}
const token = randomUUID();
const config = {
  ...channelConfig,
  gateway: {
    mode: "local",
    bind: "lan",
    port: 19879,
    auth: { mode: "token", token },
    controlUi: { enabled: false },
  },
  logging: { file: "/state/gateway.log" },
  plugins: { enabled: true, allow: ["telegram"], entries: { telegram: { enabled: true } } },
  channels: {
    ...channelConfig.channels,
    telegram: { ...channelConfig.channels?.telegram, apiRoot: "http://proof-observer:18080" },
  },
};
// Only Bot API methods cross the container boundary. The candidate cannot call
// Crabline's admin/input/reset endpoints or write its recorder/evidence files.
const methods = new Set([
  "getMe",
  "getUpdates",
  "getWebhookInfo",
  "deleteWebhook",
  "setMyCommands",
  "deleteMyCommands",
  "getMyCommands",
  "sendMessage",
  "sendChatAction",
]);
let invalid = false,
  requests = 0;
const bridge = http.createServer((request, response) => {
  void (async () => {
    const prefix = `/bot${channel.botToken}/`;
    if (
      invalid ||
      ++requests > 1024 ||
      request.method !== "POST" ||
      !request.url?.startsWith(prefix) ||
      !methods.has(request.url.slice(prefix.length))
    ) {
      throw new Error("Unsupported Bot API request");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const part of request) {
      size += part.length;
      if (size > 65536) {
        throw new Error("Oversized Bot API payload");
      }
      chunks.push(Buffer.from(part));
    }
    const result = await fetch(new URL(request.url, upstream), {
      method: "POST",
      headers: { "content-type": request.headers["content-type"] ?? "application/json" },
      body: Buffer.concat(chunks),
      redirect: "error",
      signal: AbortSignal.timeout(35_000),
    });
    const bytes = Buffer.from(await result.arrayBuffer());
    if (bytes.length > 1024 * 1024) {
      throw new Error("Oversized Bot API response");
    }
    response.writeHead(result.status, { "content-type": "application/json" });
    response.end(bytes);
  })().catch(() => {
    invalid = true;
    response.writeHead(403);
    response.end();
  });
});
let rpc: Awaited<ReturnType<typeof startQaGatewayRpcClient>> | undefined;
try {
  await new Promise<void>((resolve, reject) => {
    bridge.once("error", reject);
    bridge.listen(18080, "0.0.0.0", resolve);
  });
  await fs.writeFile(path.join(output, "candidate-config.json"), JSON.stringify(config), {
    flag: "wx",
  });
  const until = Date.now() + 90_000;
  const waitForGatewayHealthy = async () => {
    while (true) {
      if (invalid) {
        throw new Error("Candidate crossed the Bot API boundary");
      }
      try {
        const response = await fetch("http://proof-candidate:19879/readyz", {
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok) {
          await response.body?.cancel();
          return;
        }
        await response.body?.cancel();
      } catch {
        /* The controller starts the candidate after receiving its config. */
      }
      if (Date.now() >= until) {
        throw new Error("Candidate Gateway did not become ready");
      }
      await sleep(100);
    }
  };
  await waitForGatewayHealthy();
  rpc = await startQaGatewayRpcClient({
    wsUrl: "ws://proof-candidate:19879",
    token,
    logs: () => "",
  });
  const client = rpc;
  const gateway = { call: (...args: Parameters<typeof client.request>) => client.request(...args) };
  const env = { gateway, cfg: config, providerMode: "mock-openai", outputDir: output };
  const vars: Record<string, unknown> = {};
  const result = await runScenarioFlow({
    scenarioTitle: scenario.title,
    flow: scenario.execution.flow,
    vars,
    api: {
      scenario,
      config: scenario.execution.config ?? {},
      state: transport.state,
      transport,
      env,
      fs,
      path,
      randomUUID,
      sleep,
      signal: AbortSignal.timeout(180_000),
      waitForGatewayHealthy,
      waitForTransportReady: () => transport.waitReady({ gateway, timeoutMs: 60_000 }),
      runScenario: runQaSuiteScenarioSteps,
    },
  });
  if (invalid) {
    throw new Error("Candidate crossed the Bot API boundary");
  }
  // Copy only complete synthetic observations. Raw logs and absolute paths stay
  // private; an interrupted flow cannot become conclusive failure evidence.
  const rawCases = z
    .array(
      z
        .object({
          acceptedPayloads: z.array(
            z
              .object({
                text: z.string(),
                parseMode: z.string().optional(),
              })
              .strict(),
          ),
        })
        .passthrough(),
    )
    .parse(vars.proofs);
  const observed = telegramQaObservationsSchema.parse({
    schema: "mantis.telegram-qa-observations.v1",
    scenario: telegramQaScenario,
    cases: rawCases.map((item) =>
      Object.assign(item, {
        acceptedPayloads: item.acceptedPayloads.map((payload) => ({
          text: payload.text,
          parseMode: payload.parseMode ?? null,
        })),
      }),
    ),
  });
  const verdict = telegramQaResultSchema.parse({
    schema: "mantis.telegram-qa-result.v1",
    scenario: telegramQaScenario,
    status: result.status,
    steps: result.steps.map(({ name, status }) => ({ name, status })),
  });
  await fs.writeFile(path.join(output, "qa-observations.json"), JSON.stringify(observed) + "\n", {
    flag: "wx",
  });
  await fs.writeFile(path.join(output, "qa-result.json"), JSON.stringify(verdict) + "\n", {
    flag: "wx",
  });
} finally {
  await rpc?.stop();
  bridge.closeAllConnections();
  await new Promise<void>((resolve) => {
    bridge.close(() => resolve());
  });
  await transport.cleanup();
}
