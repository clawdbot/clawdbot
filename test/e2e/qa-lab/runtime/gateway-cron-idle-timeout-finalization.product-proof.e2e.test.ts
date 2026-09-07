import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createQaBusState,
  createQaChannelTransport,
  createQaGatewayChild,
  startQaBusServer,
} from "../../../../extensions/qa-lab/api.js";
import { writeOpenAiResponsesSse } from "../../../helpers/openai-responses-sse.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

// Product proof for #141032: a scheduled run whose model stream stalls after a
// settled tool batch must end as a failed run. Summary recovery that produces
// no answer cannot turn the idle timeout into a successful fallback report.
const MODEL_REF = "mock-openai/gpt-5.6-luna";
const PROMPT = "Write proof-note.txt with the word settled, then report what you did.";
const NOTE_FILE = "proof-note.txt";
const JOB_NAME = "idle-timeout-finalization-proof";
const ANNOUNCE_CONVERSATION = { id: "idle-timeout-proof-announce", kind: "direct" as const };
const PROVIDER_IDLE_TIMEOUT_SECONDS = 8;
const RUN_TIMEOUT_SECONDS = 120;
const RUN_WAIT_MS = 100_000;
// Source-mode Gateway startup with packaged plugins can take a few minutes on slow hosts.
const TEST_TIMEOUT_MS = RUN_WAIT_MS + 500_000;
const SETTLED_TOOL_FINALIZATION_FALLBACK_TEXT =
  "The tool run finished, but no final summary was produced. I did not repeat any completed actions.";
// Optional Control UI capture of the Automations run history for the proof record.
const SCREENSHOT_DIR = process.env.OPENCLAW_CRON_IDLE_TIMEOUT_FINALIZATION_SCREENSHOT_DIR?.trim();
const PROOF_LABEL = process.env.OPENCLAW_PROOF_HEAD_SHA?.trim() || "local-checkout";
// Optional built CLI entry (for example dist/entry.js) to run instead of the tsx source entry.
const GATEWAY_ENTRY = process.env.OPENCLAW_CRON_IDLE_TIMEOUT_FINALIZATION_GATEWAY_ENTRY?.trim();

type ProviderRequest = {
  seq: number;
  kind: "tool-call" | "stalled" | "finalization";
  startedAt: number;
  clientClosedAt?: number;
};

type CronRunEntry = {
  status?: unknown;
  completionStatus?: unknown;
  error?: unknown;
  summary?: unknown;
  delivered?: unknown;
  deliveryStatus?: unknown;
  runId?: unknown;
  durationMs?: unknown;
};

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
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "cron idle-timeout finalization proof cleanup failed");
  }
});

function writeFunctionCall(response: ServerResponse, seq: number): void {
  const args = JSON.stringify({ path: NOTE_FILE, content: "settled" });
  const item = {
    type: "function_call",
    id: `fc_idle_timeout_proof_${seq}`,
    call_id: `call_idle_timeout_proof_${seq}`,
    name: "write",
    arguments: args,
  };
  writeOpenAiResponsesSse(response, [
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    {
      type: "response.function_call_arguments.delta",
      item_id: item.id,
      output_index: 0,
      delta: args,
    },
    {
      type: "response.function_call_arguments.done",
      item_id: item.id,
      output_index: 0,
      name: item.name,
      arguments: args,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_idle_timeout_proof_${seq}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 32, output_tokens: 12, total_tokens: 44 },
      },
    },
  ]);
}

function writeEmptyAssistant(response: ServerResponse, seq: number): void {
  // Summary recovery answers with a completed message that carries no text.
  const message = {
    type: "message",
    id: `msg_idle_timeout_proof_empty_${seq}`,
    role: "assistant",
    status: "completed",
    content: [],
  };
  writeOpenAiResponsesSse(response, [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress" },
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: `resp_idle_timeout_proof_empty_${seq}`,
        status: "completed",
        output: [message],
        usage: { input_tokens: 8, output_tokens: 0, total_tokens: 8 },
      },
    },
  ]);
}

