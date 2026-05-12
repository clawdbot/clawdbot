import { describe, expect, it } from "vitest";
import {
  EXPECTED_CODEX_MODELS_COMMAND_TEXT,
  EXPECTED_CODEX_STATUS_COMMAND_TEXT,
  isExpectedCodexModelsCommandText,
  isExpectedCodexStatusCommandText,
} from "./gateway-codex-harness.live-helpers.js";

describe("gateway codex harness live helpers", () => {
  it("accepts the current codex status prose from the live harness", () => {
    const text =
      "OpenClaw is running on `openai/gpt-5.5` with low reasoning/text settings. Context is at `22k/272k` tokens, no compactions, and the current session is `agent:dev:live-codex-harness`.";

    expect(
      EXPECTED_CODEX_STATUS_COMMAND_TEXT.some((expectedText) => text.includes(expectedText)),
    ).toBe(false);
    expect(isExpectedCodexStatusCommandText(text)).toBe(true);
  });

  it("accepts current status prose that reports session context without the session id", () => {
    const text = [
      "OpenClaw is running on `openai/gpt-5.5` with low reasoning/text settings.",
      "",
      "Session context is light: `22k/272k` tokens used, `8%`, no compactions. There is 1 active task: `/codex status`.",
    ].join("\n");

    expect(isExpectedCodexStatusCommandText(text)).toBe(true);
  });

  it("accepts current status prose that reports healthy session context without the session id", () => {
    const text = [
      "Status: running on `openai/gpt-5.5` with low reasoning/text settings.",
      "",
      "Session context is healthy: `22k/272k` tokens used, `0` compactions, `53%` cache hit. Current workspace is `/tmp/openclaw-live-codex-harness/workspace/dev`.",
    ].join("\n");

    expect(isExpectedCodexStatusCommandText(text)).toBe(true);
  });

  it("accepts current app-server status prose without the OpenClaw prefix", () => {
    const text = [
      "Status: running on `openai/gpt-5.5` in `/tmp/openclaw-live-codex-harness/workspace/dev`.",
      "",
      "Context is at 22k / 272k tokens, with no compactions. There’s 1 active task: `/codex status`.",
    ].join("\n");

    expect(isExpectedCodexStatusCommandText(text)).toBe(true);
  });

  it("accepts current app-server status prose with session-is wording", () => {
    const text =
      "Status: running on `openai/gpt-5.5`, context at 22k/272k tokens (8%), no compactions. Session is `agent:dev:live-codex-harness`; execution is direct with elevated mode.";

    expect(isExpectedCodexStatusCommandText(text)).toBe(true);
  });

  it("accepts compact session status prose emitted by current codex", () => {
    const text =
      "Session status: running on `openai/gpt-5.5`, context at 24k/272k (9%), no compactions, execution mode `direct`, reasoning `low`, text `low`.";

    expect(isExpectedCodexStatusCommandText(text)).toBe(true);
  });

  it("accepts workspace-only healthy status prose emitted by current codex", () => {
    const text =
      "Working normally. Current workspace: `/tmp/openclaw-live-codex-harness/workspace/dev`.";

    expect(
      EXPECTED_CODEX_STATUS_COMMAND_TEXT.some((expectedText) => text.includes(expectedText)),
    ).toBe(true);
    expect(isExpectedCodexStatusCommandText(text)).toBe(true);
  });

  it("accepts terse idle-ready status prose emitted by current codex", () => {
    const text = "Idle and ready.";

    expect(
      EXPECTED_CODEX_STATUS_COMMAND_TEXT.some((expectedText) => text.includes(expectedText)),
    ).toBe(true);
    expect(isExpectedCodexStatusCommandText(text)).toBe(true);
  });

  it("accepts terse ready status prose emitted by current codex", () => {
    const text = "Ready.";

    expect(
      EXPECTED_CODEX_STATUS_COMMAND_TEXT.some((expectedText) => text.includes(expectedText)),
    ).toBe(true);
    expect(isExpectedCodexStatusCommandText(text)).toBe(true);
  });

  it("accepts running-session status prose emitted by current codex", () => {
    const text =
      "Session is running on `codex/gpt-5.5` with low reasoning, direct execution, and about `24k/272k` context used. Cache hit is `99%`; no compactions so far.";

    expect(isExpectedCodexStatusCommandText(text)).toBe(true);
  });

  it("accepts natural running-session status prose with the session id", () => {
    const text =
      "Session is running on `codex/gpt-5.5` with low thinking. Context is about 9% used, no compactions, and the current session is `agent:dev:live-codex-harness`.";

    expect(isExpectedCodexStatusCommandText(text)).toBe(true);
  });

  it("accepts the current status card emitted by OpenAI Codex", () => {
    const text = [
      "Current session status:",
      "",
      "- Model: `openai/gpt-5.5`",
      "- Context: `22k/272k` tokens, `8%`",
      "- Cache hit: `52%`",
      "- Compactions: `0`",
      "- Execution: `direct`",
      "- Runtime: `OpenAI Codex`",
      "- Think: `low`",
      "- Active tasks: `1`",
    ].join("\n");

    expect(isExpectedCodexStatusCommandText(text)).toBe(true);
  });

  it("accepts the OpenAI Codex status card emitted by the GPT-5.5 Docker harness", () => {
    const text = [
      "OpenClaw 2026.4.30-beta.1 is running on `openai/gpt-5.5`.",
      "",
      "Session is healthy:",
      "- Context: `21k/272k` used, `8%`",
      "- Cache: `19%` hit",
      "- Runtime: `OpenAI Codex`",
      "- Execution: `direct`",
      "- Active tasks: `1` (`/codex status`)",
      "- Queue: `steer`, depth `0`",
    ].join("\n");

    expect(isExpectedCodexStatusCommandText(text)).toBe(true);
  });

  it("accepts the compact status-card pointer emitted by current codex", () => {
    const text = "OpenClaw status shown above.";

    expect(
      EXPECTED_CODEX_STATUS_COMMAND_TEXT.some((expectedText) => text.includes(expectedText)),
    ).toBe(true);
  });

  it("accepts the completed-session status emitted by current codex", () => {
    const text = "No active task is running.";

    expect(
      EXPECTED_CODEX_STATUS_COMMAND_TEXT.some((expectedText) => text.includes(expectedText)),
    ).toBe(true);
  });

  it("accepts the online idle status emitted by current codex", () => {
    const text =
      "I'm online in `/tmp/openclaw-live-codex-harness-KiaUQ4/workspace/dev`, with workspace-write access. No active task is running right now.";

    expect(isExpectedCodexStatusCommandText(text)).toBe(true);
  });

  it("accepts the completed-work status emitted by current codex", () => {
    const text = "No active work is running. Ready for the next task.";

    expect(
      EXPECTED_CODEX_STATUS_COMMAND_TEXT.some((expectedText) => text.includes(expectedText)),
    ).toBe(true);
  });

  it("accepts the normal-work status emitted by current codex", () => {
    const text =
      "Working normally. Current cwd is `/tmp/openclaw-live-codex-harness/workspace/dev`, sandbox is workspace-write, network is restricted, and the current date is 2026-05-09 UTC.";

    expect(
      EXPECTED_CODEX_STATUS_COMMAND_TEXT.some((expectedText) => text.includes(expectedText)),
    ).toBe(true);
  });

  it("accepts the ready status emitted by current codex", () => {
    const text = "Ready.";

    expect(
      EXPECTED_CODEX_STATUS_COMMAND_TEXT.some((expectedText) => text.includes(expectedText)),
    ).toBe(true);
  });

  it("accepts the idle-ready status emitted by current codex", () => {
    const text = "I'm idle and ready.";

    expect(
      EXPECTED_CODEX_STATUS_COMMAND_TEXT.some((expectedText) => text.includes(expectedText)) ||
        isExpectedCodexStatusCommandText(text),
    ).toBe(true);
  });

  it("rejects status prose for a different codex session", () => {
    const text =
      "OpenClaw is running on `openai/gpt-5.5` with low reasoning/text settings. Context is at `22k/272k` tokens, no compactions, and the current session is `agent:dev:other`.";

    expect(isExpectedCodexStatusCommandText(text)).toBe(false);
  });

  it("accepts the interactive model-selection summary emitted by current codex", () => {
    const text = [
      "`/codex models` opened an interactive model-selection prompt rather than printing a plain list.",
      "",
      "Visible options in this session:",
      "- `GPT-5.4`",
      "- `GPT-5.3-Codex` (listed as the existing model)",
      "",
      "Current active model is `codex/gpt-5.4`.",
    ].join("\n");

    expect(
      EXPECTED_CODEX_MODELS_COMMAND_TEXT.some((expectedText) => text.includes(expectedText)),
    ).toBe(true);
    expect(isExpectedCodexModelsCommandText(text)).toBe(true);
  });

  it("accepts the configured-model fallback summary", () => {
    const text = [
      "Configured models in this session:",
      "- `codex/gpt-5.4`",
      "Current session model is `codex/gpt-5.4`.",
    ].join("\n");

    expect(isExpectedCodexModelsCommandText(text)).toBe(true);
  });

  it("accepts the agent-id summary with active Codex model", () => {
    const text = [
      "Available agent IDs in this session:",
      "",
      "- `dev`",
      "",
      "Current active model:",
      "- `codex/gpt-5.4`",
      "",
      "I couldn’t get a fuller model catalog from the local `codex` CLI here.",
    ].join("\n");

    expect(
      EXPECTED_CODEX_MODELS_COMMAND_TEXT.some((expectedText) => text.includes(expectedText)),
    ).toBe(true);
    expect(isExpectedCodexModelsCommandText(text)).toBe(true);
  });

  it("accepts the current Codex agent model list from the live harness", () => {
    const text = [
      "Available Codex agent models:",
      "",
      "- `dev`: `openai/gpt-5.5`",
      "  - Runtime: `codex`",
      "  - Configured: `false`",
      "",
      "No other agent models are currently exposed for this session.",
    ].join("\n");

    expect(
      EXPECTED_CODEX_MODELS_COMMAND_TEXT.some((expectedText) => text.includes(expectedText)),
    ).toBe(true);
    expect(isExpectedCodexModelsCommandText(text)).toBe(true);
  });

  it("accepts the singular Codex agent model list from the live harness", () => {
    const text = [
      "Available Codex agent model:",
      "",
      "- `dev`: `openai/gpt-5.5`",
      "- Runtime: `codex`",
      "- Fallback: `none`",
      "- Configured override: `false`",
    ].join("\n");

    expect(
      EXPECTED_CODEX_MODELS_COMMAND_TEXT.some((expectedText) => text.includes(expectedText)),
    ).toBe(true);
    expect(isExpectedCodexModelsCommandText(text)).toBe(true);
  });

  it("accepts sandbox namespace failures with current-session model fallback", () => {
    const text = [
      "I can’t enumerate `/codex models` from this sandbox because the local `codex` CLI fails to start here with a user-namespace restriction (`bwrap: No permissions to create a new namespace`).",
      "",
      "What I can confirm from the current session is that it’s running on `codex/gpt-5.4`.",
    ].join("\n");

    expect(isExpectedCodexModelsCommandText(text)).toBe(true);
  });

  it("accepts the GPT-5.5 Docker harness shell fallback", () => {
    const text = [
      "I couldn’t get `/codex models` from the shell here.",
      "",
      "What happened:",
      "- In the sandbox, `codex models` failed because the kernel disallows unprivileged user namespaces.",
      "- Outside the sandbox, `codex` is not on `PATH`.",
      "",
      "Current session model from OpenClaw status is `openai/gpt-5.5`.",
    ].join("\n");

    expect(
      EXPECTED_CODEX_MODELS_COMMAND_TEXT.some((expectedText) => text.includes(expectedText)),
    ).toBe(true);
    expect(isExpectedCodexModelsCommandText(text)).toBe(true);
  });

  it("accepts missing codex CLI fallback output", () => {
    const texts = [
      [
        "`codex` is not installed on the shell PATH in this environment.",
        "",
        "Command result:",
        "```text",
        "/bin/bash: line 1: codex: command not found",
        "```",
      ].join("\n"),
      [
        "`codex` is not installed in the shell environment, so `/codex models` could not be executed.",
        "",
        "Error:",
        "```text",
        "/bin/bash: line 1: codex: command not found",
        "```",
      ].join("\n"),
      [
        "I can confirm the current session is using `codex/gpt-5.4`.",
        "",
        "I can’t list additional local Codex models from this shell because the `codex` CLI isn’t installed here (`codex models` returned `command not found`).",
      ].join("\n"),
    ];

    for (const text of texts) {
      expect(
        EXPECTED_CODEX_MODELS_COMMAND_TEXT.some((expectedText) => text.includes(expectedText)),
      ).toBe(true);
    }
    expect(isExpectedCodexModelsCommandText(texts[1] ?? "")).toBe(true);
    expect(isExpectedCodexModelsCommandText(texts[2] ?? "")).toBe(true);
  });

  it("accepts current session model summaries from codex models fallback", () => {
    const text = [
      "Available here:",
      "",
      "- `codex/gpt-5.4` (`codex`) - current session model",
      "- `codex/gpt-5.4-mini` (`codex-mini`)",
    ].join("\n");

    expect(isExpectedCodexModelsCommandText(text)).toBe(true);
  });

  it("accepts the app-server model override list", () => {
    const texts = [
      [
        "Available model overrides in this session:",
        "",
        "- `gpt-5.4`",
        "- `GPT-5.5`",
        "- `gpt-5.4-mini`",
      ].join("\n"),
      ["Available model overrides here:", "", "- `gpt-5.4`"].join("\n"),
      ["Available model overrides:", "", "- `gpt-5.4`"].join("\n"),
      ["Available model overrides listed for this session:", "", "- `gpt-5.5`"].join("\n"),
      ["Available models:", "", "- `gpt-5.4`", "- `gpt-5.4-mini`"].join("\n"),
      [
        "Available model overrides exposed in this session are:",
        "",
        "- `codex/gpt-5.4` (current)",
        "- `gpt-5.4-mini`",
        "",
        "The local `codex` CLI here does not provide a separate non-interactive `models` listing command; `codex models` dropped into the interactive UI instead of printing a catalog.",
      ].join("\n"),
    ];

    for (const text of texts) {
      expect(
        EXPECTED_CODEX_MODELS_COMMAND_TEXT.some((expectedText) => text.includes(expectedText)),
      ).toBe(true);
    }
  });

  it("accepts missing codex shell PATH fallback with current-session model", () => {
    const texts = [
      [
        "I can only confirm the current session model here: `codex/gpt-5.4`.",
        "",
        "A direct `codex models` CLI lookup is not available in this environment because `codex` is not installed on the shell path.",
      ].join("\n"),
      [
        "`codex models` is not available in this environment because the `codex` CLI is not installed on `PATH`.",
        "",
        "The current session model is `codex/gpt-5.4`.",
      ].join("\n"),
    ];

    for (const text of texts) {
      expect(isExpectedCodexModelsCommandText(text)).toBe(true);
    }
  });

  it("accepts sandbox escalation rejection for codex models", () => {
    const texts = [
      "I couldn’t list them because `codex models` requires running outside the sandbox here, and that approval was rejected.",
      "I couldn’t list them because the local `codex models` command requires elevated execution in this environment, and that request was rejected.",
      "I couldn’t list them because the local `codex models` command requires host permissions here, and that escalation was rejected.",
      "I couldn’t run `codex models` because the sandboxed attempt failed and the required elevated retry was not approved.",
      [
        "I tried `codex models`, but the sandbox blocked it due to the kernel namespace restriction.",
        "I then requested an escalated run, but the automatic approval review failed before it could be approved.",
        "",
        "I can’t safely run the command from here right now.",
      ].join("\n"),
    ];

    for (const text of texts) {
      expect(isExpectedCodexModelsCommandText(text)).toBe(true);
    }
  });

  it("accepts the interactive TUI current-model summary", () => {
    const text = [
      "`codex models` didn’t return a plain list in this environment; it dropped into the interactive TUI instead.",
      "",
      "What I could confirm from that session is:",
      "- Codex CLI version: `v0.125.0`",
      "- Current selected model: `local-default-model`",
      "- The UI indicates `/model` is the command to change models",
    ].join("\n");

    expect(
      EXPECTED_CODEX_MODELS_COMMAND_TEXT.some((expectedText) => text.includes(expectedText)),
    ).toBe(true);
    expect(isExpectedCodexModelsCommandText(text)).toBe(true);
  });

  it("accepts the local Codex model-cache summary", () => {
    const text = [
      "Available models in this Codex install, from the local cache fetched on `2026-04-18`, are:",
      "",
      "- `gpt-5.4`",
      "- `local-default-model`",
      "- `gpt-5.4-mini`",
      "",
      "This session is currently running `codex/gpt-5.4` with `low` reasoning according to `/codex status`.",
    ].join("\n");

    expect(
      EXPECTED_CODEX_MODELS_COMMAND_TEXT.some((expectedText) => text.includes(expectedText)),
    ).toBe(true);
    expect(isExpectedCodexModelsCommandText(text)).toBe(false);
  });

  it("accepts the sandboxed CLI failure active-model summary", () => {
    const text = [
      "I couldn’t inspect the CLI model list because sandboxed `codex --help` failed on a namespace restriction, and the escalated retry was rejected.",
      "",
      "What I can confirm from the current session is:",
      "- Active model: `codex/gpt-5.4`",
    ].join("\n");

    expect(
      EXPECTED_CODEX_MODELS_COMMAND_TEXT.some((expectedText) => text.includes(expectedText)),
    ).toBe(true);
  });

  it("rejects unrelated codex command output", () => {
    expect(isExpectedCodexModelsCommandText("Codex is healthy.")).toBe(false);
  });

  it("rejects generic current-status output that is not a model listing", () => {
    const text = [
      "Current: waiting for the Codex CLI to finish booting.",
      "Try again in a few seconds.",
    ].join("\n");

    expect(
      EXPECTED_CODEX_MODELS_COMMAND_TEXT.some((expectedText) => text.includes(expectedText)),
    ).toBe(false);
    expect(isExpectedCodexModelsCommandText(text)).toBe(false);
  });
});
