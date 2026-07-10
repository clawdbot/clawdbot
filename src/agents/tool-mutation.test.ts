// Tool mutation tests cover the fail-closed classification and fingerprinting
// used to decide whether repeated tool actions can recover prior failures.
import { describe, expect, it } from "vitest";
import {
  buildToolMutationState,
  isLikelyMutatingToolName,
  isMutatingToolCall,
  isReplaySafeToolCall,
  isSameToolMutationAction,
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

  it("builds stable fingerprints for mutating calls and omits read-only calls", () => {
    const writeFingerprint = buildToolMutationState(
      "write",
      { path: "/tmp/demo.txt", id: 42 },
      "write /tmp/demo.txt",
    ).actionFingerprint;
    expect(writeFingerprint).toBe("tool=write|path=/tmp/demo.txt|id=42");

    const metaOnlyFingerprint = buildToolMutationState(
      "exec",
      { command: "npm start" },
      "npm start",
    ).actionFingerprint;
    expect(metaOnlyFingerprint).toBe("tool=exec|meta=npm start");

    const readFingerprint = buildToolMutationState("read", {
      path: "/tmp/demo.txt",
    }).actionFingerprint;
    expect(readFingerprint).toBeUndefined();
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
    expect(
      buildToolMutationState(toolName, { command }, command).actionFingerprint,
    ).toBeUndefined();
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
    expect(buildToolMutationState(toolName, { command }, command).mutatingAction).toBe(true);
    expect(buildToolMutationState(toolName, { command }, command).actionFingerprint).toBe(
      `tool=${toolName}|meta=${command.toLowerCase().replace(/\s+/g, " ")}`,
    );
  });

  it("treats coding-tool path aliases as the same stable target", () => {
    const filePathFingerprint = buildToolMutationState("edit", {
      file_path: "/tmp/demo.txt",
      old_string: "before",
      new_string: "after",
    }).actionFingerprint;
    const fileAliasFingerprint = buildToolMutationState("edit", {
      file: "/tmp/demo.txt",
      oldText: "before",
      newText: "after again",
    }).actionFingerprint;

    expect(filePathFingerprint).toBe("tool=edit|path=/tmp/demo.txt");
    expect(fileAliasFingerprint).toBe("tool=edit|path=/tmp/demo.txt");
  });

  it("exposes mutation state for downstream payload rendering", () => {
    expect(
      buildToolMutationState("message", { action: "send", to: "forum:1" }).mutatingAction,
    ).toBe(true);
    expect(buildToolMutationState("browser", { action: "list" }).mutatingAction).toBe(false);
    expect(
      buildToolMutationState("subagents", { action: "kill", target: "worker-1" }).mutatingAction,
    ).toBe(true);
    expect(
      buildToolMutationState("subagents", { action: "steer", target: "worker-1" }).mutatingAction,
    ).toBe(true);
    expect(buildToolMutationState("subagents", { action: "list" }).mutatingAction).toBe(false);
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
      expect(state.actionFingerprint, action).toBeUndefined();
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
      expect(state.actionFingerprint, action).toBe(`tool=computer|action=${action}`);
    }
    expect(isMutatingToolCall("computer", {})).toBe(true);
    expect(isReplaySafeToolCall("computer", {})).toBe(false);
  });

  it("keeps computer input fingerprints stable and target-specific", () => {
    const first = buildToolMutationState(
      "computer",
      { action: "left_click", coordinate: [10, 20], node: "desk" },
      "left_click 10,20 desk",
    ).actionFingerprint;
    const repeat = buildToolMutationState(
      "computer",
      { action: "left_click", coordinate: [10, 20], node: "desk" },
      "left_click 10,20 desk",
    ).actionFingerprint;
    const otherTarget = buildToolMutationState(
      "computer",
      { action: "left_click", coordinate: [30, 40], node: "desk" },
      "left_click 30,40 desk",
    ).actionFingerprint;

    expect(first).toBe(repeat);
    expect(first).not.toBe(otherTarget);
  });

  it("fails closed for replay unless the structured tool contract is read-only", () => {
    for (const toolName of [
      "agents_list",
      "image",
      "pdf",
      "read",
      "sessions_history",
      "sessions_list",
      "tool_describe",
      "tool_search",
    ]) {
      expect(isReplaySafeToolCall(toolName, {}), toolName).toBe(true);
    }
    expect(
      isReplaySafeToolCall("update_plan", {
        plan: [{ step: "Inspect", status: "in_progress" }],
      }),
    ).toBe(true);
    expect(isReplaySafeToolCall("cron", { action: "status" })).toBe(true);
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

  it("matches tool actions by fingerprint and fails closed on asymmetric data", () => {
    // Missing fingerprint data cannot be assumed equivalent; recovery should
    // only happen when both sides expose the same stable action identity.
    expect(
      isSameToolMutationAction(
        { toolName: "write", actionFingerprint: "tool=write|path=/tmp/a" },
        { toolName: "write", actionFingerprint: "tool=write|path=/tmp/a" },
      ),
    ).toBe(true);
    expect(
      isSameToolMutationAction(
        { toolName: "write", actionFingerprint: "tool=write|path=/tmp/a" },
        { toolName: "write", actionFingerprint: "tool=write|path=/tmp/b" },
      ),
    ).toBe(false);
    expect(
      isSameToolMutationAction(
        { toolName: "write", actionFingerprint: "tool=write|path=/tmp/a" },
        { toolName: "write" },
      ),
    ).toBe(false);
  });

  it("populates structured fileTarget for file-mutating calls (#79024)", () => {
    expect(buildToolMutationState("edit", { file_path: "/tmp/a" }).fileTarget).toEqual({
      path: "/tmp/a",
    });
    expect(buildToolMutationState("write", { path: "/tmp/Foo|bar" }).fileTarget).toEqual({
      path: "/tmp/foo|bar",
    });
    // Non-file-mutating tools never carry fileTarget, even with a path arg.
    expect(buildToolMutationState("bash", { command: "rm /tmp/a" }).fileTarget).toBeUndefined();
    expect(buildToolMutationState("exec", { command: "touch /tmp/a" }).fileTarget).toBeUndefined();
    // apply_patch is excluded from file-mutating set, so no fileTarget even
    // if a path-shaped arg is synthetically present.
    expect(
      buildToolMutationState("apply_patch", { input: "*** Update File: /tmp/a" }).fileTarget,
    ).toBeUndefined();
  });

  it("recognizes cross-tool file-mutation recovery on the same target (#79024)", () => {
    expect(
      isSameToolMutationAction(
        {
          toolName: "edit",
          actionFingerprint: "tool=edit|path=/tmp/a",
          fileTarget: { path: "/tmp/a" },
        },
        {
          toolName: "write",
          actionFingerprint: "tool=write|path=/tmp/a",
          fileTarget: { path: "/tmp/a" },
        },
      ),
    ).toBe(true);
    expect(
      isSameToolMutationAction(
        {
          toolName: "write",
          actionFingerprint: "tool=write|path=/tmp/a",
          fileTarget: { path: "/tmp/a" },
        },
        {
          toolName: "edit",
          actionFingerprint: "tool=edit|path=/tmp/a",
          fileTarget: { path: "/tmp/a" },
        },
      ),
    ).toBe(true);
    // `apply_patch` is intentionally excluded from the file-mutating set
    // because production `apply_patch` calls only carry opaque `input` text,
    // so `extractFileTarget` returns `undefined` and the fail-closed branch
    // refuses cross-tool recovery.
    expect(
      isSameToolMutationAction(
        {
          toolName: "edit",
          actionFingerprint: "tool=edit|path=/tmp/a",
          fileTarget: { path: "/tmp/a" },
        },
        {
          toolName: "apply_patch",
          actionFingerprint: "tool=apply_patch|path=/tmp/a",
          fileTarget: { path: "/tmp/a" },
        },
      ),
    ).toBe(false);
  });

  it("does not cross-recover file mutations on different targets (#79024)", () => {
    expect(
      isSameToolMutationAction(
        {
          toolName: "edit",
          actionFingerprint: "tool=edit|path=/tmp/a",
          fileTarget: { path: "/tmp/a" },
        },
        {
          toolName: "write",
          actionFingerprint: "tool=write|path=/tmp/b",
          fileTarget: { path: "/tmp/b" },
        },
      ),
    ).toBe(false);
  });

  it("does not over-match paths containing the fingerprint delimiter (#79024)", () => {
    // The fingerprint string carries raw paths separated by `|`. A naive
    // `split("|")` parser would extract `path=/tmp/a` from both fingerprints
    // and incorrectly clear the prior failure. Structural fileTarget
    // comparison fails closed for these distinct paths.
    expect(
      isSameToolMutationAction(
        {
          toolName: "edit",
          actionFingerprint: "tool=edit|path=/tmp/a|left",
          fileTarget: { path: "/tmp/a|left" },
        },
        {
          toolName: "write",
          actionFingerprint: "tool=write|path=/tmp/a|right",
          fileTarget: { path: "/tmp/a|right" },
        },
      ),
    ).toBe(false);
    // Same delimiter-bearing path on both sides still matches.
    expect(
      isSameToolMutationAction(
        {
          toolName: "edit",
          actionFingerprint: "tool=edit|path=/tmp/a|shared",
          fileTarget: { path: "/tmp/a|shared" },
        },
        {
          toolName: "write",
          actionFingerprint: "tool=write|path=/tmp/a|shared",
          fileTarget: { path: "/tmp/a|shared" },
        },
      ),
    ).toBe(true);
  });

  it("does not cross-recover when the recovery tool is not file-mutating (#79024)", () => {
    expect(
      isSameToolMutationAction(
        {
          toolName: "edit",
          actionFingerprint: "tool=edit|path=/tmp/a",
          fileTarget: { path: "/tmp/a" },
        },
        { toolName: "bash", actionFingerprint: "tool=bash|meta=cat /tmp/a" },
      ),
    ).toBe(false);
    expect(
      isSameToolMutationAction(
        {
          toolName: "edit",
          actionFingerprint: "tool=edit|path=/tmp/a",
          fileTarget: { path: "/tmp/a" },
        },
        { toolName: "exec", actionFingerprint: "tool=exec|meta=touch /tmp/a" },
      ),
    ).toBe(false);
  });

  it("ignores call-specific noise when comparing the cross-tool target (#79024)", () => {
    // `id=...` and `meta=...` segments differ between calls; structural
    // fileTarget comparison is unaffected.
    expect(
      isSameToolMutationAction(
        {
          toolName: "edit",
          actionFingerprint: "tool=edit|path=/tmp/a|id=42|meta=edit /tmp/a",
          fileTarget: { path: "/tmp/a" },
        },
        {
          toolName: "write",
          actionFingerprint: "tool=write|path=/tmp/a|id=99|meta=write /tmp/a",
          fileTarget: { path: "/tmp/a" },
        },
      ),
    ).toBe(true);
  });

  it("keeps legacy name-only mutating heuristics for payload fallback", () => {
    expect(isLikelyMutatingToolName("sessions_spawn")).toBe(true);
    expect(isLikelyMutatingToolName("sessions_send")).toBe(true);
    expect(isLikelyMutatingToolName("computer")).toBe(true);
    expect(isLikelyMutatingToolName("browser_actions")).toBe(true);
    expect(isLikelyMutatingToolName("message_slack")).toBe(true);
    expect(isLikelyMutatingToolName("browser")).toBe(false);
  });
});
