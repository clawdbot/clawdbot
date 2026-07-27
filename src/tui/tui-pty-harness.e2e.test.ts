// Exercises the fake-backend TUI PTY harness and visible terminal output.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approveWorkspaceSkill,
  buildOpaqueSessionIsolationFixture,
  COMPACT_TERMINAL_SIZES,
  exerciseFragmentedUnicodePrompt,
  objectFieldEquals,
  readFixtureLog,
  waitForFixtureLogEntry,
  type FixtureLogEntry,
} from "./tui-pty-harness-fixture-test-support.js";
import { sleep, startPty, type PtyRun } from "./tui-pty-test-support.js";

const activeRuns: PtyRun[] = [];
const STARTUP_TIMEOUT_MS = 20_000;
const OUTPUT_TIMEOUT_MS = 2_000;
const EXIT_TIMEOUT_MS = 4_000;
const TEST_TIMEOUT_MS = 5_000;
const STARTUP_TEST_TIMEOUT_MS = 25_000;

async function writeTuiPtyFixtureScript(dir: string) {
  // Temp files sit outside the repo package scope; .mts preserves the ESM contract under tsx.
  const scriptPath = path.join(dir, "run-tui-pty-fixture.mts");
  const tuiModuleUrl = pathToFileURL(path.join(process.cwd(), "src/tui/tui.ts")).href;
  const payloadsModuleUrl = pathToFileURL(
    path.join(process.cwd(), "src/agents/embedded-agent-runner/run/payloads.ts"),
  ).href;
  const replyPayloadModuleUrl = pathToFileURL(
    path.join(process.cwd(), "src/auto-reply/reply-payload.ts"),
  ).href;
  const outboundPayloadsModuleUrl = pathToFileURL(
    path.join(process.cwd(), "src/infra/outbound/payloads.ts"),
  ).href;
  await writeFile(
    scriptPath,
    `
      import { appendFileSync } from "node:fs";
      import { buildEmbeddedRunPayloads } from ${JSON.stringify(payloadsModuleUrl)};
      import { getReplyPayloadMetadata } from ${JSON.stringify(replyPayloadModuleUrl)};
      import { normalizeReplyPayloadsForDelivery } from ${JSON.stringify(outboundPayloadsModuleUrl)};
      import type { TuiBackend } from ${JSON.stringify(tuiModuleUrl.replace("/tui.ts", "/tui-backend.ts"))};
      import { runTui } from ${JSON.stringify(tuiModuleUrl)};

      const actionLogPath = process.env.OPENCLAW_TUI_PTY_LOG_PATH;
      const gatewayStatus = process.env.OPENCLAW_TUI_PTY_GATEWAY_STATUS ?? "fixture gateway ok";
      const startupDelayMs = Number(process.env.OPENCLAW_TUI_PTY_STARTUP_DELAY_MS ?? 0);
      const footerModel = process.env.OPENCLAW_TUI_PTY_MODEL;
      const footerThinkingLevel = process.env.OPENCLAW_TUI_PTY_THINKING_LEVEL;
      const launchThinkingLevel = process.env.OPENCLAW_TUI_PTY_LAUNCH_THINKING;
      const initialMessage = process.env.OPENCLAW_TUI_PTY_INITIAL_MESSAGE;
      const xaiLimitError = '403 {"code":"The caller does not have permission to execute the specified operation","error":"Your team team-redacted has either used all available credits or reached its monthly spending limit. To continue making API requests, please purchase more credits or raise your spending limit."}';
      let currentModel = footerModel ?? "fixture-provider/fixture-model";
      let currentThinkingLevel = footerThinkingLevel;
      let fastMode = process.env.OPENCLAW_TUI_PTY_FAST_MODE === "true";
      let pendingPluginApproval: {
        id: string;
        request: {
          title: string;
          description: string;
          toolName: string;
          allowedDecisions: string[];
          sessionKey: string;
        };
        createdAtMs: number;
        expiresAtMs: number;
      } | null = null;
      let pendingPluginApprovalRun: { runId: string; sessionKey: string } | null = null;
      let pendingTaskSuggestion: {
        id: string;
        title: string;
        prompt: string;
        tldr: string;
        cwd: string;
        sessionKey: string;
        agentId: string;
        createdAt: number;
      } | null = null;

      function record(method: string, payload?: unknown) {
        if (!actionLogPath) {
          return;
        }
        appendFileSync(actionLogPath, JSON.stringify({ method, payload }) + "\\n", "utf8");
      }

      function sessionEntry(key = "main") {
        return {
          key,
          displayName: "Main",
          model: currentModel,
          modelProvider: "fixture-provider",
          contextTokens: 128,
          fastMode,
          ...(currentThinkingLevel ? { thinkingLevel: currentThinkingLevel } : {}),
          thinkingLevels: [],
        };
      }

      function assistantMessageFromSourceReplyPayloads(payloads: ReturnType<typeof buildEmbeddedRunPayloads>) {
        if (payloads.length === 0) {
          throw new Error("expected source reply payload");
        }
        for (const payload of payloads) {
          const metadata = getReplyPayloadMetadata(payload);
          if (!metadata?.sourceReplyTranscriptMirror) {
            throw new Error("expected source reply transcript mirror metadata");
          }
          record("sourceReplyMetadata", metadata.sourceReplyTranscriptMirror);
        }
        const normalized = normalizeReplyPayloadsForDelivery(payloads);
        const content = normalized.flatMap((payload) => {
          const text = payload.text?.trim();
          return text ? [{ type: "text", text }] : [];
        });
        if (content.length === 0) {
          throw new Error("expected displayable source reply content");
        }
        return {
          role: "assistant",
          content,
          timestamp: Date.now(),
        };
      }

      class FixtureBackend implements TuiBackend {
        connection = { url: "pty-fixture://local" };
        onEvent?: TuiBackend["onEvent"];
        onConnected?: TuiBackend["onConnected"];
        onDisconnected?: TuiBackend["onDisconnected"];
        onGap?: TuiBackend["onGap"];

        start() {
          queueMicrotask(() => this.onConnected?.());
        }

        stop() {}

        async sendChat(opts: Parameters<TuiBackend["sendChat"]>[0]) {
          record("sendChat", {
            sessionKey: opts.sessionKey,
            message: opts.message,
            deliver: opts.deliver,
            thinking: opts.thinking,
          });
          const runId = opts.runId ?? "run-pty-fixture";
          if (opts.message === "skill approval proof" || opts.message === "skill approval gap proof") {
            pendingPluginApproval = {
              id: "plugin:skill-pty",
              request: {
                title: "Apply workspace skill proposal",
                description: "Apply a pending workspace skill proposal into live workspace skills.",
                pluginId: "workspace-skills",
                severity: "warning",
                toolName: "skill_workshop",
                allowedDecisions: ["allow-once", "deny"],
                sessionKey: opts.sessionKey,
              },
              createdAtMs: Date.now(),
              expiresAtMs: Date.now() + 120_000,
            };
            pendingPluginApprovalRun = { runId, sessionKey: opts.sessionKey };
            queueMicrotask(() => {
              if (opts.message === "skill approval gap proof") {
                this.onGap?.({ expected: 4, received: 5 });
              } else {
                this.onEvent?.({
                  event: "plugin.approval.requested",
                  payload: pendingPluginApproval,
                });
              }
            });
            return { runId };
          }
          if (opts.message === "task suggestion proof") {
            pendingTaskSuggestion = {
              id: "task_pty",
              title: "Remove stale adapter",
              prompt: "Delete the stale adapter and update its tests.",
              tldr: "The adapter is unreachable and adds maintenance cost.",
              cwd: "/repo/project",
              sessionKey: opts.sessionKey,
              agentId: "main",
              createdAt: Date.now(),
            };
            queueMicrotask(() => {
              this.onEvent?.({
                event: "task.suggestion",
                payload: { action: "created", suggestion: pendingTaskSuggestion },
              });
            });
            return { runId };
          }
          ${buildOpaqueSessionIsolationFixture()}
          const responseDelayMs =
            opts.message === "slow prompt" ||
            opts.message === "slow reset proof" ||
            opts.message === "streaming prompt"
              ? 500
              : 20;
          if (opts.message === "streaming prompt") {
            setTimeout(() => {
              this.onEvent?.({
                event: "chat",
                payload: {
                  runId,
                  sessionKey: opts.sessionKey,
                  state: "delta",
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: "PTY_STREAMING: streaming prompt" }],
                    timestamp: Date.now(),
                  },
                },
              });
            }, 5);
          }
          const isSourceReplyProof = opts.message === "message tool only source reply proof";
          const isXaiLimitProof = opts.message === "xai limit proof";
          setTimeout(() => {
            if (isXaiLimitProof) {
              this.onEvent?.({
                event: "chat",
                payload: {
                  runId,
                  sessionKey: opts.sessionKey,
                  state: "error",
                  errorMessage: xaiLimitError,
                },
              });
              return;
            }
            const sourceReplyPayloads = isSourceReplyProof
              ? buildEmbeddedRunPayloads({
                  assistantTexts: [],
                  toolMetas: [],
                  lastAssistant: undefined,
                  inlineToolResultsAllowed: false,
                  sessionKey: opts.sessionKey,
                  sourceReplyDeliveryMode: "message_tool_only",
                  messagingToolSourceReplyPayloads: [
                    {
                      text: "VISIBLE_TUI_SOURCE_REPLY_PROOF",
                    },
                  ],
                  runId,
                })
              : [];
            const message = isSourceReplyProof
              ? assistantMessageFromSourceReplyPayloads(sourceReplyPayloads)
              : {
                  role: "assistant",
                  content: [{ type: "text", text: "PTY_RESPONSE: " + opts.message }],
                  timestamp: Date.now(),
                };
            this.onEvent?.({
              event: "chat",
              payload: {
                runId,
                sessionKey: opts.sessionKey,
                state: "final",
                message,
              },
            });
          }, responseDelayMs);
          return { runId };
        }

        async abortChat() {
          record("abortChat");
          return { ok: true, aborted: true };
        }

        async loadHistory(opts: Parameters<TuiBackend["loadHistory"]>[0]) {
          const sessionKey = opts?.sessionKey ?? "main";
          record("loadHistory", { sessionKey });
          const rapidSwitchMarker = sessionKey.endsWith("switch-a")
            ? "A"
            : sessionKey.endsWith("switch-b")
              ? "B"
              : null;
          const delayMs =
            rapidSwitchMarker === "A" ? 500 : rapidSwitchMarker === "B" ? 40 : startupDelayMs;
          if (delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
          if (rapidSwitchMarker) {
            record("loadHistoryResolved", { sessionKey });
            return {
              sessionId: "session-" + rapidSwitchMarker,
              sessionInfo: {
                key: sessionKey,
                sessionId: "session-" + rapidSwitchMarker,
                model: currentModel,
                modelProvider: "fixture-provider",
                contextTokens: 128,
                fastMode,
                thinkingLevels: [],
              },
              messages: [{ role: "user", content: rapidSwitchMarker + "_HISTORY_MARKER" }],
            };
          }
          return {
            messages: [],
            fastMode,
            ...(footerModel
              ? {
                  thinkingLevel: footerThinkingLevel,
                  sessionInfo: sessionEntry(sessionKey),
                }
              : {}),
          };
        }

        async listSessions() {
          return {
            ts: Date.now(),
            path: "",
            count: 0,
            sessions: [],
            defaults: {
              model: currentModel,
              modelProvider: "fixture-provider",
              contextTokens: 128,
              thinkingLevels: [],
            },
          };
        }

        async listAgents() {
          return {
            defaultId: "main",
            mainKey: "main",
            scope: "per-sender",
            agents: [{ id: "main", name: "Main" }],
          };
        }

        async patchSession(opts: Parameters<TuiBackend["patchSession"]>[0]) {
          record("patchSession", opts);
          if (opts.model) {
            currentModel = opts.model;
          }
          if (opts.thinkingLevel) {
            currentThinkingLevel = opts.thinkingLevel;
          }
          if (typeof opts.fastMode === "boolean") {
            fastMode = opts.fastMode;
          }
          return {
            ok: true,
            path: "",
            key: opts.key,
            entry: sessionEntry(opts.key),
            resolved: {
              modelProvider: "fixture-provider",
              model: currentModel,
            },
          };
        }

        async createSession(opts: Parameters<TuiBackend["createSession"]>[0]) {
          record("createSession", opts);
          const key = "agent:main:" + opts.key;
          return { ok: true, key, entry: { ...sessionEntry(key), sessionId: "created-session" } };
        }

        async resetSession(key: string, reason?: "new" | "reset") {
          record("resetSession", { key, reason });
          return {};
        }

        async getGatewayStatus() {
          record("getGatewayStatus");
          return gatewayStatus;
        }

        async listModels() {
          return [
            { id: "fixture-provider/fixture-model", name: "Fixture", provider: "fixture-provider" },
            { id: "fixture-provider/fixture-model-2", name: "Fixture 2", provider: "fixture-provider" },
          ];
        }

        async listPluginApprovals() {
          record("listPluginApprovals", { pending: Boolean(pendingPluginApproval) });
          return pendingPluginApproval ? [pendingPluginApproval] : [];
        }

        async resolvePluginApproval(id: string, decision: "allow-once" | "allow-always" | "deny") {
          record("resolvePluginApproval", { id, decision });
          const pendingRun = pendingPluginApprovalRun;
          pendingPluginApproval = null;
          pendingPluginApprovalRun = null;
          this.onEvent?.({
            event: "plugin.approval.resolved",
            payload: { id, decision },
          });
          this.onEvent?.({
            event: "chat",
            payload: {
              runId: pendingRun?.runId ?? "run-pty-fixture",
              sessionKey: pendingRun?.sessionKey ?? "agent:main:main",
              state: "final",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "PTY_SKILL_APPROVAL_RESOLVED: " + decision }],
                timestamp: Date.now(),
              },
            },
          });
          return { ok: true };
        }

        async listTaskSuggestions() {
          record("listTaskSuggestions", { pending: Boolean(pendingTaskSuggestion) });
          return pendingTaskSuggestion ? [pendingTaskSuggestion] : [];
        }

        async acceptTaskSuggestion(taskId: string) {
          record("acceptTaskSuggestion", { taskId });
          pendingTaskSuggestion = null;
          this.onEvent?.({
            event: "task.suggestion",
            payload: { action: "resolved", taskId, resolution: "accepted" },
          });
          return { taskId, key: "agent:main:task-pty" };
        }

        async dismissTaskSuggestion(taskId: string) {
          record("dismissTaskSuggestion", { taskId });
          pendingTaskSuggestion = null;
          this.onEvent?.({
            event: "task.suggestion",
            payload: { action: "resolved", taskId, resolution: "dismissed" },
          });
          return { taskId, dismissed: true };
        }
      }

      async function main() {
        await runTui({
          backend: new FixtureBackend(),
          config: {
            agents: {
              defaults: { model: "fixture-provider/fixture-model" },
              entries: { main: { default: true } },
            },
            session: { scope: "per-sender", mainKey: "main" },
          },
          deliver: false,
          thinking: launchThinkingLevel,
          message: initialMessage,
          historyLimit: 5,
          title: "openclaw tui pty fixture",
        });
      }

      main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `,
    "utf8",
  );
  return scriptPath;
}

