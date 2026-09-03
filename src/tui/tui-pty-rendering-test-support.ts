import { writeFile } from "node:fs/promises";
import {
  type StartTuiPtyFixture,
  waitForSynchronizedFrameRows,
} from "./tui-pty-harness-assertion-test-support.js";
const STREAM_PROMPT = "burst streaming proof";
const TOOL_PROMPT = "tool chronology proof";
const TOKENS = Array.from({ length: 128 }, (_, index) => `T${String(index).padStart(3, "0")}`);
const dimensions = { OPENCLAW_TUI_PTY_COLS: "120", OPENCLAW_TUI_PTY_ROWS: "32" };
type Fixture = Awaited<ReturnType<StartTuiPtyFixture>>;
const text = (rows: string[]) => rows.join("\n");
const tokens = (rows: string[]) => text(rows).match(/\bT\d{3}\b/gu) ?? [];
const occurrences = (value: string, marker: string) => value.split(marker).length - 1;
export function streamingPrefixFrame(rows: string[]) {
  return (
    tokens(rows).join(",") === TOKENS.slice(0, 64).join(",") &&
    rows.some((row) => row.includes("streaming") && row.endsWith("| local ready"))
  );
}
export function toolFrame(rows: string[], complete: boolean) {
  const frame = text(rows);
  if (!complete) {
    const before = frame.indexOf("PTY_BEFORE_TOOL");
    const running = frame.indexOf("Read File (running)");
    const partial = frame.indexOf("PTY_TOOL_PARTIAL");
    return (
      before >= 0 &&
      running >= 0 &&
      partial >= 0 &&
      before < running &&
      running < partial &&
      frame.includes("# PTY_TOOL_PARTIAL") &&
      frame.includes("```")
    );
  }
  const markers = ["PTY_BEFORE_TOOL", "Read File", "PTY_TOOL_RESULT", "PTY_AFTER_TOOL"];
  return (
    markers.every(
      (marker, index) =>
        occurrences(frame, marker) === 1 &&
        (index === 0 || frame.indexOf(markers[index - 1]!) < frame.indexOf(marker)),
    ) &&
    !frame.includes("(running)") &&
    !frame.includes("PTY_TOOL_PARTIAL") &&
    frame.includes("> PTY_TOOL_RESULT") &&
    frame.includes("```") &&
    frame.includes("idle")
  );
}
const release = async (fixture: Fixture, gate: string) =>
  await writeFile(`${fixture.logPath}.${gate}.release`, "release\n", "utf8");
