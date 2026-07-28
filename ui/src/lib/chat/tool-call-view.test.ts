// @vitest-environment node
// Control UI tests cover tool-call classification and view-model resolution.
import { describe, expect, it } from "vitest";
import {
  resolveToolCallKind,
  resolveToolCallView,
  unwrapShellWrapperCommand,
} from "./tool-call-view.ts";

const TEXT_EDITOR_TOOL_NAMES = ["str_replace_editor", "str_replace_based_edit_tool"] as const;

describe("resolveToolCallKind", () => {
  it.each([
    ["bash", undefined, "command"],
    ["exec", undefined, "command"],
    ["Read", undefined, "read"],
    ["read_file", undefined, "read"],
    ["edit", undefined, "edit"],
    ["edit_file", undefined, "edit"],
    ["apply_patch", undefined, "edit"],
    ["write", undefined, "write"],
    ["create_file", undefined, "write"],
    ["grep", undefined, "search"],
    ["glob", undefined, "search"],
    ["web_fetch", undefined, "fetch"],
    ["mcp__linear__create_issue", undefined, "generic"],
    // Arg-shape fallback: unknown tool with a small command payload is a command.
    ["run_shell", { command: "ls" }, "command"],
    ["run_shell", { command: "ls", a: 1, b: 2, c: 3 }, "generic"],
  ])("classifies %s with args %o as %s", (name, args, expected) => {
    expect(resolveToolCallKind(name, args)).toBe(expected);
  });

  it.each(
    TEXT_EDITOR_TOOL_NAMES.flatMap(
      (name) =>
        [
          [name, { command: "view" }, "read"],
          [name, { command: "str_replace" }, "edit"],
          [name, { command: "create" }, "write"],
          [name, { command: "insert" }, "edit"],
          [name, { command: "undo_edit" }, "edit"],
          [name, {}, "generic"],
          [name, { command: "rename" }, "generic"],
        ] as const,
    ),
  )("classifies command-discriminated editor %s args %o as %s", (name, args, expected) => {
    expect(resolveToolCallKind(name, args)).toBe(expected);
  });
});

describe("unwrapShellWrapperCommand", () => {
  it.each([
    ["/bin/zsh -lc 'pnpm test ui'", "pnpm test ui"],
    ['/bin/bash -c "git status"', "git status"],
    ["sh -lc 'echo hi'", "echo hi"],
    ["pnpm test ui", "pnpm test ui"],
    ["/bin/zsh -lc unquoted", "/bin/zsh -lc unquoted"],
  ])("unwraps %s", (wrapped, expected) => {
    expect(unwrapShellWrapperCommand(wrapped)).toBe(expected);
  });

  it("unwraps the shell wrapper in command views", () => {
    expect(
      resolveToolCallView({ name: "bash", args: { command: "/bin/zsh -lc 'node --version'" } }),
    ).toEqual({ kind: "command", command: "node --version" });
  });
});

