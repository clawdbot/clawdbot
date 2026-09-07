// Real provider, process replacement, and browser proof of recovered dashboard authoring.
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { chromium, type Browser } from "playwright";
import { expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
} from "../packages/gateway-protocol/src/client-info.js";
import type { BoardSnapshot } from "../packages/gateway-protocol/src/index.js";
import { inspectManagedProcessGroup } from "../scripts/lib/managed-child-process.mts";
import { isLiveTestEnabled, logLiveProgress } from "../src/agents/live-test-helpers.js";
import type { OpenClawConfig } from "../src/config/config.js";
import type { GatewayClient } from "../src/gateway/client.js";
import type { SessionsListResult } from "../src/gateway/session-utils.types.js";
import { loadOrCreateDeviceIdentity } from "../src/infra/device-identity.js";
import { extractAssistantPhaseText } from "../src/shared/chat-message-content.js";
import { createControlUiE2eArtifactDir } from "../ui/src/test-helpers/control-ui-e2e-artifacts.js";
import { waitForControlUiGatewayReady } from "../ui/src/test-helpers/control-ui-e2e-readiness.js";
import { controlUiSessionUrl } from "../ui/src/test-helpers/control-ui-e2e.js";
import { acquireGatewayTestClient } from "./helpers/gateway-client.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

const MODEL = "gpt-5.6-luna";
const MODEL_REF = `openai/${MODEL}`;
const SESSION_KEY = "agent:main:widget-restart-live";
const WIDGET_NAME = "restart-chart";
const FINAL_MARKER = "WIDGET-RESTART-COMPLETE";
const FINAL_HTML = `<h1>Restart chart</h1>
<p>Production LOC and Test LOC</p>
<svg viewBox="0 0 400 230" role="img" aria-label="LOC by day">
<path d="M40 10V190H380" fill="none" stroke="currentColor"/>
<text x="5" y="190">0</text><text x="5" y="100">100</text><text x="5" y="20">200</text>
<text x="40" y="215">Day 1</text><text id="range-end" x="300" y="215">Day 30</text>
<polyline id="production" points="40,150 200,115 360,80" fill="none" stroke="var(--accent)"/>
<polyline id="tests" points="40,110 200,70 360,30" fill="none" stroke="currentColor"/>
<circle id="production-point" cx="360" cy="80" r="5" fill="var(--accent)"/><circle id="test-point" cx="360" cy="30" r="5"/>
</svg>
<p id="values">30 days · Production LOC 120 · Test LOC 180</p>
<button onclick="document.getElementById('values').textContent='7 days · Production LOC 90 · Test LOC 150';document.getElementById('production').setAttribute('points','40,165 200,140 360,110');document.getElementById('tests').setAttribute('points','40,125 200,95 360,55');document.getElementById('production-point').setAttribute('cy','110');document.getElementById('test-point').setAttribute('cy','55');document.getElementById('range-end').textContent='Day 7'">Show 7 days</button>`;