async function withFixture(
  start: StartTuiPtyFixture,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  exercise: (fixture: Fixture) => Promise<void>,
) {
  const fixture = await start({ env: { ...dimensions, ...env } });
  try {
    await fixture.run.waitForOutput("local ready", timeoutMs);
    await exercise(fixture);
  } finally {
    await fixture.cleanup();
  }
}
export async function exerciseStreamingRendering(start: StartTuiPtyFixture, timeoutMs: number) {
  await withFixture(start, {}, timeoutMs, async (fixture) => {
    await fixture.run.write(`${STREAM_PROMPT}\r`, { delay: false });
    await waitForSynchronizedFrameRows(
      fixture.run,
      (rows) => streamingPrefixFrame(rows),
      timeoutMs,
    );
    await release(fixture, "streaming");
    await waitForSynchronizedFrameRows(
      fixture.run,
      (rows) => tokens(rows).join(",") === TOKENS.join(",") && text(rows).includes("idle"),
      timeoutMs,
    );
  });
}
export async function exerciseToolCardRendering(start: StartTuiPtyFixture, timeoutMs: number) {
  await withFixture(
    start,
    {
      OPENCLAW_TUI_PTY_MODEL: "fixture-provider/fixture-model",
      OPENCLAW_TUI_PTY_VERBOSE_LEVEL: "full",
    },
    timeoutMs,
    async (fixture) => {
      await fixture.run.write(`${TOOL_PROMPT}\r`, { delay: false });
      await waitForSynchronizedFrameRows(fixture.run, (rows) => toolFrame(rows, false), timeoutMs);
      await release(fixture, "tool");
      await waitForSynchronizedFrameRows(fixture.run, (rows) => toolFrame(rows, true), timeoutMs);
    },
  );
}
export const TUI_PTY_RENDERING_FIXTURE_SCRIPT = `
  const renderingTokens = Array.from({ length: 128 }, (_, i) => "T" + String(i).padStart(3, "0"));
  async function waitForRenderingRelease(gate: string) {
    const target = actionLogPath + "." + gate + ".release";
    if (existsSync(target)) return;
    await new Promise<void>((resolve) => {
      const check = () => {
        if (existsSync(target)) { unwatchFile(target, check); resolve(); }
      };
      // Release is file state; native watch delivery can outlast the fixture budget.
      watchFile(target, { interval: 50, persistent: false }, check);
      check();
    });
  }
  function emitAssistant(backend, runId, sessionKey, state, value) {
    backend.onEvent?.({ event: "chat", payload: { runId, sessionKey, state,
      message: { role: "assistant", content: [{ type: "text", text: value }], timestamp: Date.now() } } });
  }
  async function runStreamingRendering(backend, runId, sessionKey) {
    for (let i = 0; i < 64; i += 1) emitAssistant(backend, runId, sessionKey, "delta", "PTY_STREAM_BURST: " + renderingTokens.slice(0, i + 1).join(" "));
    record("streamingPrefixReady", { runId, count: 64 }); await waitForRenderingRelease("streaming");
    for (let i = 64; i < 128; i += 1) emitAssistant(backend, runId, sessionKey, "delta", "PTY_STREAM_BURST: " + renderingTokens.slice(0, i + 1).join(" "));
    emitAssistant(backend, runId, sessionKey, "final", "PTY_STREAM_BURST: " + renderingTokens.join(" ")); record("streamingComplete", { runId, count: 128 });
  }
  async function runToolCardRendering(backend, runId, sessionKey) {
    emitAssistant(backend, runId, sessionKey, "delta", "PTY_BEFORE_TOOL");
    const base = { toolCallId: "pty-rendering-tool", name: process.env.OPENCLAW_TUI_PTY_TOOL_NAME ?? "read_file" };
    backend.onEvent?.({ event: "agent", payload: { runId, sessionKey, stream: "tool", data: { ...base, phase: "start", args: { path: "chronology-proof.txt" } } } });
    if (process.env.OPENCLAW_TUI_PTY_VERBOSE_LEVEL === "full") {
      backend.onEvent?.({ event: "agent", payload: { runId, sessionKey, stream: "tool", data: { ...base, phase: "update", partialResult: { content: [{ type: "text", text: "    # PTY_TOOL_PARTIAL" }] } } } });
      record("toolPartialReady", { runId }); await waitForRenderingRelease("tool");
      backend.onEvent?.({ event: "agent", payload: { runId, sessionKey, stream: "tool", data: { ...base, phase: "result", result: { content: [{ type: "text", text: "    > PTY_TOOL_RESULT" }] } } } });
    }
    const finalText = "PTY_BEFORE_TOOL\\n\\nPTY_AFTER_TOOL"; emitAssistant(backend, runId, sessionKey, "delta", finalText); emitAssistant(backend, runId, sessionKey, "final", finalText); record("toolComplete", { runId }); record("toolChronologyComplete", { runId });
  }
  function startRenderingFixture(backend, message, runId, sessionKey) {
    const task = message === ${JSON.stringify(STREAM_PROMPT)} ? runStreamingRendering : message === ${JSON.stringify(TOOL_PROMPT)} ? runToolCardRendering : undefined;
    if (!task) return false; void task(backend, runId, sessionKey); return true;
  }
`;