async function startControlledProvider() {
  const requests: ProviderRequest[] = [];
  let releaseStalled: (() => void) | undefined;
  const stalledGate = new Promise<void>((resolve) => {
    releaseStalled = resolve;
  });
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "gpt-5.6-luna", object: "model" }] }));
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        tools?: unknown[];
        input?: unknown;
      };
      const toolsOffered = Array.isArray(body.tools) && body.tools.length > 0;
      const inputText = JSON.stringify(body.input ?? []);
      const seq = requests.length + 1;
      if (!toolsOffered) {
        // Isolated settled-turn finalization runs with tools disabled.
        requests.push({ seq, kind: "finalization", startedAt: Date.now() });
        writeEmptyAssistant(response, seq);
        return;
      }
      if (!inputText.includes("function_call_output")) {
        requests.push({ seq, kind: "tool-call", startedAt: Date.now() });
        writeFunctionCall(response, seq);
        return;
      }
      // The post-tool turn: stay silent until the Gateway's idle watchdog aborts it.
      const entry: ProviderRequest = { seq, kind: "stalled", startedAt: Date.now() };
      requests.push(entry);
      response.once("close", () => {
        entry.clientClosedAt ??= Date.now();
      });
      await stalledGate;
      if (!response.writableEnded) {
        response.end();
      }
    })().catch((error: unknown) => {
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("controlled provider did not bind a loopback port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    stop: async () => {
      releaseStalled?.();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function captureAutomationsScreenshots(params: {
  baseUrl: string;
  wsUrl: string;
  token: string;
  jobId: string;
  jobName: string;
  outputDir: string;
}): Promise<string[]> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const written: string[] = [];
  try {
    await fs.mkdir(params.outputDir, { recursive: true });
    const viewport = { width: 1440, height: 1000 };
    const context = await browser.newContext({
      locale: "en-US",
      recordVideo: { dir: params.outputDir, size: viewport },
      viewport,
    });
    const page = await context.newPage();
    // Same hook the native shells use: the page pairs with the Gateway token
    // and a fixed client identity, so no interactive connection prompt appears.
    await page.addInitScript(
      (auth) => {
        (window as Window & { ["__OPENCLAW_NATIVE_CONTROL_AUTH__"]?: unknown })[
          "__OPENCLAW_NATIVE_CONTROL_AUTH__"
        ] = auth;
      },
      {
        gatewayUrl: params.wsUrl,
        token: params.token,
        client: {
          id: "openclaw-control-ui",
          mode: "webchat",
          platform: "linux",
          deviceFamily: "desktop",
          scopes: [
            "operator.admin",
            "operator.approvals",
            "operator.questions",
            "operator.read",
            "operator.write",
          ],
        },
      },
    );
    const capture = async (name: string) => {
      const file = path.join(params.outputDir, `${PROOF_LABEL}-${name}.png`);
      await page.screenshot({ path: file, fullPage: true });
      written.push(file);
    };
    await page.goto(`${params.baseUrl}/automations?job=${encodeURIComponent(params.jobId)}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    const exitSetup = page.getByRole("button", { name: /exit setup/i });
    if (await exitSetup.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await exitSetup.click();
    }
    await page
      .getByText(params.jobName)
      .first()
      .waitFor({ timeout: 60_000 })
      .catch(() => undefined);
    await sleep(3_000);
    await capture("automations-job");
    // The job route opens on Settings; the run outcome lives under Run history.
    const historyTab = page.getByRole("tab", { name: /run history/i }).first();
    const historyText = page.getByText(/^Run history$/i).first();
    const history = (await historyTab.isVisible().catch(() => false)) ? historyTab : historyText;
    if (await history.isVisible().catch(() => false)) {
      await history.click().catch(() => undefined);
      await sleep(3_000);
      // Run entries render status and summary inline (.cron-run-entry).
      await page
        .locator(".cron-run-entry")
        .first()
        .waitFor({ timeout: 30_000 })
        .catch(() => undefined);
      await sleep(1_000);
      await capture("automations-run-history");
    }
    // The recording is finalized only after the context closes.
    const video = page.video();
    await context.close();
    const recordedPath = await video?.path();
    if (recordedPath) {
      const videoFile = path.join(params.outputDir, `${PROOF_LABEL}-automations.webm`);
      await fs.rename(recordedPath, videoFile);
      written.push(videoFile);
    }
  } finally {
    await browser.close();
  }
  return written;
}

describe.runIf(process.env.OPENCLAW_CRON_IDLE_TIMEOUT_FINALIZATION_PROOF === "1")(
  "Gateway cron idle-timeout finalization product proof",
  () => {
    it(
      "records a stalled post-tool run as failed instead of announcing the fallback summary",
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const startedAt = Date.now();
        let phase = "provider";
        const heartbeat = setInterval(() => {
          console.log(
            JSON.stringify({
              phase: "proof-heartbeat",
              step: phase,
              elapsedMs: Date.now() - startedAt,
            }),
          );
        }, 20_000);
        cleanups.push(async () => clearInterval(heartbeat));
        const provider = await startControlledProvider();
        cleanups.push(() => provider.stop());
        phase = "gateway-start";
        // The announce destination is the qa-lab bus channel, so delivered text is observable.
        const busState = createQaBusState();
        const transport = createQaChannelTransport(busState);
        const bus = await startQaBusServer({ state: busState });
        cleanups.push(() => bus.stop());
        const gatewayOwner = createQaGatewayChild();
        cleanups.push(() => stopQaGatewayFixture(gatewayOwner));
        const gateway = await gatewayOwner.start({
          repoRoot: process.cwd(),
          // Run the Gateway from source so the proof does not depend on a dist build.
          command: {
            executablePath: process.execPath,
            argsPrefix: GATEWAY_ENTRY ? [GATEWAY_ENTRY] : ["--import", "tsx", "src/entry.ts"],
            cwd: process.cwd(),
            usePackagedPlugins: true,
          },
          providerBaseUrl: `${provider.baseUrl}/v1`,
          providerMode: "mock-openai",
          primaryModel: MODEL_REF,
          alternateModel: MODEL_REF,
          transport,
          transportBaseUrl: bus.baseUrl,
          controlUiEnabled: Boolean(SCREENSHOT_DIR),
          mutateConfig: (config) => {
            const providerConfig = config.models?.providers?.["mock-openai"];
            if (!providerConfig) {
              throw new Error("mock-openai provider is missing from QA gateway config");
            }
            return {
              ...config,
              models: {
                ...config.models,
                providers: {
                  ...config.models?.providers,
                  "mock-openai": {
                    ...providerConfig,
                    // Explicit provider ceiling drives the stream idle watchdog.
                    timeoutSeconds: PROVIDER_IDLE_TIMEOUT_SECONDS,
                  },
                },
              },
            };
          },
        });

        phase = "transport-ready";
        await transport.waitReady({ gateway });
        phase = "cron";
        const added = (await gateway.call(
          "cron.add",
          {
            name: JOB_NAME,
            enabled: true,
            schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
            sessionTarget: "isolated",
            wakeMode: "next-heartbeat",
            payload: {
              kind: "agentTurn",
              message: PROMPT,
              timeoutSeconds: RUN_TIMEOUT_SECONDS,
            },
            delivery: { mode: "announce", channel: "qa-channel", to: ANNOUNCE_CONVERSATION.id },
          },
          { timeoutMs: 30_000 },
        )) as { id: string };
        expect(typeof added.id).toBe("string");

        const outboundBefore = busState
          .getSnapshot()
          .messages.filter((message) => message.direction === "outbound").length;
        const logMark = gateway.markLogs();
        const triggered = (await gateway.call(
          "cron.run",
          { id: added.id, mode: "force" },
          { timeoutMs: 30_000 },
        )) as { ok?: unknown; ran?: unknown; enqueued?: unknown };
        expect(triggered).toMatchObject({ ok: true });
        expect(triggered.ran === true || triggered.enqueued === true).toBe(true);

        const deadline = Date.now() + RUN_WAIT_MS;
        let entry: CronRunEntry | undefined;
        while (Date.now() < deadline) {
          const page = (await gateway.call(
            "cron.runs",
            { id: added.id, limit: 5 },
            { timeoutMs: 10_000 },
          )) as { entries?: CronRunEntry[] };
          entry = (page.entries ?? []).find((candidate) => candidate.status !== undefined);
          if (entry) {
            break;
          }
          await sleep(500);
        }
        const job = (await gateway.call("cron.get", { id: added.id }, { timeoutMs: 10_000 })) as {
          state?: Record<string, unknown>;
        };
        const gatewayLogs = gateway
          .readLogsSince(logMark)
          .split("\n")
          .filter((line) => /settled|idle timeout|fallback|cron/i.test(line))
          .map((line) => line.trim())
          .filter(Boolean);
        const noteExists = await fs
          .access(path.join(gateway.workspaceDir, NOTE_FILE))
          .then(() => true)
          .catch(() => false);
        const stalled = provider.requests.find((request) => request.kind === "stalled");
        // Give the announce path a moment to settle after the run record lands.
        await sleep(2_000);
        const announced = busState
          .getSnapshot()
          .messages.filter((message) => message.direction === "outbound")
          .slice(outboundBefore)
          .map((message) => ({ conversation: message.conversation, text: message.text }));

        phase = "screenshots";
        const screenshots: string[] = [];
        if (SCREENSHOT_DIR) {
          screenshots.push(
            ...(await captureAutomationsScreenshots({
              baseUrl: gateway.baseUrl,
              wsUrl: gateway.wsUrl,
              token: gateway.token,
              jobId: added.id,
              jobName: JOB_NAME,
              outputDir: SCREENSHOT_DIR,
            })),
          );
        }

        console.log(
          JSON.stringify(
            {
              phase: "cron-idle-timeout-finalization-proof",
              head:
                process.env.OPENCLAW_PROOF_HEAD_SHA ?? process.env.GITHUB_SHA ?? "local-checkout",
              providerIdleTimeoutSeconds: PROVIDER_IDLE_TIMEOUT_SECONDS,
              cronRunTrigger: triggered,
              providerRequests: provider.requests.map((request) => ({
                seq: request.seq,
                kind: request.kind,
                ...(request.clientClosedAt !== undefined
                  ? { clientClosedAfterMs: request.clientClosedAt - request.startedAt }
                  : {}),
              })),
              settledWriteLanded: noteExists,
              announcedToChannel: announced,
              screenshots,
              cronRun: entry ?? null,
              jobState: {
                lastRunStatus: job.state?.lastRunStatus,
                lastDeliveryStatus: job.state?.lastDeliveryStatus,
                lastError: job.state?.lastError,
              },
              gatewayLogs,
            },
            null,
            2,
          ),
        );

        expect(entry, "cron run never finished").toBeDefined();
        expect(noteExists).toBe(true);
        expect(provider.requests.map((request) => request.kind)).toEqual([
          "tool-call",
          "stalled",
          "finalization",
          "finalization",
        ]);
        expect(stalled?.clientClosedAt).toBeDefined();
        expect((stalled?.clientClosedAt ?? 0) - (stalled?.startedAt ?? 0)).toBeGreaterThanOrEqual(
          PROVIDER_IDLE_TIMEOUT_SECONDS * 1_000 - 500,
        );

        const recordText = JSON.stringify(entry);
        expect(recordText).not.toContain(SETTLED_TOOL_FINALIZATION_FALLBACK_TEXT);
        expect(JSON.stringify(announced)).not.toContain(SETTLED_TOOL_FINALIZATION_FALLBACK_TEXT);
        expect(entry).toMatchObject({ status: "error" });
        expect(entry?.completionStatus).not.toBe("succeeded");
        expect(typeof entry?.error === "string" ? entry.error : "").toMatch(/idle timeout/i);
        expect(job.state?.lastRunStatus).toBe("error");
      },
    );
  },
);
