import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { asOptionalRecord as record } from "@openclaw/normalization-core/record-coerce";
import { createComputerTool } from "../../src/agents/tools/computer-tool.js";
import { listNodes } from "../../src/agents/tools/nodes-utils.js";

const execFileAsync = promisify(execFile);
const { values } = parseArgs({
  options: {
    "window-title": { type: "string" },
    provider: { type: "string" },
    text: { type: "string" },
    artifacts: { type: "string" },
    "element-label": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
});

if (values.help) {
  console.log(
    "Usage: computer-use-macos-live-proof.ts --provider <peekaboo|cua> --window-title <title> --text <text> --artifacts <dir> [--element-label <label>]\nRuns on macOS or an X11 Linux session; native Wayland is intentionally refused.",
  );
  process.exit(0);
}

const windowTitle = values["window-title"]?.trim();
const provider = values.provider?.trim().toLowerCase();
const text = values.text;
const artifacts = values.artifacts ? path.resolve(values.artifacts) : undefined;
const elementLabel = values["element-label"]?.trim().toLowerCase();
if (
  (provider !== "peekaboo" && provider !== "cua") ||
  !windowTitle ||
  text === undefined ||
  !artifacts
) {
  throw new Error(
    "--provider (peekaboo|cua), --window-title, --text, and --artifacts are required",
  );
}
const artifactDirectory = artifacts;

type ToolResult = Awaited<ReturnType<ReturnType<typeof createComputerTool>["execute"]>>;
type JsonRecord = Record<string, unknown>;
type ActionOutcome = { kind: "result"; result: ToolResult } | { kind: "error"; error: JsonRecord };

const expectedProviderId = provider === "cua" ? "cua-computer" : "peekaboo";
const computerNodes = (await listNodes({ timeoutMs: 30_000 })).filter(
  (node) =>
    node.connected === true &&
    node.commands?.includes("computer.act") === true &&
    node.commands.includes("screen.snapshot") &&
    node.computerUse !== undefined,
);
if (computerNodes.length !== 1) {
  throw new Error(`expected exactly one connected computer node, found ${computerNodes.length}`);
}
const selectedNode = computerNodes[0]!;
const advertisedProvider = selectedNode.computerUse!.provider;
if (advertisedProvider.id !== expectedProviderId) {
  throw new Error(
    `expected provider ${expectedProviderId}, but node advertised ${advertisedProvider.id}`,
  );
}
let cleanup: ((reason: string) => Promise<void>) | undefined;
const tool = createComputerTool({
  modelHasVision: true,
  registerRunCleanup: (registered) => {
    cleanup = registered;
  },
});
let callSequence = 0;

async function call(action: string, fields: JsonRecord = {}): Promise<ToolResult> {
  callSequence += 1;
  return await tool.execute(`live-proof-${callSequence}`, {
    action,
    node: selectedNode.nodeId,
    timeoutMs: 30_000,
    ...fields,
  });
}

async function attempt(action: string, fields: JsonRecord = {}): Promise<ActionOutcome> {
  try {
    return { kind: "result", result: await call(action, fields) };
  } catch (error) {
    const candidate = error as {
      name?: unknown;
      message?: unknown;
      code?: unknown;
      gatewayCode?: unknown;
      details?: unknown;
    };
    return {
      kind: "error",
      error: {
        name: candidate?.name,
        message: candidate?.message,
        code: candidate?.code,
        gatewayCode: candidate?.gatewayCode,
        details: candidate?.details,
      },
    };
  }
}

function resultText(result: ToolResult): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function wireResult(result: ToolResult): JsonRecord {
  const details = result.details as { result?: unknown } | undefined;
  if (details?.result && typeof details.result === "object" && !Array.isArray(details.result)) {
    return details.result as JsonRecord;
  }
  for (const line of resultText(result).split("\n")) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as JsonRecord;
      }
    } catch {
      // Mutating actions prefix their follow-up screenshot with one JSON result line.
    }
  }
  throw new Error(`missing structured result: ${resultText(result)}`);
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(record).filter((entry) => entry !== undefined) : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function summarizeResult(result: ToolResult): JsonRecord {
  const raw = wireResult(result);
  const observed = record(raw.observation);
  const details = record(raw.details);
  return {
    action: raw.action,
    ok: raw.ok,
    effect: raw.effect,
    error: raw.error,
    details,
    observation: observed
      ? {
          kind: observed.kind,
          format: observed.format,
          width: observed.width,
          height: observed.height,
          observationId: observed.observationId,
          elements: records(observed.elements).map((element) => ({
            elementRef: element.elementRef,
            role: element.role,
            label: element.label,
            value: element.value,
            bounds: element.bounds,
          })),
        }
      : undefined,
  };
}