it.skipIf(!isLiveTestEnabled() || process.platform === "win32")(
  "resumes an interrupted Control UI turn and publishes an interactive dashboard without reconnecting",
  { timeout: 600_000 },
  async () => {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("Gateway widget restart live proof requires OPENAI_API_KEY");
    }
    const buildInfo = asRecord(JSON.parse(await readFile("dist/build-info.json", "utf8")));
    const buildId = typeof buildInfo.buildId === "string" ? buildInfo.buildId.trim() : undefined;
    if (!buildId || buildId === "dev") {
      throw new Error("Gateway widget restart live proof requires a built checkout");
    }
    const artifactDir = createControlUiE2eArtifactDir("gateway-widget-restart");
    const instance = await createOpenClawTestInstance({
      name: "gateway-widget-restart-live",
      env: {
        OPENAI_API_KEY: apiKey,
        OPENAI_BASE_URL: undefined,
        OPENAI_API_BASE: undefined,
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_SKIP_CANVAS_HOST: "0",
      },
      startTimeoutMs: 120_000,
      stopTimeoutMs: 10_000,
    });
    let client: GatewayClient | undefined;
    let browser: Browser | undefined;
    await runQaGatewayFixture(
      async () => {
        const config: OpenClawConfig = {
          secrets: { providers: { default: { source: "env" } } },
          models: {
            mode: "replace",
            providers: {
              openai: {
                api: "openai-responses",
                baseUrl: "https://api.openai.com/v1",
                apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
                models: [
                  {
                    id: MODEL,
                    name: MODEL,
                    reasoning: true,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 128_000,
                    maxTokens: 8_192,
                  },
                ],
              },
            },
          },
          plugins: { enabled: false },
          agents: {
            defaults: {
              workspace: instance.state.workspaceDir,
              model: { primary: MODEL_REF },
              models: { [MODEL_REF]: { agentRuntime: { id: "openclaw" } } },
              thinkingDefault: "low",
              heartbeat: { every: "0m" },
              skipBootstrap: true,
              skills: [],
              timeoutSeconds: 240,
            },
            entries: { main: { default: true } },
          },
          tools: {
            allow: ["exec", "process", "dashboard", "show_widget"],
            exec: { mode: "full", host: "gateway" },
            codeMode: { enabled: false },
          },
          gateway: {
            mode: "local",
            bind: "loopback",
            port: instance.port,
            auth: { mode: "token", token: instance.gatewayToken },
            controlUi: { enabled: true },
          },
        };
        await instance.state.writeConfig(config);
        await instance.startGateway();
        const deviceIdentity = loadOrCreateDeviceIdentity({
          path: instance.state.path("proof-device.sqlite"),
        });
        const connect = (controlUi: boolean) =>
          acquireGatewayTestClient(
            {
              url: instance.url,
              origin: controlUi ? `http://127.0.0.1:${instance.port}` : undefined,
              token: instance.gatewayToken,
              deviceIdentity,
              clientName: controlUi ? GATEWAY_CLIENT_IDS.CONTROL_UI : GATEWAY_CLIENT_IDS.TEST,
              clientBuildId: controlUi ? buildId : undefined,
              mode: controlUi ? "webchat" : "test",
              scopes: ["operator.admin", "operator.read", "operator.write"],
              caps: controlUi
                ? [GATEWAY_CLIENT_CAPS.INLINE_WIDGETS, GATEWAY_CLIENT_CAPS.TOOL_EVENTS]
                : [],
            },
            {
              timeoutMs: 60_000,
              timeoutMessage: "widget proof Gateway connect timeout",
              closeMessage: "widget proof Gateway closed during connect",
            },
          );
        client = await connect(true);
        await client.request("sessions.create", {
          key: SESSION_KEY,
          agentId: "main",
          label: "Widget restart live proof",
          model: MODEL_REF,
          permissionMode: "full",
          cwd: instance.state.workspaceDir,
        });
        const prompt = [
          "WIDGET-RESTART-REQUEST: Build a pinned interactive dashboard. This is one task across a Gateway restart; never ask for a follow-up or browser reconnect.",
          `First call show_widget with title 'Restart chart', name '${WIDGET_NAME}', pin true, and widget_code '<p>Waiting for restart checkpoint</p>'.`,
          "Then call exec with command 'touch checkpoint-ready; while [ ! -f checkpoint-resume ]; do sleep 0.1; done', yieldMs 10000, timeoutSeconds 120. Do not finish or publish the final chart while that command is pending.",
          "A Gateway restart will interrupt the command. Once the recovery message appears, skip the checkpoint and ignore expired process handles; continue the same task immediately.",
          `After recovery, call show_widget again with the same name '${WIDGET_NAME}', title 'Restart chart', pin true, and the following widget_code exactly. Do not substitute a report or attach a file.`,
          FINAL_HTML,
          `Only after show_widget succeeds, reply exactly ${FINAL_MARKER}.`,
        ].join("\n\n");
        const initialRun = await client.request<{ runId: string }>("chat.send", {
          sessionKey: SESSION_KEY,
          message: prompt,
          idempotencyKey: "widget-restart-original-turn",
        });
        await vi.waitFor(() => access(path.join(instance.state.workspaceDir, "checkpoint-ready")), {
          timeout: 120_000,
          interval: 25,
        });
        const initialBoard = await client.request<BoardSnapshot>("board.get", {
          sessionKey: SESSION_KEY,
        });
        expect(initialBoard.widgets).toEqual([
          expect.objectContaining({ name: WIDGET_NAME, contentKind: "html" }),
        ]);
        const initialSessions = await client.request<SessionsListResult>("sessions.list", {
          agentId: "main",
        });
        expect(initialSessions.sessions.find((row) => row.key === SESSION_KEY)).toMatchObject({
          status: "running",
          hasActiveRun: true,
        });
        const originalProcess = instance.child;
        if (!originalProcess?.pid) {
          throw new Error("Owned Gateway process is unavailable");
        }
        await client.stopAndWait();
        client = undefined;
        logLiveProgress(
          `widget restart: checkpoint reached; replacing owned Gateway pid=${originalProcess.pid}`,
        );
        // Interrupt the Gateway without draining; the marker releases its detached exec below.
        process.kill(-originalProcess.pid, "SIGKILL");
        await vi.waitFor(
          () =>
            expect(
              inspectManagedProcessGroup(originalProcess, { errorPolicy: "indeterminate" }),
            ).toBe("dead"),
          { timeout: 10_000 },
        );
        await writeFile(path.join(instance.state.workspaceDir, "checkpoint-resume"), "resume\n");
        await instance.startGateway();
        expect(instance.child?.pid).not.toBe(originalProcess.pid);
        client = await connect(false);
        const observer = client;
        await vi.waitFor(
          async () => {
            const sessions = await observer.request<SessionsListResult>("sessions.list", {
              agentId: "main",
            });
            expect(sessions.sessions.find((row) => row.key === SESSION_KEY)).toMatchObject({
              status: "done",
              hasActiveRun: false,
            });
          },
          { timeout: 180_000, interval: 250 },
        );
        const board = await observer.request<BoardSnapshot>("board.get", {
          sessionKey: SESSION_KEY,
        });
        expect(board.widgets).toHaveLength(1);
        expect(board.widgets[0]).toMatchObject({
          name: WIDGET_NAME,
          contentKind: "html",
          grantState: "none",
        });
        expect(board.widgets[0]?.revision).toBeGreaterThan(initialBoard.widgets[0]!.revision);
        const history = await observer.request<{
          messages: Array<{ role: string; content?: unknown }>;
        }>("chat.history", { sessionKey: SESSION_KEY });
        const finals = history.messages.filter(
          (message) =>
            message.role === "assistant" &&
            extractAssistantPhaseText(message)?.trim() === FINAL_MARKER,
        );
        expect(finals).toHaveLength(1);
        expect(instance.logs()).toContain("startup-orphaned main session(s)");
        logLiveProgress(
          "widget restart: automatic recovery completed without an inline client; opening persisted dashboard",
        );

        const handoff = await instance.cli(["dashboard", "--json"]);
        expect(handoff.code, handoff.stderr).toBe(0);
        const issued = JSON.parse(handoff.stdout) as { browserUrl: string };
        const url = new URL(
          controlUiSessionUrl(`http://127.0.0.1:${instance.port}/`, SESSION_KEY, "dashboard"),
        );
        url.hash = new URL(issued.browserUrl).hash;
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({
          viewport: { width: 1440, height: 900 },
          serviceWorkers: "block",
          permissions: ["local-network-access"],
        });
        page.setDefaultTimeout(60_000);
        expect((await page.goto(url.toString()))?.status()).toBe(200);
        await waitForControlUiGatewayReady(page);
        const widget = page.frameLocator(".board-widget__frame").frameLocator("iframe");
        await widget.getByRole("heading", { name: "Restart chart", exact: true }).waitFor();
        expect(await widget.getByRole("img", { name: "LOC by day" }).textContent()).toContain(
          "200",
        );
        expect(await widget.locator("#values").textContent()).toBe(
          "30 days · Production LOC 120 · Test LOC 180",
        );
        await widget.getByRole("button", { name: "Show 7 days", exact: true }).click();
        expect(await widget.locator("#values").textContent()).toBe(
          "7 days · Production LOC 90 · Test LOC 150",
        );
        expect(await widget.locator("#production").getAttribute("points")).toBe(
          "40,165 200,140 360,110",
        );
        expect(await widget.locator("#tests").getAttribute("points")).toBe("40,125 200,95 360,55");
        expect(await widget.locator("#production-point").getAttribute("cy")).toBe("110");
        expect(await widget.locator("#test-point").getAttribute("cy")).toBe("55");
        expect(await widget.locator("#range-end").textContent()).toBe("Day 7");
        await page.screenshot({ path: path.join(artifactDir, "recovered-dashboard.png") });
        await writeFile(
          path.join(artifactDir, "proof.json"),
          JSON.stringify(
            {
              model: MODEL_REF,
              runtime: "openclaw",
              sessionKey: SESSION_KEY,
              originalRunId: initialRun.runId,
              originalPid: originalProcess.pid,
              recoveredPid: instance.child?.pid,
              initialRevision: initialBoard.widgets[0]!.revision,
              recoveredRevision: board.widgets[0]!.revision,
              userTurnsSent: 1,
              recoveredFinals: finals.length,
              browserConnectedAfterRecovery: true,
              interactiveRangeChanged: true,
            },
            null,
            2,
          ),
        );
        logLiveProgress(`widget restart: real browser interaction passed; evidence=${artifactDir}`);
      },
      () => writeFile(path.join(artifactDir, "gateway.log"), instance.logs()),
      () => writeFile(path.join(instance.state.workspaceDir, "checkpoint-resume"), "resume\n"),
      () => browser?.close(),
      () => client?.stopAndWait(),
      () => instance.cleanup(),
    );
  },
);
