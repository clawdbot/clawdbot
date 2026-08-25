// Exercises the fake-backend TUI PTY harness and visible terminal output.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sleep } from "../utils/sleep.js";
import { exerciseTuiCommandSurface } from "./tui-pty-command-surfaces-test-support.js";
import {
  approveWorkspaceSkill,
  COMPACT_TERMINAL_SIZES,
  disposeActiveTuiFixtures,
  exerciseFragmentedUnicodePrompt,
  exerciseNarrowTerminalRendering,
  exerciseTerminalOutputSafety,
  objectFieldEquals,
  readFixtureLog,
  startTuiFixture,
  waitForSynchronizedFrameRows,
  type FixtureLogEntry,
} from "./tui-pty-harness-fixture-test-support.js";
import { exerciseTuiReconnectOutcomes } from "./tui-pty-reconnect-test-support.js";
import {
  exerciseStreamingRendering,
  exerciseToolCardRendering,
  streamingPrefixFrame,
  toolFrame,
} from "./tui-pty-rendering-test-support.js";
const STARTUP_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 5_000;
const STARTUP_TEST_TIMEOUT_MS = 25_000;

const countFixtureCalls = (entries: FixtureLogEntry[], method: string) =>
  entries.filter((entry) => entry.method === method).length;

const countFixtureMessages = (entries: FixtureLogEntry[], message: string) =>
  entries.filter(
    (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", message),
  ).length;

it("rejects rendering oracle false positives", () => {
  const tokens = Array.from({ length: 64 }, (_, i) => `T${String(i).padStart(3, "0")}`);
  const promptFrame = [`burst streaming proof ${tokens.join(" ")}`, "local ready | idle"];
  const reversedTool = ["PTY_BEFORE_TOOL PTY_TOOL_PARTIAL Read File (running)"];
  expect(streamingPrefixFrame(promptFrame)).toBe(false);
  expect(toolFrame(reversedTool, false)).toBe(false);
});

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
    await disposeActiveTuiFixtures();
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
    "keeps session modes scoped while trace changes and delivery stays process-owned",
    async () => {
      const modeFixture = await startTuiFixture({
        env: {
          OPENCLAW_TUI_PTY_DELIVER: "1",
          OPENCLAW_TUI_PTY_MODEL: "fixture-model",
        },
      });
      try {
        await modeFixture.run.waitForOutput("deliver:on", STARTUP_TIMEOUT_MS);
        await modeFixture.run.write("/session agent:main:mode-source\r", { delay: false });
        await modeFixture.waitForLogEntry(
          (entry) =>
            entry.method === "loadHistory" &&
            objectFieldEquals(entry, "sessionKey", "agent:main:mode-source"),
        );
        await modeFixture.run.waitForOutput(
          "trace:raw | reasoning:stream | deliver:on",
          STARTUP_TIMEOUT_MS,
        );

        const targetOutputOffset = modeFixture.run.visibleOutput().length;
        await modeFixture.run.write("/session agent:main:mode-target\r", { delay: false });
        await modeFixture.waitForLogEntry(
          (entry) =>
            entry.method === "loadHistory" &&
            objectFieldEquals(entry, "sessionKey", "agent:main:mode-target"),
        );
        await modeFixture.run.waitForOutput("session mode-target", STARTUP_TIMEOUT_MS);
        const targetOutput = modeFixture.run.visibleOutput().slice(targetOutputOffset);
        expect(targetOutput).toContain("deliver:on");
        expect(targetOutput).not.toContain("fast:auto");
        expect(targetOutput).not.toContain("verbose full");
        expect(targetOutput).not.toContain("trace:raw");
        expect(targetOutput).not.toContain("reasoning:stream");

        await modeFixture.run.write("/trace on\r", { delay: false });
        await modeFixture.waitForLogEntry(
          (entry) =>
            entry.method === "patchSession" && objectFieldEquals(entry, "traceLevel", "on"),
        );
        await modeFixture.run.waitForOutput("trace | deliver:on", STARTUP_TIMEOUT_MS);

        await modeFixture.run.write("delivery proof\r", { delay: false });
        const sent = await modeFixture.waitForLogEntry(
          (entry) =>
            entry.method === "sendChat" && objectFieldEquals(entry, "message", "delivery proof"),
        );
        expect(sent.payload).toMatchObject({ deliver: true });
        console.log(
          `[behavior-evidence] tui-session-footer ${JSON.stringify({
            terminal: "real PTY",
            sourceModesVisible: true,
            targetModesCleared: true,
            traceTransitionVisible: true,
            fixedDeliveryPropagated: true,
          })}`,
        );
      } finally {
        await modeFixture.cleanup();
      }
    },
    STARTUP_TEST_TIMEOUT_MS,
  );

  it(
    "keeps the launch thinking override active across session-level changes",
    async () => {
      const footerNeedle = "fixture-provider/fixture-model high | deliver:off | tokens";
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
      expect(outputAfterSessionChange).not.toContain(
        "fixture-provider/fixture-model low | deliver:off | tokens",
      );
      expect(outputAfterSessionChange).not.toContain(
        "fixture-provider/fixture-model medium | deliver:off | tokens",
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

  it(
    "reconciles active, replacement, and terminal runs after reconnect history",
    () => exerciseTuiReconnectOutcomes(35_000),
    45_000,
  );

  it.each([{ failures: 1 }, { failures: 2 }, { failures: 3 }, { failures: 4 }])(
    "recovers session subscription after $failures startup failures",
    async ({ failures }) => {
      const subscriptionFixture = await startTuiFixture({
        env: { OPENCLAW_TUI_PTY_SUBSCRIBE_FAILURES: String(failures) },
      });
      try {
        await subscriptionFixture.run.waitForOutput("local ready | idle", STARTUP_TIMEOUT_MS);
        const entries = await readFixtureLog(subscriptionFixture.logPath);
        expect(countFixtureCalls(entries, "subscribeSessionEvents")).toBe(failures + 1);
        expect(countFixtureCalls(entries, "subscribeSessionFailure")).toBe(failures);

        await subscriptionFixture.run.write("after subscription recovery proof\r");
        await subscriptionFixture.run.waitForOutput(
          "PTY_RESPONSE: after subscription recovery proof",
          STARTUP_TIMEOUT_MS,
        );
      } finally {
        await subscriptionFixture.cleanup();
      }
    },
    STARTUP_TEST_TIMEOUT_MS,
  );

  it(
    "blocks submits after subscription exhaustion until reconnect succeeds",
    async () => {
      const subscriptionFixture = await startTuiFixture({
        env: {
          OPENCLAW_TUI_PTY_SUBSCRIBE_FAILURES: "5",
          OPENCLAW_TUI_PTY_SUBSCRIBE_RECONNECT: "1",
        },
      });
      try {
        await subscriptionFixture.run.waitForOutput(
          "session event subscribe failed",
          STARTUP_TIMEOUT_MS,
        );
        const entries = await readFixtureLog(subscriptionFixture.logPath);
        expect(countFixtureCalls(entries, "subscribeSessionEvents")).toBe(5);
        expect(countFixtureCalls(entries, "subscribeSessionFailure")).toBe(5);
        expect(entries.some((entry) => entry.method === "loadHistory")).toBe(false);
        expect(subscriptionFixture.run.visibleOutput()).not.toContain("local ready | idle");

        const message = "after subscription reconnect proof";
        await subscriptionFixture.run.write(`${message}\r`, { delay: false });
        await subscriptionFixture.run.waitForOutput(
          "local runtime not ready — message not sent",
          STARTUP_TIMEOUT_MS,
        );
        const blockedEntries = await readFixtureLog(subscriptionFixture.logPath);
        expect(countFixtureMessages(blockedEntries, message)).toBe(0);

        await subscriptionFixture.run.write("\x03", { delay: false });
        await subscriptionFixture.run.waitForOutput("cleared input", STARTUP_TIMEOUT_MS);
        await subscriptionFixture.run.write("/gateway-status\r", { delay: false });
        await subscriptionFixture.waitForLogEntry(
          (entry) => entry.method === "subscriptionReconnect",
          STARTUP_TIMEOUT_MS,
        );
        await subscriptionFixture.run.waitForOutput("local ready | idle", STARTUP_TIMEOUT_MS);
        await subscriptionFixture.run.write(`${message}\r`, { delay: false });
        await subscriptionFixture.run.waitForOutput(`PTY_RESPONSE: ${message}`, STARTUP_TIMEOUT_MS);
        const reconnectedEntries = await readFixtureLog(subscriptionFixture.logPath);
        expect(countFixtureMessages(reconnectedEntries, message)).toBe(1);
      } finally {
        await subscriptionFixture.cleanup();
      }
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
    "renders each live assistant reply once without replaying stale history",
    async () => {
      const liveFixture = await startTuiFixture({
        env: { OPENCLAW_TUI_PTY_COLS: "220", OPENCLAW_TUI_PTY_ROWS: "50" },
      });
      try {
        await liveFixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);
        await liveFixture.run.write("live reply dedupe proof: first\r", { delay: false });
        await liveFixture.run.waitForOutput("TUI_LIVE_FIRST");
        await liveFixture.run.write("live reply dedupe proof: second\r", { delay: false });
        const rows = await waitForSynchronizedFrameRows(
          liveFixture.run,
          (frame) => frame.some((row) => row.includes("TUI_LIVE_SECOND")),
          STARTUP_TIMEOUT_MS,
        );
        const assistantRows = rows.filter(
          (row) => row.includes("TUI_LIVE_FIRST") || row.includes("TUI_LIVE_SECOND"),
        );
        expect(assistantRows).toEqual(["TUI_LIVE_FIRST", "TUI_LIVE_SECOND"]);
      } finally {
        await liveFixture.cleanup();
      }
    },
    STARTUP_TEST_TIMEOUT_MS,
  );
  // prettier-ignore
  const editorInputCases = [
    ["recalls submitted input history through literal terminal navigation", [["w", "history recall proof\r"], ["s", "history recall proof"], ["o", "PTY_RESPONSE: history recall proof"], ["w", "\u001b[A\u0005 edited\r"], ["s", "history recall proof edited"]]],
    ["applies literal terminal shortcuts before submitting editor input",
      [["w", "discard this input"], ["w", "\u0003"], ["o", "cleared input; press ctrl+c again to exit"], ["w", "shortcut kept input\r"], ["s", "shortcut kept input"], ["n", "discard this input"]]],
    ["handles bracketed paste and rejects the pasted submit while busy",
      [["w", "\u001b[200~bracketed paste proof\u001b[201~\r"], ["s", "bracketed paste proof"], ["o", "PTY_RESPONSE: bracketed paste proof"], ["w", "slow prompt\r"], ["s", "slow prompt"],
        ["w", "\u001b[200~busy pasted prompt\u001b[201~\r"], ["o", "agent is busy"], ["o", "PTY_RESPONSE: slow prompt"], ["n", "busy pasted prompt"]]],
    ["submits fragmented IME text and Kitty AltGr printable bytes", [["w", "日本"], ["w", "語 "], ["w", "\u001b[64::113;7u\u001b[8364::101;7u\r"], ["s", "日本語 @€"], ["o", "PTY_RESPONSE: 日本語 @€"]]],
  ] as const;
  it.each(editorInputCases)(
    "%s",
    async (_name, steps) => {
      const tui = await startTuiFixture();
      try {
        await tui.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);
        for (const [action, value] of steps) {
          // prettier-ignore
          const sent = (entry: FixtureLogEntry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", value);
          // prettier-ignore
          await { w: () => tui.run.write(value, { delay: false }), o: () => tui.run.waitForOutput(value), s: () => tui.waitForLogEntry(sent), n: async () => expect((await readFixtureLog(tui.logPath)).some(sent)).toBe(false) }[action]();
        }
      } finally {
        await tui.cleanup();
      }
    },
    STARTUP_TEST_TIMEOUT_MS,
  );
  it(
    "preserves consecutive backspaces received in the same terminal input chunk",
    async () => {
      await fixture.run.write("abc\x7f\x7f\r", { delay: false });

      const sent = await fixture.waitForLogEntry(
        (entry) =>
          entry.method === "sendChat" &&
          (objectFieldEquals(entry, "message", "a") || objectFieldEquals(entry, "message", "ab")),
      );
      expect(sent.payload).toMatchObject({ message: "a" });
      await fixture.run.waitForOutput("PTY_RESPONSE: a");
    },
    TEST_TIMEOUT_MS,
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
    "cancels a buffered submit before Ctrl+D shutdown",
    async () => {
      const bufferedFixture = await startTuiFixture({
        env: { OPENCLAW_TUI_PTY_SUBMIT_BURST_WINDOW_MS: "500" },
      });
      try {
        const message = "buffered shutdown proof";
        await bufferedFixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);
        await bufferedFixture.run.write(`${message}\r`, { delay: false });
        await bufferedFixture.waitForLogEntry(
          (entry) =>
            entry.method === "submitBurstCaptured" && objectFieldEquals(entry, "value", message),
        );

        await bufferedFixture.run.write("\u0004", { delay: false });
        expect((await bufferedFixture.run.waitForExit()).exitCode).toBe(0);

        const entries = await readFixtureLog(bufferedFixture.logPath);
        expect(entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ method: "stop" })]),
        );
        expect(
          entries.some(
            (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", message),
          ),
        ).toBe(false);
      } finally {
        await bufferedFixture.cleanup();
      }
    },
    STARTUP_TEST_TIMEOUT_MS,
  );

  it.each([
    { name: "Ctrl+D", input: "\u0004" },
    { name: "/exit", input: "/exit\r" },
  ])(
    "stops the real terminal cleanly when $name interrupts an active run",
    async ({ input }) => {
      const busyFixture = await startTuiFixture();
      try {
        await busyFixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);
        await busyFixture.run.write("slow prompt\r", { delay: false });
        await busyFixture.waitForLogEntry(
          (entry) =>
            entry.method === "sendChat" && objectFieldEquals(entry, "message", "slow prompt"),
        );

        await busyFixture.run.write(input, { delay: false });

        expect((await busyFixture.run.waitForExit()).exitCode).toBe(0);
        expect(await readFixtureLog(busyFixture.logPath)).toEqual(
          expect.arrayContaining([expect.objectContaining({ method: "stop" })]),
        );
      } finally {
        await busyFixture.cleanup();
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
    "keeps Enter focused on model and session pickers beside a side result in a 20×18 terminal",
    async () => {
      const compactPickerFixture = await startTuiFixture({
        env: {
          OPENCLAW_TUI_PTY_COLS: "20",
          OPENCLAW_TUI_PTY_ROWS: "18",
          OPENCLAW_TUI_PTY_PICKER_FIXTURE: "1",
        },
      });

      try {
        await compactPickerFixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);
        await compactPickerFixture.run.write("/btw picker focus proof\r", { delay: false });
        await compactPickerFixture.waitForLogEntry((entry) => entry.method === "pickerSideResult");

        await compactPickerFixture.run.write("\u000c", { delay: false });
        await compactPickerFixture.waitForLogEntry((entry) => entry.method === "listModels");
        await compactPickerFixture.run.write("\u001b[B", { delay: false });
        await compactPickerFixture.run.write("\r", { delay: false });
        await compactPickerFixture.waitForLogEntry(
          (entry) =>
            entry.method === "patchSession" &&
            objectFieldEquals(entry, "model", "fixture-provider/fixture-model-2"),
        );

        await compactPickerFixture.run.write("\u0010", { delay: false });
        await compactPickerFixture.waitForLogEntry(
          (entry) =>
            entry.method === "listSessions" && objectFieldEquals(entry, "purpose", "picker"),
        );
        await compactPickerFixture.run.write("\u001b[B", { delay: false });
        await compactPickerFixture.run.write("\r", { delay: false });
        await compactPickerFixture.waitForLogEntry(
          (entry) =>
            entry.method === "loadHistory" &&
            objectFieldEquals(entry, "sessionKey", "agent:main:picker-target"),
        );

        await compactPickerFixture.run.write("picker target proof\r", { delay: false });
        const sent = await compactPickerFixture.waitForLogEntry(
          (entry) =>
            entry.method === "sendChat" &&
            objectFieldEquals(entry, "message", "picker target proof"),
        );
        expect(sent.payload).toMatchObject({ sessionKey: "agent:main:picker-target" });
      } finally {
        await compactPickerFixture.cleanup();
      }
    },
    STARTUP_TEST_TIMEOUT_MS,
  );

  it(
    "recovers the visible conversation from session history after a Gateway event gap",
    async () => {
      const gapFixture = await startTuiFixture();
      try {
        await gapFixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);
        await gapFixture.run.write("history gap proof\r");
        await gapFixture.waitForLogEntry((entry) => entry.method === "gapHistoryRecovered");
        await gapFixture.run.waitForOutput("PTY_GAP_RECOVERED");
        const gapNotice = "gateway event gap: expected 4, got 5";
        await gapFixture.run.waitForOutput(gapNotice);
        const recoveredOutput = gapFixture.run.visibleOutput();
        expect(recoveredOutput.lastIndexOf(gapNotice)).toBeGreaterThan(
          recoveredOutput.lastIndexOf("PTY_GAP_RECOVERED"),
        );

        await gapFixture.run.write("after gap recovery proof\r");
        await gapFixture.waitForLogEntry(
          (entry) =>
            entry.method === "sendChat" &&
            objectFieldEquals(entry, "message", "after gap recovery proof"),
        );
        await gapFixture.run.waitForOutput("PTY_RESPONSE: after gap recovery proof");
      } finally {
        await gapFixture.cleanup();
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
      await fixture.run.waitForOutput("Press Enter again to start this task.");
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
    "renders an attachment-only assistant reply without exposing its source",
    async () => {
      await fixture.run.write("attachment-only assistant proof\r");
      await fixture.waitForLogEntry((entry) => entry.method === "attachmentOnlyComplete");
      await fixture.run.waitForOutput("Attached image");

      const rendered = fixture.run.visibleOutput();
      expect(rendered).not.toContain("SECRET_PTY_IMAGE_BYTES");
      expect(rendered).not.toContain("SECRET_PTY_ARTIFACT");
      expect(rendered).not.toContain("/Users/operator/private");
    },
    TEST_TIMEOUT_MS,
  );

  // Keep these producer-matched cases data-driven because this harness is at its line budget.
  // prettier-ignore
  const terminalSafetyCases = [
    ["renders long Unicode output and copy-safe URLs in narrow real PTY frames", () => exerciseNarrowTerminalRendering(startTuiFixture, STARTUP_TIMEOUT_MS)],
    ["sanitizes ANSI OSC and C1 payloads across real PTY display boundaries", () => exerciseTerminalOutputSafety(startTuiFixture, STARTUP_TIMEOUT_MS)],
  ] as const;
  it.each(terminalSafetyCases)("%s", async (_name, runCase) => runCase(), STARTUP_TEST_TIMEOUT_MS);

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
    "renders redacted, cause-aware send failures in the real terminal loop",
    async () => {
      await fixture.run.write("tui error redaction proof\r");
      await fixture.run.waitForOutput("send failed: gateway down");
      await fixture.run.waitForOutput("Authorization: Bearer");

      expect(fixture.run.visibleOutput()).not.toContain("sk-abcdefghijklmnopqrstuv");
      await fixture.waitForLogEntry(
        (entry) =>
          entry.method === "sendChat" &&
          objectFieldEquals(entry, "message", "tui error redaction proof"),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "authenticates running partial and completed tool cards in real terminal frames",
    async () => await exerciseToolCardRendering(startTuiFixture, STARTUP_TIMEOUT_MS),
    STARTUP_TEST_TIMEOUT_MS,
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
    "authenticates a streamed prefix before the complete ordered final frame",
    async () => await exerciseStreamingRendering(startTuiFixture, STARTUP_TIMEOUT_MS),
    STARTUP_TEST_TIMEOUT_MS,
  );

  it(
    "ignores delayed aborts and streamed events from the previously selected session",
    async () => {
      const isolationFixture = await startTuiFixture();
      const sourceSessionKey = "agent:main:abort-source";
      const targetSessionKey = "agent:main:abort-target";

      try {
        await isolationFixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);
        await isolationFixture.run.write(`/session ${sourceSessionKey}\r`, { delay: false });
        await isolationFixture.waitForLogEntry(
          (entry) =>
            entry.method === "loadHistory" &&
            objectFieldEquals(entry, "sessionKey", sourceSessionKey),
        );
        await isolationFixture.run.write("cross-session abort source proof\r", { delay: false });
        await isolationFixture.waitForLogEntry(
          (entry) =>
            entry.method === "sendChat" &&
            objectFieldEquals(entry, "message", "cross-session abort source proof"),
        );

        await isolationFixture.run.write("/abort\r", { delay: false });
        await isolationFixture.waitForLogEntry(
          (entry) =>
            entry.method === "abortChat" &&
            objectFieldEquals(entry, "sessionKey", sourceSessionKey),
        );
        const outputOffset = isolationFixture.run.visibleOutput().length;
        await isolationFixture.run.write(`/session ${targetSessionKey}\r`, { delay: false });
        await isolationFixture.waitForLogEntry(
          (entry) =>
            entry.method === "loadHistory" &&
            objectFieldEquals(entry, "sessionKey", targetSessionKey),
        );
        await isolationFixture.waitForLogEntry(
          (entry) =>
            entry.method === "abortResolved" &&
            objectFieldEquals(entry, "sessionKey", sourceSessionKey),
        );
        await isolationFixture.waitForLogEntry(
          (entry) =>
            entry.method === "lateSessionEvent" &&
            objectFieldEquals(entry, "sessionKey", sourceSessionKey) &&
            objectFieldEquals(entry, "state", "final"),
        );

        const targetOutput = isolationFixture.run.visibleOutput().slice(outputOffset);
        expect(targetOutput).not.toContain("PTY_LATE_FOREIGN_DELTA");
        expect(targetOutput).not.toContain("PTY_LATE_FOREIGN_FINAL");

        await isolationFixture.run.write("cross-session target proof\r", { delay: false });
        const sent = await isolationFixture.waitForLogEntry(
          (entry) =>
            entry.method === "sendChat" &&
            objectFieldEquals(entry, "message", "cross-session target proof"),
        );
        expect(sent.payload).toMatchObject({ sessionKey: targetSessionKey });
        await isolationFixture.run.waitForOutput("PTY_RESPONSE: cross-session target proof");
      } finally {
        await isolationFixture.cleanup();
      }
    },
    STARTUP_TEST_TIMEOUT_MS,
  );

  it.each([
    ["lists and executes slash commands through authenticated real PTY frames", "slash-commands"],
    ["selects model and session pickers through authenticated real PTY frames", "pickers"],
    ["updates settings through an authenticated real PTY overlay", "settings"],
  ] as const)(
    "%s",
    (_name, surface) => exerciseTuiCommandSurface(startTuiFixture, surface, STARTUP_TIMEOUT_MS),
    STARTUP_TEST_TIMEOUT_MS,
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
