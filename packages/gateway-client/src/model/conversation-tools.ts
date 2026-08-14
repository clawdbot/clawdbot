import type {
  ControlModelConversationBounds,
  ControlModelToolStatus,
} from "./conversation-types.js";
import {
  boundedValue,
  cloneAndFreeze,
  normalizeStatus,
  record,
  text,
} from "./conversation-utils.js";

type ToolState = {
  runId: string;
  toolCallId: string;
  name: string | null;
  status: ControlModelToolStatus;
  phase: string;
  input: unknown;
  output: unknown;
  truncated: boolean;
  inputTruncated: boolean;
  outputTruncated: boolean;
  inputBytes: number;
  outputBytes: number;
  updates: number;
  bytes: number;
  progressTruncated: boolean;
};

export class ConversationToolStore {
  readonly #bounds: ControlModelConversationBounds;
  readonly #tools = new Map<string, ToolState>();
  #truncated = false;

  constructor(bounds: ControlModelConversationBounds) {
    this.#bounds = bounds;
  }

  get truncated(): boolean {
    return this.#truncated;
  }

  clear(): void {
    this.#tools.clear();
  }

  handle(payload: Record<string, unknown>, hasKnownRun: (runId: string) => boolean): boolean {
    const stream = text(payload.stream);
    const data = record(payload.data) ?? payload;
    if (stream !== "tool" && stream !== "item" && stream !== "command_output") {
      return false;
    }
    const runId = text(payload.runId) ?? text(data.runId);
    if (!runId || (!eventSessionKey(payload) && !hasKnownRun(runId))) {
      return false;
    }
    const toolCallId =
      text(data.toolCallId) ?? text(data.tool_call_id) ?? text(data.id) ?? "unknown";
    const key = `${runId}:${toolCallId}`;
    const phase = text(data.phase) ?? "update";
    const statusValue = normalizeStatus(data.status);
    const current: ToolState = this.#tools.get(key) ?? {
      runId,
      toolCallId,
      name: text(data.name) ?? text(data.toolName),
      status: "unknown",
      phase,
      input: null,
      output: null,
      truncated: false,
      inputTruncated: false,
      outputTruncated: false,
      inputBytes: 0,
      outputBytes: 0,
      updates: 0,
      bytes: 0,
      progressTruncated: false,
    };
    const next = {
      ...current,
      name: current.name ?? text(data.name) ?? text(data.toolName),
      phase,
      updates: current.updates + 1,
    };
    if (
      statusValue === "cancelled" ||
      statusValue === "canceled" ||
      statusValue === "aborted" ||
      phase === "cancel"
    ) {
      next.status = "cancelled";
    } else if (
      data.isError === true ||
      data.error !== undefined ||
      statusValue === "failed" ||
      statusValue === "blocked" ||
      phase === "error"
    ) {
      next.status = "failed";
    } else if (
      phase === "result" ||
      phase === "end" ||
      statusValue === "completed" ||
      statusValue === "succeeded" ||
      statusValue === "success"
    ) {
      next.status = "succeeded";
    } else if (
      phase === "start" ||
      phase === "input_delta" ||
      phase === "update" ||
      statusValue === "running"
    ) {
      next.status = "running";
    } else {
      next.status = "unknown";
    }
    if (
      (current.status === "succeeded" ||
        current.status === "failed" ||
        current.status === "cancelled") &&
      next.status === "running"
    ) {
      next.status = current.status;
    }

    const inputIsDelta = data.input_delta !== undefined;
    const input = data.input_delta ?? data.input ?? data.arguments ?? data.args;
    if (input !== undefined && !(inputIsDelta && current.inputTruncated)) {
      const value =
        inputIsDelta && typeof next.input === "string" && typeof input === "string"
          ? `${next.input}${input}`
          : input;
      const bounded = boundedValue(value, this.#bounds.maxProgressBytes);
      next.input = bounded.value;
      next.inputBytes = bounded.bytes;
      next.inputTruncated = bounded.truncated;
    }

    const outputIsDelta = data.output_delta !== undefined;
    const output =
      data.output_delta ?? data.output ?? data.result ?? data.partialResult ?? data.content;
    const remainingBytes = Math.max(0, this.#bounds.maxProgressBytes - next.inputBytes);
    if (output !== undefined && !(outputIsDelta && current.outputTruncated)) {
      const value =
        outputIsDelta && typeof next.output === "string" && typeof output === "string"
          ? `${next.output}${output}`
          : output;
      const bounded = boundedValue(value, remainingBytes);
      next.output = bounded.value;
      next.outputBytes = bounded.bytes;
      next.outputTruncated = bounded.truncated;
    } else if (next.output !== null && next.outputBytes > remainingBytes) {
      const bounded = boundedValue(next.output, remainingBytes);
      next.output = bounded.value;
      next.outputBytes = bounded.bytes;
      next.outputTruncated ||= bounded.truncated;
    }
    next.bytes = next.inputBytes + next.outputBytes;
    if (next.updates > this.#bounds.maxProgressUpdates) {
      next.progressTruncated = true;
      next.updates = this.#bounds.maxProgressUpdates;
    }
    next.progressTruncated ||= next.inputTruncated || next.outputTruncated;
    next.truncated = next.inputTruncated || next.outputTruncated || next.progressTruncated;
    this.#tools.set(key, next);
    while (this.#tools.size > this.#bounds.maxTools) {
      const first = this.#tools.keys().next().value;
      if (first) {
        this.#tools.delete(first);
      } else {
        break;
      }
      this.#truncated = true;
    }
    return true;
  }

  snapshot(artifactIdsForTool: (toolCallId: string) => readonly string[] = () => []) {
    return [...this.#tools.values()].map((tool) => ({
      key: `${tool.runId}:${tool.toolCallId}`,
      runId: tool.runId,
      toolCallId: tool.toolCallId,
      name: tool.name,
      status: tool.status,
      phase: tool.phase,
      input: tool.input === null ? null : cloneAndFreeze(tool.input),
      output: tool.output === null ? null : cloneAndFreeze(tool.output),
      truncated: tool.truncated,
      artifactIds: tool.toolCallId === "unknown" ? [] : artifactIdsForTool(tool.toolCallId),
      progress: { updates: tool.updates, bytes: tool.bytes, truncated: tool.progressTruncated },
    }));
  }
}

function eventSessionKey(payload: Record<string, unknown>): string | null {
  for (const value of [
    payload,
    record(payload.data),
    record(payload.presentation),
    record(payload.approval),
    record(record(payload.approval)?.presentation),
    record(payload.question),
    record(payload.message),
  ]) {
    const key = text(value?.sessionKey) ?? text(value?.key) ?? text(value?.sourceSessionKey);
    if (key) {
      return key;
    }
  }
  return null;
}
