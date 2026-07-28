import { afterEach, describe, expect, it, vi } from "vitest";
import { getPluginToolMeta, setPluginToolMeta } from "../../../plugins/tools.js";
import { getChannelAgentToolMeta, setChannelAgentToolMeta } from "../../channel-tool-metadata.js";
import { isCodeModeControlTool, markCodeModeControlTool } from "../../code-mode-control-tools.js";
import {
  getToolTerminalPresentation,
  setToolTerminalPresentation,
} from "../../tool-terminal-presentation.js";
import {
  clearToolActivityRun,
  getLastToolActivityMs,
  notifyToolActivity,
  onToolActivity,
  wrapEmbeddedAttemptToolWithActivity,
} from "./tool-activity-heartbeat.js";

const RUN = "test-run";

describe("tool-activity-heartbeat", () => {
  afterEach(() => {
    clearToolActivityRun(RUN);
    clearToolActivityRun("run-a");
    clearToolActivityRun("run-b");
    clearToolActivityRun("empty-run");
  });

  it("fires registered listener when notifyToolActivity is called", () => {
    const listener = vi.fn();

    const unsubscribe = onToolActivity(RUN, listener);
    notifyToolActivity(RUN);

    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it("does not fire listener after unsubscribe", () => {
    const listener = vi.fn();

    const unsubscribe = onToolActivity(RUN, listener);
    unsubscribe();
    notifyToolActivity(RUN);

    expect(listener).not.toHaveBeenCalled();
  });

  it("supports multiple listeners", () => {
    const a = vi.fn();
    const b = vi.fn();

    const unsubA = onToolActivity(RUN, a);
    onToolActivity(RUN, b);
    notifyToolActivity(RUN);

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    unsubA();
  });

  it("broadcasts to all listeners on the same run", () => {
    const a = vi.fn();
    const b = vi.fn();

    onToolActivity(RUN, a);
    onToolActivity(RUN, b);
    notifyToolActivity(RUN);

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("does not bother listeners for notifyToolActivity without registered listeners", () => {
    expect(() => notifyToolActivity("empty-run")).not.toThrow();
  });

  it("scopes listeners per run - does not cross-fire", () => {
    const runAListener = vi.fn();
    const runBListener = vi.fn();

    onToolActivity("run-a", runAListener);
    onToolActivity("run-b", runBListener);
    notifyToolActivity("run-a");

    expect(runAListener).toHaveBeenCalledTimes(1);
    expect(runBListener).not.toHaveBeenCalled();
  });

  it("clearToolActivityRun removes listeners and last-activity timestamp", () => {
    const listener = vi.fn();
    onToolActivity(RUN, listener);
    notifyToolActivity(RUN);
    expect(getLastToolActivityMs(RUN)).toBeGreaterThan(0);

    clearToolActivityRun(RUN);
    expect(getLastToolActivityMs(RUN)).toBe(0);

    notifyToolActivity(RUN);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("heartbeat wrapper metadata preservation", () => {
  // The attempt tool-catalog phase replaces tool objects to add heartbeats.
  // These tests exercise the production wrapper so identity-keyed metadata
  // cannot silently disappear across that boundary.

  it("preserves channel tool metadata on heartbeat-wrapped tools", () => {
    const source = { name: "test-tool", execute: vi.fn() as never };
    setChannelAgentToolMeta(source as never, { channelId: "telegram" });

    const wrapped = wrapEmbeddedAttemptToolWithActivity(source as never, RUN) as typeof source;

    expect(getChannelAgentToolMeta(wrapped as never)).toEqual({ channelId: "telegram" });
  });

  it("preserves plugin tool metadata on heartbeat-wrapped tools", () => {
    const source = { name: "test-tool", execute: vi.fn() as never };
    setPluginToolMeta(source as never, { pluginId: "test-plugin", optional: false });

    const wrapped = wrapEmbeddedAttemptToolWithActivity(source as never, RUN) as typeof source;

    const meta = getPluginToolMeta(wrapped as never);
    expect(meta?.pluginId).toBe("test-plugin");
  });

  it("preserves before-tool-call marker on heartbeat-wrapped tools", () => {
    const source: Record<string, unknown> = { name: "test-tool", execute: vi.fn() as never };
    // Simulate a tool that has gone through the before-tool-call hook
    Object.defineProperty(source, Symbol.for("openclaw:beforeToolCallWrapped"), {
      value: true,
      enumerable: true,
    });
    Object.defineProperty(source, Symbol.for("openclaw:beforeToolCallSourceTool"), {
      value: { name: "inner-tool" },
      enumerable: false,
    });

    const wrapped = wrapEmbeddedAttemptToolWithActivity(source as never, RUN) as typeof source;

    expect((wrapped as Record<symbol, unknown>)[Symbol.for("openclaw:beforeToolCallWrapped")]).toBe(
      true,
    );
  });

  it("preserves terminal presentation metadata on heartbeat-wrapped tools", () => {
    const source = { name: "test-tool", execute: vi.fn() as never };
    const formatter = () => ({ text: "web_fetch: 3 pages" });
    setToolTerminalPresentation(source as never, formatter);

    const wrapped = wrapEmbeddedAttemptToolWithActivity(source as never, RUN) as typeof source;

    const copiedFormatter = getToolTerminalPresentation(wrapped as never);
    expect(copiedFormatter).toBe(formatter);
    expect(copiedFormatter?.(undefined, { content: [] } as never)?.text).toBe("web_fetch: 3 pages");
  });

  it("preserves code-mode control identity on heartbeat-wrapped tools", () => {
    const source = markCodeModeControlTool({
      name: "exec",
      execute: vi.fn() as never,
    } as never);

    const wrapped = wrapEmbeddedAttemptToolWithActivity(source, RUN);

    expect(isCodeModeControlTool(wrapped)).toBe(true);
  });
});
