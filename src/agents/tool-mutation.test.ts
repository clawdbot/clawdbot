// Tool mutation tests cover fail-closed mutation and replay-safety classification.
import { describe, expect, it } from "vitest";
import {
  buildToolMutationState,
  isMutatingToolCall,
  isReplaySafeToolCall,
} from "./tool-mutation.js";

describe("tool mutation helpers", () => {
  it("treats session_status as mutating only when model override is provided", () => {
    expect(isMutatingToolCall("session_status", { sessionKey: "agent:main:main" })).toBe(false);
    expect(
      isMutatingToolCall("session_status", {
        sessionKey: "agent:main:main",
        model: "openai/gpt-4o",
      }),
    ).toBe(true);
  });

  it("classifies portal list as replay-safe and portal mutations as mutating", () => {
    expect(isMutatingToolCall("portal", { action: "list" })).toBe(false);
    expect(isReplaySafeToolCall("portal", { action: "list" })).toBe(true);
    for (const action of ["open", "close"]) {
      expect(isMutatingToolCall("portal", { action }), action).toBe(true);
      expect(isReplaySafeToolCall("portal", { action }), action).toBe(false);
    }
  });

  it("treats owner-declared side effects as mutating and replay-unsafe", () => {
    expect(
      buildToolMutationState(
        "memory_store",
        { text: "preference" },
        {
          ownerKey: '["memory-lancedb","memory_store"]',
        },
      ),
    ).toEqual({ mutatingAction: true, replaySafe: false });
  });

  it.each([
    ["exec", "sed -n '1,220p' src/agents/tool-mutation.ts"],
    ["bash", "cat package.json"],
    ["exec", "rg -n tool-mutation src/agents"],
    ["exec", "gh search prs --repo openclaw/openclaw tool-mutation --json number,title,state"],
    ["bash", "gh pr view 123 --repo openclaw/openclaw --json title,state"],
  ])("treats read-only shell command as non-mutating: %s %s", (toolName, command) => {
    expect(isMutatingToolCall(toolName, { command })).toBe(false);
    expect(buildToolMutationState(toolName, { command }).mutatingAction).toBe(false);
  });

  it.each([
    ["exec", "sed -i 's/a/b/' file.txt"],
    ["exec", "sed --in-place 's/a/b/' file.txt"],
    ["exec", "sed -n '1p' -i file.txt"],
    ["exec", "sed -n -e '1p' -e 'w /tmp/out' file.txt"],
    ["bash", "cat package.json > /tmp/package.json"],
    ["bash", "rg foo src | wc -l"],
    ["bash", "rg --pre touch pattern file"],
    ["bash", "rg --pre=touch pattern file"],
    ["bash", "rg --hostname-bin /tmp/helper pattern file"],
    ["bash", "rg --hostname-bin=/tmp/helper pattern file"],
    ["bash", "rg --search-zip pattern archive.zip"],
    ["bash", "rg -z pattern archive.zip"],
    ["bash", "rg pattern {--pre=sh,script.sh}"],
    ["exec", "file --compile -m custom.magic"],
    ["exec", "python3 <<'PY'\nprint('hello')\nPY"],
    ["exec", "npm start"],
    ["exec", "zsh -lc 'rg TODO src'"],
    ["exec", "./zsh -lc 'rg TODO src'"],
    ["exec", "/tmp/zsh -lc 'rg TODO src'"],
    ["exec", "/bin/zsh -lc 'rg TODO src'"],
    ["bash", "git status --short"],
    ["exec", "git diff -- src/agents/tool-mutation.ts"],
    ["exec", "git checkout feature-branch"],
    ["exec", "git branch -D old-branch"],
    ["exec", "git diff --output=/tmp/patch.diff"],
    ["exec", "git diff --ext-diff"],
    ["exec", "git show --textconv HEAD:file.txt"],
    ["exec", "git log --exec=/tmp/helper"],
    ["exec", "git grep -O pattern"],
    ["exec", "git grep -Ovim pattern"],
    ["exec", "git grep --ext-grep pattern"],
    ["exec", "git grep --open-files-in-pager=vim pattern"],
    ["exec", "gh pr create --title fix --body body"],
    ["exec", "gh pr view 123 --web"],
    ["exec", "gh pr view 123 --web=true"],
    ["exec", "gh pr view 123 --web=false"],
    ["exec", "gh pr view 123 -w"],
    ["exec", "gh pr view 123 -w=true"],
    ["exec", "gh pr view 123 -w=false"],
    ["exec", "gh issue comment 123 --body fixed"],
    ["exec", "gh search prs bug --web"],
    ["exec", "gh search prs bug --web=true"],
    ["exec", "gh search prs bug -w"],
    ["exec", "gh search prs bug -w=true"],
    ["exec", "gh api --method POST repos/openclaw/openclaw/issues"],
  ])("keeps ambiguous or mutating shell command mutating: %s %s", (toolName, command) => {
    expect(isMutatingToolCall(toolName, { command })).toBe(true);
    expect(buildToolMutationState(toolName, { command }).mutatingAction).toBe(true);
  });

  it("exposes mutation state for downstream payload rendering", () => {
    expect(
      buildToolMutationState("message", { action: "send", to: "forum:1" }).mutatingAction,
    ).toBe(true);
    expect(buildToolMutationState("browser", { action: "list" }).mutatingAction).toBe(false);
    for (const action of ["cancel", "kill", "steer"]) {
      expect(
        buildToolMutationState("subagents", { action, target: "worker-1" }).mutatingAction,
      ).toBe(true);
    }
    expect(buildToolMutationState("subagents", { action: "list" }).mutatingAction).toBe(false);
    expect(buildToolMutationState("sessions", { action: "group_list" }).mutatingAction).toBe(false);
    expect(buildToolMutationState("sessions", { action: "patch" }).mutatingAction).toBe(true);
    expect(
      buildToolMutationState("sessions_spawn", { task: "inspect the failure" }).mutatingAction,
    ).toBe(true);
    expect(buildToolMutationState("process", { action: "clear" }).mutatingAction).toBe(true);
    expect(buildToolMutationState("process", { action: "remove" }).mutatingAction).toBe(true);
    expect(
      buildToolMutationState("message", { action: "sendAttachment", path: "/tmp/report.pdf" })
        .mutatingAction,
    ).toBe(true);
    expect(
      buildToolMutationState("message", { action: "upload-file", path: "/tmp/report.pdf" })
        .mutatingAction,
    ).toBe(true);
    for (const action of ["poll", "topic-create", "role-add", "ban", "future-action"]) {
      expect(buildToolMutationState("message", { action }).mutatingAction, action).toBe(true);
    }
    for (const action of [
      "read",
      "reactions",
      "list-pins",
      "thread-list",
      "member-info",
      "channel-list",
      "voice-status",
      "event-list",
    ]) {
      expect(buildToolMutationState("message", { action }).mutatingAction, action).toBe(false);
    }
    expect(buildToolMutationState("message", {}).mutatingAction).toBe(true);
    expect(buildToolMutationState("cron", { action: "runs" }).mutatingAction).toBe(false);
    for (const action of ["config.get", "config.schema.lookup"]) {
      expect(buildToolMutationState("gateway", { action }).mutatingAction, action).toBe(false);
    }
    for (const action of ["status", "describe", "pending"]) {
      expect(buildToolMutationState("nodes", { action }).mutatingAction, action).toBe(false);
    }
    expect(buildToolMutationState("gateway", { action: "config.patch" }).mutatingAction).toBe(true);
    expect(buildToolMutationState("nodes", { action: "approve" }).mutatingAction).toBe(true);
    expect(buildToolMutationState("get_goal", { sessionKey: "agent:main" }).mutatingAction).toBe(
      false,
    );
    expect(buildToolMutationState("create_goal", { sessionKey: "agent:main" }).mutatingAction).toBe(
      true,
    );
    expect(
      buildToolMutationState("update_goal", { sessionKey: "agent:main", status: "complete" })
        .mutatingAction,
    ).toBe(true);
  });

  it("classifies computer observations as replay-safe and input as mutating", () => {
    for (const action of ["screenshot", "wait"]) {
      const state = buildToolMutationState("computer", { action });
      expect(state.mutatingAction, action).toBe(false);
      expect(state.replaySafe, action).toBe(true);
    }
    for (const action of [
      "left_click",
      "right_click",
      "middle_click",
      "double_click",
      "triple_click",
      "mouse_move",
      "left_click_drag",
      "left_mouse_down",
      "left_mouse_up",
      "scroll",
      "type",
      "key",
      "hold_key",
    ]) {
      const state = buildToolMutationState("computer", { action });
      expect(state.mutatingAction, action).toBe(true);
      expect(state.replaySafe, action).toBe(false);
    }
    expect(isMutatingToolCall("computer", {})).toBe(true);
    expect(isReplaySafeToolCall("computer", {})).toBe(false);
  });

  it("classifies mobile UI observation as replay-safe and act as mutating", () => {
    expect(isReplaySafeToolCall("mobile_ui", { action: "observe" })).toBe(true);
    expect(isMutatingToolCall("mobile_ui", { action: "observe" })).toBe(false);
    expect(isReplaySafeToolCall("mobile_ui", { action: "act" })).toBe(false);
    expect(isMutatingToolCall("mobile_ui", { action: "act" })).toBe(true);
  });

  it("fails closed for replay unless the structured tool contract is read-only", () => {
    for (const toolName of [
      "agents_list",
      "view_image",
      "pdf",
      "read",
      "conversations_list",
      "sessions_history",
      "sessions_list",
      "sessions_search",
      "tool_describe",
      "tool_search",
    ]) {
      expect(isReplaySafeToolCall(toolName, {}), toolName).toBe(true);
    }
    expect(
      isReplaySafeToolCall("progress_card", {
        plan: [{ step: "Inspect", status: "in_progress" }],
      }),
    ).toBe(false);
    expect(isReplaySafeToolCall("memory_get", { path: "memory/notes.md" })).toBe(true);
    expect(isReplaySafeToolCall("memory_search", { query: "recall" })).toBe(false);
    expect(isReplaySafeToolCall("memory_recall", { query: "recall" })).toBe(false);
    expect(isReplaySafeToolCall("automations", { action: "status" })).toBe(true);
    // Legacy transcript entries predate the rename and must stay classified.
    expect(isReplaySafeToolCall("cron", { action: "status" })).toBe(true);
    expect(isReplaySafeToolCall("cron", { action: "add" })).toBe(false);
    expect(isReplaySafeToolCall("gateway", { action: "config.get" })).toBe(true);
    expect(isReplaySafeToolCall("gateway", { action: "config.schema.lookup" })).toBe(true);
    expect(isReplaySafeToolCall("gateway", { action: "config.patch" })).toBe(false);
    expect(isReplaySafeToolCall("nodes", { action: "status" })).toBe(true);
    expect(isReplaySafeToolCall("nodes", { action: "describe" })).toBe(true);
    expect(isReplaySafeToolCall("nodes", { action: "pending" })).toBe(true);
    expect(isReplaySafeToolCall("nodes", { action: "approve" })).toBe(false);
    expect(isReplaySafeToolCall("exec", { command: "rg TODO src" })).toBe(false);
    expect(isReplaySafeToolCall("process", { action: "list" })).toBe(true);
    expect(isReplaySafeToolCall("process", { action: "log", sessionId: "run-1" })).toBe(true);
    expect(isReplaySafeToolCall("process", { action: "poll", sessionId: "run-1" })).toBe(false);
    expect(isReplaySafeToolCall("browser", { action: "tabs" })).toBe(true);
    expect(isReplaySafeToolCall("browser", { action: "act", kind: "click" })).toBe(false);
    expect(isReplaySafeToolCall("browser", { action: "open", url: "https://example.com" })).toBe(
      false,
    );
    expect(isReplaySafeToolCall("skill_workshop", { action: "list" })).toBe(true);
    expect(isReplaySafeToolCall("skill_workshop", { action: "inspect" })).toBe(true);
    expect(isReplaySafeToolCall("skill_workshop", { action: "read" })).toBe(true);
    expect(isReplaySafeToolCall("skill_workshop", { action: "create" })).toBe(false);
    expect(isReplaySafeToolCall("transcripts", { action: "status" })).toBe(true);
    expect(isReplaySafeToolCall("transcripts", { action: "import" })).toBe(false);
    expect(isReplaySafeToolCall("subagents", {})).toBe(true);
    expect(isReplaySafeToolCall("subagents", { action: "list" })).toBe(true);
    expect(isReplaySafeToolCall("subagents", { action: "kill" })).toBe(false);
    expect(isReplaySafeToolCall("tool_call", { id: "sessions_list" })).toBe(false);
    expect(isReplaySafeToolCall("tool_search_code", { code: "return 1" })).toBe(false);
    expect(isReplaySafeToolCall("unknown_plugin_tool", { action: "list" })).toBe(false);
    expect(isReplaySafeToolCall("survey_actions", { action: "list" })).toBe(false);
    expect(isReplaySafeToolCall("survey_actions", { action: "poll" })).toBe(false);
  });
});