async function startTuiFixture(opts: { env?: NodeJS.ProcessEnv } = {}) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "openclaw-tui-pty-"));
  const scriptPath = await writeTuiPtyFixtureScript(tempDir);
  const logPath = path.join(tempDir, "fixture-log.jsonl");
  const run = startPty(process.execPath, ["--import", "tsx", scriptPath], {
    activeRuns,
    cwd: process.cwd(),
    env: {
      OPENCLAW_THEME: "dark",
      OPENCLAW_TUI_PTY_LOG_PATH: logPath,
      NO_COLOR: undefined,
      ...opts.env,
    },
    exitTimeoutMs: EXIT_TIMEOUT_MS,
    outputTimeoutMs: OUTPUT_TIMEOUT_MS,
  });

  return {
    run,
    logPath,
    waitForLogEntry: async (predicate: (entry: FixtureLogEntry) => boolean, timeoutMs?: number) =>
      await waitForFixtureLogEntry(logPath, predicate, timeoutMs ?? OUTPUT_TIMEOUT_MS, run.output),
    cleanup: async () => {
      await run.dispose();
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

describe.sequential("TUI PTY harness", () => {
  let fixture: Awaited<ReturnType<typeof startTuiFixture>>;
  let compactFooterFixture: Awaited<ReturnType<typeof startTuiFixture>>;
  let thinkingOverrideFixture: Awaited<ReturnType<typeof startTuiFixture>>;
  let slowStartupFixture: Awaited<ReturnType<typeof startTuiFixture>>;

  beforeAll(async () => {
    // Boot every suite PTY concurrently: tsx+TUI startup dominates this file's
    // wall time. The env-specific fixtures never receive input, so their tests
    // only await readiness output and stay attributable to their own `it`.
    // allSettled (not all) so a failed boot still assigns the survivors for
    // afterAll cleanup instead of leaking their PTY processes.
    const boots = await Promise.allSettled([
      startTuiFixture(),
      startTuiFixture({
        env: {
          OPENCLAW_TUI_PTY_MODEL: "gpt-5.6-sol@openai:setup-64cddea3-938c-431e-be3b-aa47090577c7",
          OPENCLAW_TUI_PTY_THINKING_LEVEL: "high",
        },
      }),
      startTuiFixture({
        env: {
          OPENCLAW_TUI_PTY_MODEL: "fixture-provider/fixture-model",
          OPENCLAW_TUI_PTY_THINKING_LEVEL: "medium",
          OPENCLAW_TUI_PTY_LAUNCH_THINKING: "high",
          OPENCLAW_TUI_PTY_INITIAL_MESSAGE: "thinking override proof",
        },
      }),
      startTuiFixture({
        env: { OPENCLAW_TUI_PTY_STARTUP_DELAY_MS: "400" },
      }),
    ]);
    const [mainBoot, compactBoot, thinkingOverrideBoot, slowBoot] = boots;
    if (mainBoot.status === "fulfilled") {
      fixture = mainBoot.value;
    }
    if (compactBoot.status === "fulfilled") {
      compactFooterFixture = compactBoot.value;
    }
    if (thinkingOverrideBoot.status === "fulfilled") {
      thinkingOverrideFixture = thinkingOverrideBoot.value;
    }
    if (slowBoot.status === "fulfilled") {
      slowStartupFixture = slowBoot.value;
    }
    const failedBoot = boots.find((boot) => boot.status === "rejected");
    if (failedBoot) {
      throw failedBoot.reason;
    }
    await fixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);
  }, STARTUP_TEST_TIMEOUT_MS);

  afterAll(async () => {
    for (const run of activeRuns.splice(0)) {
      await run.dispose();
    }
    for (const started of [
      fixture,
      compactFooterFixture,
      thinkingOverrideFixture,
      slowStartupFixture,
    ]) {
      await (started as Awaited<ReturnType<typeof startTuiFixture>> | undefined)?.cleanup();
    }
  }, STARTUP_TEST_TIMEOUT_MS);

  it("renders local ready on startup", () => {
    expect(fixture.run.visibleOutput()).toContain("local ready");
    expect(fixture.run.visibleOutput()).not.toContain("host local");
  });

  it(
    "renders a compact model and active thinking level in the footer",
    async () => {
      await compactFooterFixture.run.waitForOutput("gpt-5.6-sol high", STARTUP_TIMEOUT_MS);
      expect(compactFooterFixture.run.visibleOutput()).not.toContain("openai:setup-64cddea3");
    },
    STARTUP_TEST_TIMEOUT_MS,
  );

  it(
    "keeps the launch thinking override active across session-level changes",
    async () => {
      const footerNeedle = "fixture-provider/fixture-model high | tokens";
      await thinkingOverrideFixture.run.waitForOutput(footerNeedle, STARTUP_TIMEOUT_MS);
      await thinkingOverrideFixture.run.waitForOutput(
        "PTY_RESPONSE: thinking override proof",
        STARTUP_TIMEOUT_MS,
      );
      await thinkingOverrideFixture.waitForLogEntry(
        (entry) =>
          entry.method === "sendChat" &&
          objectFieldEquals(entry, "message", "thinking override proof") &&
          objectFieldEquals(entry, "thinking", "high"),
      );
      await thinkingOverrideFixture.run.write("/think low\r");
      await thinkingOverrideFixture.waitForLogEntry(
        (entry) =>
          entry.method === "patchSession" && objectFieldEquals(entry, "thinkingLevel", "low"),
      );
      const sessionChangeOutputOffset = thinkingOverrideFixture.run.visibleOutput().length;
      await thinkingOverrideFixture.run.write("second thinking override proof\r");
      await thinkingOverrideFixture.run.waitForOutput(
        "PTY_RESPONSE: second thinking override proof",
        STARTUP_TIMEOUT_MS,
      );
      await thinkingOverrideFixture.waitForLogEntry(
        (entry) =>
          entry.method === "sendChat" &&
          objectFieldEquals(entry, "message", "second thinking override proof") &&
          objectFieldEquals(entry, "thinking", "high"),
      );
      const outputAfterSessionChange = thinkingOverrideFixture.run
        .visibleOutput()
        .slice(sessionChangeOutputOffset);
      expect(outputAfterSessionChange).toContain(footerNeedle);
      expect(outputAfterSessionChange).not.toContain("fixture-provider/fixture-model low | tokens");
      expect(outputAfterSessionChange).not.toContain(
        "fixture-provider/fixture-model medium | tokens",
      );
    },
    STARTUP_TEST_TIMEOUT_MS,
  );

  it(
    "shows startup activity while post-connect initialization is pending",
    async () => {
      const output = await slowStartupFixture.run.waitForOutput(
        "local ready | idle",
        STARTUP_TIMEOUT_MS,
      );
      // PTY output is append-only, so first-occurrence order proves the startup
      // activity frame rendered before the delayed post-connect init completed.
      expect(output.indexOf("starting up")).toBeGreaterThanOrEqual(0);
      expect(output.indexOf("starting up")).toBeLessThan(output.indexOf("local ready | idle"));
    },
    STARTUP_TEST_TIMEOUT_MS,
  );

  it("refreshes pending approvals before loading history", async () => {
    await fixture.waitForLogEntry((entry) => entry.method === "listPluginApprovals");
    await fixture.waitForLogEntry((entry) => entry.method === "listTaskSuggestions");
    await fixture.waitForLogEntry((entry) => entry.method === "loadHistory");

    const entries = await readFixtureLog(fixture.logPath);
    const approvalRefreshIndex = entries.findIndex(
      (entry) => entry.method === "listPluginApprovals",
    );
    const historyLoadIndex = entries.findIndex((entry) => entry.method === "loadHistory");
    const taskRefreshIndex = entries.findIndex((entry) => entry.method === "listTaskSuggestions");

    expect(approvalRefreshIndex).toBeGreaterThanOrEqual(0);
    expect(approvalRefreshIndex).toBeLessThan(historyLoadIndex);
    expect(taskRefreshIndex).toBeGreaterThanOrEqual(0);
    expect(taskRefreshIndex).toBeLessThan(historyLoadIndex);
  });

  it(
    "drives the real TUI terminal loop through typed and fragmented Unicode input",
    async () => {
      await fixture.run.write("hello from pty\r");
      await fixture.run.waitForOutput("PTY_RESPONSE: hello from pty");
      await fixture.waitForLogEntry(
        (entry) =>
          entry.method === "sendChat" && objectFieldEquals(entry, "message", "hello from pty"),
      );
      await exerciseFragmentedUnicodePrompt(startTuiFixture, STARTUP_TIMEOUT_MS);
    },
    STARTUP_TEST_TIMEOUT_MS,
  );

  it(
    "deletes forward with Ctrl+D without exiting a nonempty terminal editor",
    async () => {
      await fixture.run.write("keepXword", { delay: false });
      await fixture.run.write("\u001b[D".repeat(5), { delay: false });
      await fixture.run.write("\u0004", { delay: false });
      await fixture.run.write("\r", { delay: false });

      const sent = await fixture.waitForLogEntry(
        (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", "keepword"),
      );
      expect(sent.payload).toMatchObject({ message: "keepword" });
      await fixture.run.waitForOutput("PTY_RESPONSE: keepword");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "exits a fresh terminal when Ctrl+D is pressed with empty input",
    async () => {
      const emptyFixture = await startTuiFixture();
      try {
        await emptyFixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);
        await emptyFixture.run.write("\u0004", { delay: false });
        expect((await emptyFixture.run.waitForExit()).exitCode).toBe(0);
      } finally {
        await emptyFixture.cleanup();
      }
    },
    STARTUP_TEST_TIMEOUT_MS,
  );

  it(
    "presents and resolves workspace skill approval in the TUI",
    async () => {
      await approveWorkspaceSkill(fixture, "skill approval proof");
    },
    TEST_TIMEOUT_MS,
  );

  it.each(COMPACT_TERMINAL_SIZES)(
    "presents and resolves workspace skill approval in a %i×%i terminal",
    async (cols, rows) => {
      const compactFixture = await startTuiFixture({
        env: {
          OPENCLAW_TUI_PTY_COLS: String(cols),
          OPENCLAW_TUI_PTY_ROWS: String(rows),
        },
      });

      try {
        await compactFixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);
        await approveWorkspaceSkill(compactFixture, "skill approval proof");
      } finally {
        await compactFixture.cleanup();
      }
    },
    STARTUP_TEST_TIMEOUT_MS,
  );

  it(
    "refreshes pending workspace skill approvals after an event gap",
    async () => {
      await fixture.run.write("skill approval gap proof\r");
      await fixture.waitForLogEntry(
        (entry) =>
          entry.method === "listPluginApprovals" && objectFieldEquals(entry, "pending", true),
      );
      await fixture.run.waitForOutput("workspace skill approval: Apply workspace skill proposal");

      await fixture.run.write("\x1b[A", { delay: false });
      await fixture.run.write("\r");
      await fixture.waitForLogEntry(
        (entry) =>
          entry.method === "resolvePluginApproval" &&
          objectFieldEquals(entry, "decision", "allow-once"),
      );
      await fixture.run.waitForOutput("PTY_SKILL_APPROVAL_RESOLVED: allow-once");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "presents and starts a suggested task in the TUI",
    async () => {
      await fixture.run.write("task suggestion proof\r");
      await fixture.run.waitForOutput("Suggested follow-up: Remove stale adapter");
      await fixture.run.waitForOutput("Project: /repo/project");
      await fixture.run.waitForOutput("The adapter is unreachable and adds maintenance cost.");

      await fixture.run.write("\x1b[A", { delay: false });
      await fixture.run.write("\r", { delay: false });
      await fixture.run.waitForOutput("Press Enter again to start this task in a worktree.");
      await fixture.run.write("\r", { delay: false });
      await fixture.waitForLogEntry(
        (entry) =>
          entry.method === "acceptTaskSuggestion" && objectFieldEquals(entry, "taskId", "task_pty"),
      );
      await fixture.run.waitForOutput("session agent:main:task-pty");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "sends multiple prompts in order",
    async () => {
      await fixture.run.write("first prompt\r");
      await fixture.run.waitForOutput("PTY_RESPONSE: first prompt");
      await fixture.run.write("second prompt\r");
      await fixture.run.waitForOutput("PTY_RESPONSE: second prompt");
      await fixture.waitForLogEntry(
        (entry) =>
          entry.method === "sendChat" && objectFieldEquals(entry, "message", "second prompt"),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "renders message-tool-only internal ui source replies in the terminal",
    async () => {
      await fixture.run.write("message tool only source reply proof\r");
      await fixture.run.waitForOutput("VISIBLE_TUI_SOURCE_REPLY_PROOF");
      await fixture.waitForLogEntry(
        (entry) =>
          entry.method === "sendChat" &&
          objectFieldEquals(entry, "message", "message tool only source reply proof"),
      );
      await fixture.waitForLogEntry(
        (entry) =>
          entry.method === "sourceReplyMetadata" &&
          objectFieldEquals(entry, "text", "VISIBLE_TUI_SOURCE_REPLY_PROOF"),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "preserves xAI account limit errors in terminal output",
    async () => {
      await fixture.run.write("xai limit proof\r");
      await fixture.run.waitForOutput("monthly spending limit");
      expect(fixture.run.visibleOutput()).not.toContain("Run /auth");
      await fixture.waitForLogEntry(
        (entry) =>
          entry.method === "sendChat" && objectFieldEquals(entry, "message", "xai limit proof"),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "blocks overlapping normal messages while a run is busy",
    async () => {
      await fixture.run.write("slow prompt\r");
      await sleep(50);
      await fixture.run.write("second prompt\r");
      await fixture.run.waitForOutput("agent is busy");
      await fixture.run.waitForOutput("PTY_RESPONSE: slow prompt");
      const sendCalls = (await readFixtureLog(fixture.logPath)).filter(
        (entry) => entry.method === "sendChat",
      );
      const slowPromptCalls = sendCalls.filter((entry) =>
        objectFieldEquals(entry, "message", "slow prompt"),
      );
      expect(slowPromptCalls).toHaveLength(1);
      expect(slowPromptCalls[0]?.payload).toMatchObject({ message: "slow prompt" });
      await fixture.run.write("\x15", { delay: false });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps an active session intact when /reset is submitted from the terminal",
    async () => {
      const priorResetCount = (await readFixtureLog(fixture.logPath)).filter(
        (entry) => entry.method === "resetSession",
      ).length;

      await fixture.run.write("slow reset proof\r");
      await fixture.waitForLogEntry(
        (entry) =>
          entry.method === "sendChat" && objectFieldEquals(entry, "message", "slow reset proof"),
      );
      await fixture.run.write("/reset\r", { delay: false });
      await fixture.run.waitForOutput("abort the current run before /reset");

      const resetCalls = (await readFixtureLog(fixture.logPath)).filter(
        (entry) => entry.method === "resetSession",
      );
      expect(resetCalls).toHaveLength(priorResetCount);
      await fixture.run.waitForOutput("PTY_RESPONSE: slow reset proof");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "submits a follow-up prompt while a run is streaming",
    async () => {
      await fixture.run.write("\x15", { delay: false });
      await fixture.run.write("streaming prompt\r");
      await fixture.run.waitForOutput("PTY_STREAMING: streaming prompt");
      await fixture.run.write("queued while streaming\r");
      await fixture.waitForLogEntry(
        (entry) =>
          entry.method === "sendChat" &&
          objectFieldEquals(entry, "message", "queued while streaming"),
      );
      await fixture.run.waitForOutput("PTY_RESPONSE: streaming prompt");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "renders slash command help",
    async () => {
      await fixture.run.write("/help\r", { delay: false });
      await fixture.run.waitForOutput("Slash commands:");
      await fixture.run.waitForOutput("/help");
      await fixture.run.waitForOutput("/verbose <on|off|full>");
      await fixture.run.waitForOutput("/reasoning <on|off|stream>");
      await fixture.run.waitForOutput("/exit");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "renders gateway status from the backend",
    async () => {
      await fixture.run.write("/gateway-status\r", { delay: false });
      await fixture.run.waitForOutput("fixture gateway ok");
      await fixture.waitForLogEntry((entry) => entry.method === "getGatewayStatus");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "patches the session model from /model",
    async () => {
      await fixture.run.write("/model fixture-provider/fixture-model-2\r", { delay: false });
      await fixture.run.waitForOutput("model set to fixture-provider/fixture-model-2");
      await fixture.waitForLogEntry(
        (entry) =>
          entry.method === "patchSession" &&
          objectFieldEquals(entry, "model", "fixture-provider/fixture-model-2"),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "submits an exact argument completion with one Enter",
    async () => {
      await fixture.run.write("/fast status", { delay: false });
      await fixture.run.waitForOutput("→ status");
      await fixture.run.write("\r", { delay: false });
      await fixture.run.waitForOutput("fast mode: off");
    },
    TEST_TIMEOUT_MS,
  );

  it.each([
    { command: "verbose", level: "full", field: "verboseLevel" },
    { command: "reasoning", level: "stream", field: "reasoningLevel" },
  ])(
    "submits the canonical /$command $level terminal completion with one Enter",
    async ({ command, level, field }) => {
      await fixture.run.write(`/${command} ${level}`, { delay: false });
      await fixture.run.waitForOutput(`→ ${level}`);
      await fixture.run.write("\r", { delay: false });

      await fixture.waitForLogEntry(
        (entry) => entry.method === "patchSession" && objectFieldEquals(entry, field, level),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it.each([
    {
      provider: "Matrix",
      sessionKey: "agent:main:matrix:channel:!MixedRoomAbCdEf:example.org",
      message: "opaque session isolation proof: Matrix",
    },
    {
      provider: "Signal",
      sessionKey: "agent:main:signal:group:AbC123=",
      message: "opaque session isolation proof: Signal",
    },
  ])(
    "keeps case-distinct $provider conversations out of the visible terminal",
    async ({ sessionKey, message }) => {
      await fixture.run.write(`/session ${sessionKey}\r`, { delay: false });
      await fixture.waitForLogEntry(
        (entry) =>
          entry.method === "loadHistory" && objectFieldEquals(entry, "sessionKey", sessionKey),
      );

      const outputOffset = fixture.run.visibleOutput().length;
      await fixture.run.write(`${message}\r`, { delay: false });
      await fixture.waitForLogEntry((entry) => entry.method === "foreignSessionEvent");
      await fixture.run.waitForOutput(`PTY_RESPONSE: ${message}`);

      const sessionOutput = fixture.run.visibleOutput().slice(outputOffset);
      expect(sessionOutput).toContain(`PTY_RESPONSE: ${message}`);
      expect(sessionOutput).not.toContain("PTY_FOREIGN_OPAQUE_SESSION_MESSAGE");
    },
    TEST_TIMEOUT_MS,
  );

  it.each([
    {
      sessionKey: "agent:main:matrix:channel:!MixedRoomAbCdEf:example.org",
      message: "mixed-case matrix session identity proof",
    },
    {
      sessionKey: "agent:main:signal:group:AbC123=",
      message: "mixed-case signal session identity proof",
    },
  ])(
    "preserves provider-owned identity when selecting $sessionKey in the terminal",
    async ({ sessionKey, message }) => {
      await fixture.run.write(`/session ${sessionKey}\r`, { delay: false });
      await fixture.waitForLogEntry(
        (entry) =>
          entry.method === "loadHistory" && objectFieldEquals(entry, "sessionKey", sessionKey),
      );

      await fixture.run.write(`${message}\r`, { delay: false });
      const sent = await fixture.waitForLogEntry(
        (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", message),
      );

      expect(sent.payload).toMatchObject({ sessionKey, message });
      await fixture.run.waitForOutput(`PTY_RESPONSE: ${message}`);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "creates a backend session from /new and adopts its canonical key",
    async () => {
      await fixture.run.write("/new\r", { delay: false });
      await fixture.run.waitForOutput("new session: agent:main:tui-");
      const created = await fixture.waitForLogEntry((entry) => entry.method === "createSession");
      expect(created.payload).toMatchObject({ agentId: "main" });
      expect(created.payload).not.toHaveProperty("parentSessionKey");

      await fixture.run.write("after new\r", { delay: false });
      const sent = await fixture.waitForLogEntry(
        (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", "after new"),
      );
      expect(sent.payload).toMatchObject({ sessionKey: expect.stringMatching(/^agent:main:tui-/) });
      await fixture.run.waitForOutput("PTY_RESPONSE: after new");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "resets the current session from /reset",
    async () => {
      await fixture.run.write("/reset\r", { delay: false });
      await fixture.waitForLogEntry((entry) => {
        if (
          entry.method !== "resetSession" ||
          !objectFieldEquals(entry, "reason", "reset") ||
          typeof entry.payload !== "object" ||
          entry.payload === null
        ) {
          return false;
        }
        const key = (entry.payload as Record<string, unknown>).key;
        return typeof key === "string" && (key === "main" || key.startsWith("agent:main:"));
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps the newer session when a rapid switch's history resolves last",
    async () => {
      await fixture.run.write("/session agent:main:switch-a\r", { delay: false });
      await fixture.run.write("/session agent:main:switch-b\r", { delay: false });
      await fixture.run.waitForOutput("B_HISTORY_MARKER");
      await fixture.waitForLogEntry(
        (entry) =>
          entry.method === "loadHistoryResolved" &&
          objectFieldEquals(entry, "sessionKey", "agent:main:switch-a"),
      );

      await fixture.run.write("after switch\r", { delay: false });
      const sent = await fixture.waitForLogEntry(
        (entry) =>
          entry.method === "sendChat" && objectFieldEquals(entry, "message", "after switch"),
      );
      expect(sent.payload).toMatchObject({ sessionKey: "agent:main:switch-b" });
      expect(fixture.run.visibleOutput()).not.toContain("A_HISTORY_MARKER");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "exits cleanly from /exit",
    async () => {
      await fixture.run.write("/exit\r", { delay: false });

      const exit = await fixture.run.waitForExit();
      expect(exit.exitCode).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});
