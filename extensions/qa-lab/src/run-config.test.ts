import { beforeEach, describe, expect, it, vi } from "vitest";

const { defaultQaRuntimeModelForMode } = vi.hoisted(() => ({
  defaultQaRuntimeModelForMode: vi.fn<(mode: string, options?: { alternate?: boolean }) => string>(
    (mode, options) =>
      mode === "live-frontier"
        ? "openai/gpt-5.4"
        : options?.alternate
          ? "mock-openai/gpt-5.4-alt"
          : "mock-openai/gpt-5.4",
  ),
}));

vi.mock("./model-selection.runtime.js", () => ({
  defaultQaRuntimeModelForMode,
}));
import {
  createDefaultQaRunSelection,
  createIdleQaRunnerSnapshot,
  createQaRunOutputDir,
  normalizeQaRunSelection,
} from "./run-config.js";

const scenarios = [
  {
    id: "dm-chat-baseline",
    title: "DM baseline",
    surface: "dm",
    objective: "test DM",
    successCriteria: ["reply"],
  },
  {
    id: "thread-lifecycle",
    title: "Thread lifecycle",
    surface: "thread",
    objective: "test thread",
    successCriteria: ["thread reply"],
  },
];

describe("qa run config", () => {
  beforeEach(() => {
    defaultQaRuntimeModelForMode.mockImplementation(
      (mode: string, options?: { alternate?: boolean }) =>
        mode === "live-frontier"
          ? "openai/gpt-5.4"
          : options?.alternate
            ? "mock-openai/gpt-5.4-alt"
            : "mock-openai/gpt-5.4",
    );
  });

  it("creates a live-by-default selection that arms every scenario", () => {
    expect(createDefaultQaRunSelection(scenarios)).toEqual({
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.4",
      alternateModel: "openai/gpt-5.4",
      fastMode: true,
      scenarioIds: ["dm-chat-baseline", "thread-lifecycle"],
    });
  });

  it("normalizes live selections and filters unknown scenario ids", () => {
    expect(
      normalizeQaRunSelection(
        {
          providerMode: "live-openai",
          primaryModel: "openai/gpt-5.4",
          alternateModel: "",
          fastMode: false,
          scenarioIds: ["thread-lifecycle", "missing", "thread-lifecycle"],
        },
        scenarios,
      ),
    ).toEqual({
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.4",
      alternateModel: "openai/gpt-5.4",
      fastMode: true,
      scenarioIds: ["thread-lifecycle"],
    });
  });

  it("falls back to all scenarios when selection would otherwise be empty", () => {
    const snapshot = createIdleQaRunnerSnapshot(scenarios);
    expect(snapshot.status).toBe("idle");
    expect(snapshot.selection.scenarioIds).toEqual(["dm-chat-baseline", "thread-lifecycle"]);
    expect(
      normalizeQaRunSelection(
        {
          scenarioIds: [],
        },
        scenarios,
      ).scenarioIds,
    ).toEqual(["dm-chat-baseline", "thread-lifecycle"]);
  });

  it("anchors generated run output dirs under the provided repo root", () => {
    const outputDir = createQaRunOutputDir("/tmp/openclaw-repo");
    expect(outputDir.startsWith("/tmp/openclaw-repo/.artifacts/qa-e2e/lab-")).toBe(true);
  });

  it("prefers the Codex OAuth default when the runtime resolver says it is available", () => {
    defaultQaRuntimeModelForMode.mockImplementation((mode, options) =>
      mode === "live-frontier"
        ? "openai-codex/gpt-5.4"
        : options?.alternate
          ? "mock-openai/gpt-5.4-alt"
          : "mock-openai/gpt-5.4",
    );

    expect(createDefaultQaRunSelection(scenarios)).toEqual({
      providerMode: "live-frontier",
      primaryModel: "openai-codex/gpt-5.4",
      alternateModel: "openai-codex/gpt-5.4",
      fastMode: true,
      scenarioIds: ["dm-chat-baseline", "thread-lifecycle"],
    });
  });
});