function summarizeOutcome(outcome: ActionOutcome): JsonRecord {
  return outcome.kind === "result" ? summarizeResult(outcome.result) : { error: outcome.error };
}

async function saveImage(name: string, result: ToolResult): Promise<string> {
  const image = result.content.find((block) => block.type === "image");
  if (!image || image.type !== "image") {
    throw new Error(`missing model-visible image in ${name}`);
  }
  const extension = image.mimeType === "image/jpeg" ? "jpeg" : "png";
  const output = path.join(artifactDirectory, `${name}.${extension}`);
  await writeFile(output, Buffer.from(image.data, "base64"));
  return output;
}

type FrontmostState = { kind: "application" | "window"; name: string };

async function frontmostState(): Promise<FrontmostState> {
  if (process.platform === "darwin") {
    const script =
      'tell application "System Events" to get name of first application process whose frontmost is true';
    const { stdout } = await execFileAsync("/usr/bin/osascript", ["-e", script]);
    return { kind: "application", name: stdout.trim() };
  }
  if (process.platform === "linux") {
    if (process.env.XDG_SESSION_TYPE === "wayland" || process.env.WAYLAND_DISPLAY) {
      throw new Error("Linux live proof requires X11; native Wayland is out of scope");
    }
    const { stdout: windowId } = await execFileAsync("xdotool", ["getactivewindow"]);
    const { stdout: title } = await execFileAsync("xdotool", ["getwindowname", windowId.trim()]);
    return { kind: "window", name: title.trim() };
  }
  throw new Error(`frontmost-window proof is unsupported on ${process.platform}`);
}

function isTargetFrontmost(frontmost: FrontmostState, target: JsonRecord): boolean {
  const targetIdentity = frontmost.kind === "application" ? target.appName : target.title;
  return typeof targetIdentity === "string" && frontmost.name === targetIdentity;
}

function cursor(result: ToolResult): { x: unknown; y: unknown } {
  const details = record(wireResult(result).details);
  return { x: details?.x, y: details?.y };
}

function observation(result: ToolResult): JsonRecord {
  const value = record(wireResult(result).observation);
  if (!value) {
    throw new Error(`missing observation: ${resultText(result)}`);
  }
  return value;
}

function selectElement(result: ToolResult): JsonRecord {
  const elements = records(observation(result).elements);
  const editable = elements.filter((element) =>
    ["AXTextArea", "AXTextField", "text_area", "text_field"].includes(stringValue(element.role)),
  );
  const selected = elementLabel
    ? editable.find((element) => stringValue(element.label).toLowerCase().includes(elementLabel))
    : editable[0];
  if (!selected) {
    throw new Error(`no editable element matched ${elementLabel ?? "the target window"}`);
  }
  return selected;
}

function structuredOutcome(outcome: ActionOutcome): boolean {
  if (outcome.kind === "error") {
    return typeof outcome.error.code === "string" || typeof outcome.error.gatewayCode === "string";
  }
  const raw = wireResult(outcome.result);
  if (raw.effect === "confirmed") {
    return true;
  }
  const error = record(raw.error);
  return raw.ok === false && typeof error?.code === "string" && error.code.length > 0;
}