describe("resolveToolCallView", () => {
  it("returns the command text for command rows", () => {
    expect(resolveToolCallView({ name: "bash", args: { command: "git status" } })).toEqual({
      kind: "command",
      command: "git status",
    });
  });

  it("resolves read targets across path spellings", () => {
    for (const args of [
      { path: "/repo/src/main.ts" },
      { file_path: "/repo/src/main.ts" },
      { filePath: "/repo/src/main.ts" },
      { file: "/repo/src/main.ts" },
      { filepath: "/repo/src/main.ts" },
    ]) {
      expect(resolveToolCallView({ name: "read", args })).toEqual({
        kind: "read",
        target: "main.ts",
        targetDetail: "/repo/src",
      });
    }
  });

  it("computes an edit diff from openclaw-style oldText/newText args", () => {
    const view = resolveToolCallView({
      name: "edit",
      args: { path: "/repo/a.ts", oldText: "old line", newText: "new line" },
    });

    expect(view.kind).toBe("edit");
    expect(view.target).toBe("a.ts");
    expect(view.targetDetail).toBe("/repo");
    expect(view.diff).toEqual([
      { kind: "del", text: "old line" },
      { kind: "add", text: "new line" },
    ]);
    expect(view.stat).toEqual({ added: 1, removed: 1 });
  });

  it("computes an edit diff from Claude-style old_string/new_string args", () => {
    const view = resolveToolCallView({
      name: "edit",
      args: { file_path: "/repo/a.ts", old_string: "before", new_string: "after" },
    });

    expect(view.diff).toEqual([
      { kind: "del", text: "before" },
      { kind: "add", text: "after" },
    ]);
  });

  it("keeps old_str/new_str support for legacy edit aliases", () => {
    const view = resolveToolCallView({
      name: "edit_file",
      args: { file: "/repo/a.ts", old_str: "before", new_str: "after" },
    });

    expect(view.target).toBe("a.ts");
    expect(view.diff).toEqual([
      { kind: "del", text: "before" },
      { kind: "add", text: "after" },
    ]);
  });

  it.each(TEXT_EDITOR_TOOL_NAMES)("resolves %s command-specific views", (name) => {
    expect(
      resolveToolCallView({
        name,
        args: { command: "view", file_path: "/repo/view.ts", view_range: [10, 20] },
      }),
    ).toEqual({ kind: "read", target: "view.ts", targetDetail: "/repo" });

    expect(
      resolveToolCallView({
        name,
        args: {
          command: "str_replace",
          file: "/repo/edit.ts",
          old_str: "before",
          new_str: "after",
        },
      }),
    ).toMatchObject({
      kind: "edit",
      target: "edit.ts",
      diff: [
        { kind: "del", text: "before" },
        { kind: "add", text: "after" },
      ],
      stat: { added: 1, removed: 1 },
    });

    expect(
      resolveToolCallView({
        name,
        args: { command: "create", filepath: "/repo/new.ts", file_text: "one\ntwo\n" },
      }),
    ).toMatchObject({
      kind: "write",
      target: "new.ts",
      stat: { added: 2, removed: 0 },
    });

    const insertion = resolveToolCallView({
      name,
      args: {
        command: "insert",
        filename: "/repo/insert.ts",
        insert_line: 42,
        insert_text: "x\ny",
      },
    });
    expect(insertion).toMatchObject({
      kind: "edit",
      target: "insert.ts",
      diff: [
        { kind: "add", text: "x" },
        { kind: "add", text: "y" },
      ],
    });
    expect(insertion.stat).toBeUndefined();

    expect(
      resolveToolCallView({
        name,
        args: {
          command: "undo_edit",
          path: "/repo/undo.ts",
          old_str: "must not",
          new_str: "render",
        },
      }),
    ).toEqual({ kind: "edit", target: "undo.ts", targetDetail: "/repo" });
  });

  it("joins multi-edit diffs with skip separators", () => {
    const view = resolveToolCallView({
      name: "multiedit",
      args: {
        path: "/repo/a.ts",
        edits: [
          { oldText: "one", newText: "uno" },
          { oldText: "two", newText: "dos" },
        ],
      },
    });

    expect(view.diff).toEqual([
      { kind: "del", text: "one" },
      { kind: "add", text: "uno" },
      { kind: "skip", text: "" },
      { kind: "del", text: "two" },
      { kind: "add", text: "dos" },
    ]);
    expect(view.stat).toEqual({ added: 2, removed: 2 });
  });

  it("prefers the numbered details diff over locally computed arg diffs", () => {
    const view = resolveToolCallView({
      name: "edit",
      args: { path: "/repo/a.ts", oldText: "arg old", newText: "arg new" },
      details: { diff: "-12 detail old\n+12 detail new" },
    });

    expect(view.diff).toEqual([
      { kind: "del", lineNo: 12, text: "detail old" },
      { kind: "add", lineNo: 12, text: "detail new" },
    ]);
  });

  it("omits exact stats for truncated persisted details diffs", () => {
    const view = resolveToolCallView({
      name: "edit",
      args: { path: "/repo/a.ts", oldText: "old", newText: "new" },
      details: { diff: "+12 detail new\n...(truncated)..." },
    });

    expect(view.diff).toEqual([
      { kind: "add", lineNo: 12, text: "detail new" },
      { kind: "skip", text: "" },
    ]);
    expect(view.stat).toBeUndefined();
  });

  it("falls back to arg diffs when the details diff is unparseable", () => {
    const view = resolveToolCallView({
      name: "edit",
      args: { path: "/repo/a.ts", oldText: "old", newText: "new" },
      details: { diff: "raw unnumbered text" },
    });

    expect(view.diff).toEqual([
      { kind: "del", text: "old" },
      { kind: "add", text: "new" },
    ]);
  });

  it("renders Codex apply_patch calls as edits with a target path", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/lib/util.ts",
      "@@",
      " context line",
      "-removed line",
      "+added line",
      "*** End Patch",
    ].join("\n");

    const view = resolveToolCallView({ name: "apply_patch", args: { patch } });

    expect(view.kind).toBe("edit");
    expect(view.target).toBe("util.ts");
    expect(view.targetDetail).toBe("src/lib");
    expect(view.diff).toContainEqual({ kind: "del", text: "removed line" });
    expect(view.diff).toContainEqual({ kind: "add", text: "added line" });
    expect(view.stat).toEqual({ added: 1, removed: 1 });
  });

  it("keeps multi-file Codex patches separated and counts every target", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@",
      "-old a",
      "+new a",
      "*** Add File: src/b.ts",
      "+new b",
      "*** Delete File: src/c.ts",
      "*** End Patch",
    ].join("\n");

    const view = resolveToolCallView({ name: "apply_patch", args: { patch } });

    expect(view.target).toBe("3 files");
    expect(view.targetDetail).toBeUndefined();
    expect(view.stat).toEqual({ added: 2, removed: 1 });
    expect(view.diff).toEqual([
      { kind: "file", text: "Update src/a.ts" },
      { kind: "del", text: "old a" },
      { kind: "add", text: "new a" },
      { kind: "skip", text: "" },
      { kind: "file", text: "Add src/b.ts" },
      { kind: "add", lineNo: 1, text: "new b" },
      { kind: "skip", text: "" },
      { kind: "file", text: "Delete src/c.ts" },
    ]);
  });

  it("retains source context for Codex moves", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/old.ts",
      "*** Move to: src/new.ts",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");

    const view = resolveToolCallView({ name: "apply_patch", args: { patch } });

    expect(view.target).toBe("old.ts → new.ts");
    expect(view.targetDetail).toBe("src");
  });

  it("numbers Codex update hunks", () => {
    const patch = ["*** Update File: src/a.ts", "@@ -4,2 +4,2 @@", " context", "-old", "+new"].join(
      "\n",
    );

    const view = resolveToolCallView({ name: "apply_patch", args: { patch } });

    expect(view.diff).toEqual([
      { kind: "ctx", lineNo: 4, text: "context" },
      { kind: "del", lineNo: 5, text: "old" },
      { kind: "add", lineNo: 5, text: "new" },
    ]);
  });

  it("splits headerless multi-file unified diffs and numbers hunks", () => {
    const patch = [
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -10,3 +10,4 @@",
      " context",
      "-old",
      "+new",
      "+extra",
      " tail",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -1 +1 @@",
      "-before",
      "+after",
    ].join("\n");

    const view = resolveToolCallView({ name: "apply_patch", args: { patch } });

    expect(view.target).toBe("2 files");
    expect(view.stat).toEqual({ added: 3, removed: 2 });
    expect(view.diff).toEqual([
      { kind: "file", text: "Update src/a.ts" },
      { kind: "ctx", lineNo: 10, text: "context" },
      { kind: "del", lineNo: 11, text: "old" },
      { kind: "add", lineNo: 11, text: "new" },
      { kind: "add", lineNo: 12, text: "extra" },
      { kind: "ctx", lineNo: 13, text: "tail" },
      { kind: "skip", text: "" },
      { kind: "file", text: "Update src/b.ts" },
      { kind: "del", lineNo: 1, text: "before" },
      { kind: "add", lineNo: 1, text: "after" },
    ]);
  });

  it("does not mistake valid Codex body lines for unified-diff headers", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: docs/example.md",
      "@@",
      "----",
      "+++ b/not-a-header",
      "*** End Patch",
    ].join("\n");

    const view = resolveToolCallView({ name: "apply_patch", args: { patch } });

    expect(view.diff).toEqual([
      { kind: "del", text: "---" },
      { kind: "add", text: "++ b/not-a-header" },
    ]);
    expect(view.stat).toEqual({ added: 1, removed: 1 });
  });

  it("renders structured Codex file changes per file", () => {
    const view = resolveToolCallView({
      name: "apply_patch",
      args: {
        changes: [
          {
            path: "src/a.ts",
            kind: { type: "update", move_path: null },
            diff: "@@\n-old a\n+new a",
          },
          { path: "src/b.ts", kind: { type: "add" }, diff: "new b\n" },
        ],
      },
    });

    expect(view.target).toBe("2 files");
    expect(view.stat).toEqual({ added: 2, removed: 1 });
    expect(view.diff).toContainEqual({ kind: "file", text: "Update src/a.ts" });
    expect(view.diff).toContainEqual({ kind: "file", text: "Add src/b.ts" });
  });

  it("numbers structured Codex update hunks", () => {
    const view = resolveToolCallView({
      name: "apply_patch",
      args: {
        changes: [
          {
            path: "src/a.ts",
            kind: { type: "update" },
            diff: "@@ -7,2 +7,2 @@\n context\n-old\n+new",
          },
        ],
      },
    });

    expect(view.diff).toEqual([
      { kind: "ctx", lineNo: 7, text: "context" },
      { kind: "del", lineNo: 8, text: "old" },
      { kind: "add", lineNo: 8, text: "new" },
    ]);
  });

  it("caps apply_patch rows while keeping the full diffstat", () => {
    const bigPatch = [
      "*** Begin Patch",
      "*** Update File: big.ts",
      ...Array.from({ length: 900 }, (_, index) => `+line ${index}`),
      "*** End Patch",
    ].join("\n");

    const view = resolveToolCallView({ name: "apply_patch", args: { patch: bigPatch } });

    expect(view.kind).toBe("edit");
    expect(view.stat).toEqual({ added: 900, removed: 0 });
    expect(view.diff?.length).toBe(401);
    expect(view.diff?.at(-1)?.kind).toBe("skip");
  });

  it("caps the combined preview across multi-edit sections", () => {
    const edits = [0, 1].map((section) => ({
      oldText: `old ${section}`,
      newText: Array.from({ length: 300 }, (_, index) => `new ${section}-${index}`).join("\n"),
    }));

    const view = resolveToolCallView({ name: "multiedit", args: { path: "big.ts", edits } });

    expect(view.diff).toHaveLength(401);
    expect(view.diff?.at(-1)).toEqual({ kind: "skip", text: "" });
    expect(view.stat).toEqual({ added: 600, removed: 2 });
  });

  it("stops processing excess multi-edit pairs and omits a partial diffstat", () => {
    const edits = Array.from({ length: 20 }, (_, index) => ({
      oldText: `old ${index}`,
      newText: `new ${index}`,
    }));

    const view = resolveToolCallView({ name: "multiedit", args: { path: "many.ts", edits } });

    expect(view.diff?.at(-1)).toEqual({ kind: "skip", text: "" });
    expect(view.diff?.length).toBeLessThanOrEqual(401);
    expect(view.stat).toBeUndefined();
  });

  it("accepts the Codex input spelling for patch text", () => {
    const view = resolveToolCallView({
      name: "apply_patch",
      args: { input: "*** Add File: notes.md\n+hello" },
    });

    expect(view.kind).toBe("edit");
    expect(view.target).toBe("notes.md");
    expect(view.stat).toEqual({ added: 1, removed: 0 });
  });

  it("builds an all-added preview for write calls with content", () => {
    const view = resolveToolCallView({
      name: "write",
      args: { path: "/repo/new.ts", content: "line 1\nline 2\n" },
    });

    expect(view).toEqual({
      kind: "write",
      target: "new.ts",
      targetDetail: "/repo",
      diff: [
        { kind: "add", lineNo: 1, text: "line 1" },
        { kind: "add", lineNo: 2, text: "line 2" },
      ],
      stat: { added: 2, removed: 0 },
    });
  });

  it("uses authoritative write details for diff and created-flag stats", () => {
    const args = { path: "/repo/file.ts", content: "line 1\nline 2\n" };

    expect(
      resolveToolCallView({
        name: "write",
        args,
        details: { created: false, diff: "-4 old\n+4 replacement" },
      }),
    ).toMatchObject({
      diff: [
        { kind: "del", lineNo: 4, text: "old" },
        { kind: "add", lineNo: 4, text: "replacement" },
      ],
      stat: { added: 1, removed: 1 },
    });

    const created = resolveToolCallView({ name: "write", args, details: { created: true } });
    expect(created.stat).toEqual({ added: 2, removed: 0 });

    const overwrite = resolveToolCallView({ name: "write", args, details: { created: false } });
    expect(overwrite.diff).toEqual([
      { kind: "add", lineNo: 1, text: "line 1" },
      { kind: "add", lineNo: 2, text: "line 2" },
    ]);
    expect(overwrite.stat).toBeUndefined();

    const unknown = resolveToolCallView({ name: "write", args, details: { changed: true } });
    expect(unknown.diff).toEqual(overwrite.diff);
    expect(unknown.stat).toBeUndefined();

    expect(resolveToolCallView({ name: "write", args, details: { changed: false } })).toEqual({
      kind: "write",
      target: "file.ts",
      targetDetail: "/repo",
    });
  });

  it.each(TEXT_EDITOR_TOOL_NAMES)("applies created-flag stats to %s create", (name) => {
    const view = resolveToolCallView({
      name,
      args: { command: "create", path: "/repo/file.ts", file_text: "replacement\n" },
      details: { created: false },
    });

    expect(view.diff).toEqual([{ kind: "add", lineNo: 1, text: "replacement" }]);
    expect(view.stat).toBeUndefined();
  });

  it("resolves search views from pattern plus path scope", () => {
    expect(resolveToolCallView({ name: "grep", args: { pattern: "TODO", path: "src" } })).toEqual({
      kind: "search",
      target: "TODO",
      targetDetail: "src",
    });
  });

  it("resolves fetch views from the url arg", () => {
    expect(resolveToolCallView({ name: "web_fetch", args: { url: "https://x.dev/a" } })).toEqual({
      kind: "fetch",
      target: "https://x.dev/a",
    });
  });

  it.each([
    ["read without a path", { name: "read", args: {} }],
    ["edit without a path", { name: "edit", args: { oldText: "a", newText: "b" } }],
    ["patch without patch text", { name: "apply_patch", args: {} }],
    ["fetch without a url", { name: "fetch", args: {} }],
    ["unknown tool", { name: "mcp__thing", args: { foo: "bar" } }],
  ])("degrades to generic for %s", (_label, source) => {
    expect(resolveToolCallView(source).kind).toBe("generic");
  });

  it("renders pure deletions without a phantom blank added line", () => {
    const view = resolveToolCallView({
      name: "edit",
      args: { path: "/repo/a.ts", oldText: "gone-line", newText: "" },
    });

    expect(view.stat).toEqual({ added: 0, removed: 1 });
    expect(view.diff).toEqual([{ kind: "del", text: "gone-line" }]);
  });

  it("rebuilds the cached view when result details arrive on the same args", () => {
    const args = { path: "/repo/a.md", edits: [{ oldText: "x", newText: "y" }] };

    const before = resolveToolCallView({ name: "edit", args });
    const after = resolveToolCallView({
      name: "edit",
      args,
      details: { diff: "+12 hello", patch: "" },
    });

    expect(before.diff?.[0]?.lineNo).toBeUndefined();
    expect(after.diff?.[0]).toMatchObject({ kind: "add", lineNo: 12, text: "hello" });
  });

  it("caches views per args object identity", () => {
    const source = { name: "edit", args: { path: "/repo/a.ts", oldText: "x", newText: "y" } };

    expect(resolveToolCallView(source)).toBe(resolveToolCallView(source));
  });
});
