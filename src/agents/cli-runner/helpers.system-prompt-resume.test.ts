/**
 * helpers.system-prompt-resume.test.ts
 *
 * Unit-level regression tests for issue #80374 — three of the four code paths
 * fixed in `fix(anthropic): pass system prompt on every turn for claude-cli
 * backend`. These tests assert the argv-level behavior directly, which is the
 * authoritative before/after proof; model context retention can mask this bug
 * at the live response level.
 *
 * Two scenarios are exercised for each function:
 *
 *   Legacy "first" behavior — verifies a backend explicitly configured with
 *     `systemPromptWhen: "first"` still gets the documented old behavior
 *     (system prompt dropped on resumed turns). Confirms the fix is
 *     backward-compatible for third-party backends that opt in to that mode.
 *
 *   New "always" behavior — verifies the fix: backends configured with
 *     `systemPromptWhen: "always"` (which is now the bundled claude-cli
 *     default) re-emit the system-prompt arg on every resumed turn.
 *
 * Path coverage:
 *   Path 1 (extensions/anthropic/cli-backend.ts) — covered by
 *     `extensions/anthropic/cli-shared.test.ts` and `src/agents/cli-backends.test.ts`.
 *   Path 2 (src/agents/cli-runner/execute.ts) — implicit: same gate as Path 3,
 *     and gated by `resolveSystemPromptUsage` which is tested below.
 *   Path 3 (src/agents/cli-runner/helpers.ts — buildCliArgs) — covered here.
 *   Path 4 (src/agents/cli-runner/claude-live-session.ts — stripLiveProcessArgs
 *     via buildClaudeLiveArgs) — covered here.
 */
import { describe, expect, it } from "vitest";
import type { CliBackendConfig } from "../../config/types.js";
import { buildClaudeLiveArgs } from "./claude-live-session.js";
import { buildCliArgs, resolveSystemPromptUsage } from "./helpers.js";

// Minimal backend config matching the Anthropic claude-cli backend shape.
const CLAUDE_BACKEND_BASE: Pick<
  CliBackendConfig,
  | "systemPromptFileArg"
  | "systemPromptArg"
  | "systemPromptFileConfigKey"
  | "systemPromptWhen"
  | "sessionArg"
  | "modelArg"
  | "input"
  | "output"
  | "liveSession"
> = {
  systemPromptFileArg: "--append-system-prompt-file",
  systemPromptArg: undefined,
  systemPromptFileConfigKey: undefined,
  systemPromptWhen: "always",
  sessionArg: "--session-id",
  modelArg: "--model",
  input: "stdin",
  output: "jsonl",
  liveSession: "claude-stdio",
};

// Backend configured with the legacy systemPromptWhen: "first" mode.
// Verifies the fix is backward-compatible for backends that opt in to this.
const BACKEND_FIRST: typeof CLAUDE_BACKEND_BASE = {
  ...CLAUDE_BACKEND_BASE,
  systemPromptWhen: "first",
};

// Backend configured with the new systemPromptWhen: "always" default (the
// bundled claude-cli default after the fix).
const BACKEND_ALWAYS: typeof CLAUDE_BACKEND_BASE = {
  ...CLAUDE_BACKEND_BASE,
  systemPromptWhen: "always",
};

const SYSTEM_PROMPT = "You are a test assistant. Append SYSTEM-PROOF-ACTIVE after every reply.";
const PROMPT_FILE = "/tmp/test-system-prompt.txt";

// ─── resolveSystemPromptUsage ────────────────────────────────────────────────

describe("resolveSystemPromptUsage — issue #80374", () => {
  it("legacy 'first': returns null on resumed session (prompt dropped)", () => {
    const result = resolveSystemPromptUsage({
      backend: BACKEND_FIRST as CliBackendConfig,
      isNewSession: false, // resumed
      systemPrompt: SYSTEM_PROMPT,
    });
    expect(result).toBeNull();
  });

  it("new 'always': returns the prompt on resumed session (issue #80374)", () => {
    const result = resolveSystemPromptUsage({
      backend: BACKEND_ALWAYS as CliBackendConfig,
      isNewSession: false, // resumed
      systemPrompt: SYSTEM_PROMPT,
    });
    expect(result).toBe(SYSTEM_PROMPT);
  });

  it("returns the prompt on fresh session for both 'first' and 'always'", () => {
    for (const backend of [BACKEND_FIRST, BACKEND_ALWAYS]) {
      const result = resolveSystemPromptUsage({
        backend: backend as CliBackendConfig,
        isNewSession: true, // fresh
        systemPrompt: SYSTEM_PROMPT,
      });
      expect(result, `systemPromptWhen=${backend.systemPromptWhen}`).toBe(SYSTEM_PROMPT);
    }
  });

  it("returns null when systemPromptWhen='never' regardless of session state", () => {
    for (const isNew of [true, false]) {
      const result = resolveSystemPromptUsage({
        backend: { ...BACKEND_ALWAYS, systemPromptWhen: "never" } as CliBackendConfig,
        isNewSession: isNew,
        systemPrompt: SYSTEM_PROMPT,
      });
      expect(result, `isNew=${String(isNew)}`).toBeNull();
    }
  });
});