async function runProof(targetTitle: string): Promise<void> {
  await mkdir(artifactDirectory, { recursive: true });
  const screenshot = await call("screenshot");
  const listed = await call("list_windows");
  const windows = records(record(wireResult(listed).details)?.windows);
  const target = windows.find((window) => stringValue(window.title).includes(targetTitle));
  if (!target || typeof target.windowRef !== "string") {
    throw new Error(`window containing ${JSON.stringify(targetTitle)} was not found`);
  }

  const before = await call("get_window_state", { windowRef: target.windowRef });
  const beforeImage = await saveImage("window-before", before);
  const beforeObservation = observation(before);
  const beforeElement = selectElement(before);
  const observationId = beforeObservation.observationId;
  if (typeof observationId !== "string" || typeof beforeElement.elementRef !== "string") {
    throw new Error("target observation did not provide stable element references");
  }

  const targetFields = {
    windowRef: target.windowRef,
    elementRef: beforeElement.elementRef,
    observationId,
    deliveryMode: "background",
  };
  const frontmostBefore = await frontmostState();
  if (isTargetFrontmost(frontmostBefore, target)) {
    throw new Error(
      `target ${frontmostBefore.kind} ${frontmostBefore.name || "<unknown>"} is frontmost; foreground another window and retry`,
    );
  }
  const cursorBeforeResult = await call("get_cursor_position");
  const click = await attempt("left_click", targetFields);
  const typed = await attempt("type", { ...targetFields, text });

  let confirmation: ActionOutcome | undefined;
  if (typed.kind === "error" || wireResult(typed.result).effect !== "confirmed") {
    const refreshed = await call("get_window_state", { windowRef: target.windowRef });
    const refreshedObservation = observation(refreshed);
    const refreshedElement = selectElement(refreshed);
    confirmation = await attempt("set_value", {
      windowRef: target.windowRef,
      elementRef: refreshedElement.elementRef,
      observationId: refreshedObservation.observationId,
      deliveryMode: "background",
      value: text,
    });
  }

  const cursorAfterResult = await call("get_cursor_position");
  const frontmostAfter = await frontmostState();
  const after = await call("get_window_state", { windowRef: target.windowRef });
  const afterImage = await saveImage("window-after", after);
  const afterElement = selectElement(after);
  const cursorBefore = cursor(cursorBeforeResult);
  const cursorAfter = cursor(cursorAfterResult);
  const finalOutcome = confirmation ?? typed;

  const evidence = {
    route: "agent computer tool -> Gateway node.invoke -> paired node -> selected provider",
    platform: process.platform,
    provider: { expected: expectedProviderId, advertised: advertisedProvider },
    screenshot: resultText(screenshot),
    target: {
      windowRef: target.windowRef,
      appName: target.appName,
      title: target.title,
      bounds: target.bounds,
    },
    frontmost: { before: frontmostBefore, after: frontmostAfter },
    cursor: { before: cursorBefore, after: cursorAfter },
    values: { before: beforeElement.value, after: afterElement.value },
    results: {
      listWindows: {
        action: wireResult(listed).action,
        ok: wireResult(listed).ok,
        windowCount: windows.length,
      },
      before: summarizeResult(before),
      click: summarizeOutcome(click),
      type: summarizeOutcome(typed),
      confirmation: confirmation ? summarizeOutcome(confirmation) : undefined,
      after: summarizeResult(after),
    },
    artifacts: { beforeImage, afterImage },
    assertions: {
      targetWasNotFrontmost: !isTargetFrontmost(frontmostBefore, target),
      frontmostUnchanged:
        frontmostBefore.kind === frontmostAfter.kind &&
        frontmostBefore.name === frontmostAfter.name,
      cursorUnchanged: cursorBefore.x === cursorAfter.x && cursorBefore.y === cursorAfter.y,
      targetContentChanged: beforeElement.value !== afterElement.value,
      confirmedEffectOrStructuredRefusal: structuredOutcome(finalOutcome),
    },
  };

  const output = path.join(artifactDirectory, "result.json");
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));

  if (!Object.values(evidence.assertions).every(Boolean)) {
    process.exitCode = 1;
  }
}

// Settle the entire proof before closing its execution, never individual actions.
await runProof(windowTitle).then(
  () => cleanup?.("completion"),
  async (error: unknown) => {
    try {
      await cleanup?.("error");
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Computer-use proof and cleanup failed", {
        cause: cleanupError,
      });
    }
    throw error;
  },
);