// ─── buildCliArgs ────────────────────────────────────────────────────────────

describe("buildCliArgs — issue #80374", () => {
  const BASE_ARGS = ["-p", "--output-format", "stream-json"];

  it("legacy 'first': omits --append-system-prompt-file on resume", () => {
    const args = buildCliArgs({
      backend: BACKEND_FIRST as CliBackendConfig,
      baseArgs: BASE_ARGS,
      modelId: "claude-haiku-4-5",
      sessionId: "test-session-id",
      systemPrompt: SYSTEM_PROMPT,
      systemPromptFilePath: PROMPT_FILE,
      useResume: true,
    });
    expect(args).not.toContain("--append-system-prompt-file");
    expect(args).not.toContain(PROMPT_FILE);
  });

  it("new 'always': includes --append-system-prompt-file on resume (issue #80374)", () => {
    const args = buildCliArgs({
      backend: BACKEND_ALWAYS as CliBackendConfig,
      baseArgs: BASE_ARGS,
      modelId: "claude-haiku-4-5",
      sessionId: "test-session-id",
      systemPrompt: SYSTEM_PROMPT,
      systemPromptFilePath: PROMPT_FILE,
      useResume: true,
    });
    expect(args).toContain("--append-system-prompt-file");
    expect(args).toContain(PROMPT_FILE);
  });

  it("includes --append-system-prompt-file on fresh session for both 'first' and 'always'", () => {
    for (const backend of [BACKEND_FIRST, BACKEND_ALWAYS]) {
      const args = buildCliArgs({
        backend: backend as CliBackendConfig,
        baseArgs: BASE_ARGS,
        modelId: "claude-haiku-4-5",
        systemPrompt: SYSTEM_PROMPT,
        systemPromptFilePath: PROMPT_FILE,
        useResume: false,
      });
      expect(
        args,
        `systemPromptWhen=${backend.systemPromptWhen} should include flag on fresh session`,
      ).toContain("--append-system-prompt-file");
    }
  });
});

// ─── buildClaudeLiveArgs (Path 4: live-stdio strip guard) ───────────────────

describe("buildClaudeLiveArgs — issue #80374 (live-stdio path)", () => {
  const ARGS_WITH_SP = [
    "-p",
    "--output-format",
    "stream-json",
    "--append-system-prompt-file",
    PROMPT_FILE,
  ];

  it("legacy 'first': strips --append-system-prompt-file on resume", () => {
    const liveArgs = buildClaudeLiveArgs({
      args: ARGS_WITH_SP,
      backend: BACKEND_FIRST as CliBackendConfig,
      systemPrompt: SYSTEM_PROMPT,
      useResume: true,
    });
    expect(liveArgs).not.toContain("--append-system-prompt-file");
    expect(liveArgs).not.toContain(PROMPT_FILE);
  });

  it("new 'always': keeps --append-system-prompt-file on resume (issue #80374)", () => {
    const liveArgs = buildClaudeLiveArgs({
      args: ARGS_WITH_SP,
      backend: BACKEND_ALWAYS as CliBackendConfig,
      systemPrompt: SYSTEM_PROMPT,
      useResume: true,
    });
    expect(liveArgs).toContain("--append-system-prompt-file");
    expect(liveArgs).toContain(PROMPT_FILE);
  });

  it("keeps --append-system-prompt-file when useResume=false (both 'first' and 'always')", () => {
    for (const backend of [BACKEND_FIRST, BACKEND_ALWAYS]) {
      const liveArgs = buildClaudeLiveArgs({
        args: ARGS_WITH_SP,
        backend: backend as CliBackendConfig,
        systemPrompt: SYSTEM_PROMPT,
        useResume: false,
      });
      expect(
        liveArgs,
        `systemPromptWhen=${backend.systemPromptWhen} fresh session should keep flag`,
      ).toContain("--append-system-prompt-file");
    }
  });
});
