import { describe, expect, it } from "vitest";
import { formatToolDetail, resolveToolDisplay } from "./tool-display.js";

describe("tool display details", () => {
  it("skips zero/false values for optional detail fields", () => {
    const detail = formatToolDetail(
      resolveToolDisplay({
        name: "sessions_spawn",
        args: {
          task: "double-message-bug-gpt",
          label: 0,
          runTimeoutSeconds: 0,
        },
      }),
    );

    expect(detail).toBe("double-message-bug-gpt");
  });

  it("includes only truthy boolean details", () => {
    const detail = formatToolDetail(
      resolveToolDisplay({
        name: "message",
        args: {
          action: "react",
          provider: "discord",
          to: "chan-1",
          remove: false,
        },
      }),
    );

    expect(detail).toContain("provider discord");
    expect(detail).toContain("to chan-1");
    expect(detail).not.toContain("remove");
  });

  it("keeps positive numbers and true booleans", () => {
    const detail = formatToolDetail(
      resolveToolDisplay({
        name: "sessions_history",
        args: {
          sessionKey: "agent:main:main",
          limit: 20,
          includeTools: true,
        },
      }),
    );

    expect(detail).toContain("session agent:main:main");
    expect(detail).toContain("limit 20");
    expect(detail).toContain("tools true");
  });

  it("formats read/write/edit with intent-first file detail", () => {
    const readDetail = formatToolDetail(
      resolveToolDisplay({
        name: "read",
        args: { file_path: "/tmp/a.txt", offset: 2, limit: 2 },
      }),
    );
    const writeDetail = formatToolDetail(
      resolveToolDisplay({
        name: "write",
        args: { file_path: "/tmp/a.txt", content: "abc" },
      }),
    );
    const editDetail = formatToolDetail(
      resolveToolDisplay({
        name: "edit",
        args: { path: "/tmp/a.txt", newText: "abcd" },
      }),
    );

    expect(readDetail).toBe("lines 2-3 from /tmp/a.txt");
    expect(writeDetail).toBe("to /tmp/a.txt (3 chars)");
    expect(editDetail).toBe("in /tmp/a.txt (4 chars)");
  });

  it("formats web_search query with quotes", () => {
    const detail = formatToolDetail(
      resolveToolDisplay({
        name: "web_search",
        args: { query: "OpenClaw docs", count: 3 },
      }),
    );

    expect(detail).toBe('for "OpenClaw docs" (top 3)');
  });

  it("summarizes exec commands with context", () => {
    const detail = formatToolDetail(
      resolveToolDisplay({
        name: "exec",
        args: {
          command:
            "set -euo pipefail\ngit -C /Users/adityasingh/.openclaw/workspace status --short | head -n 3",
          workdir: "/Users/adityasingh/.openclaw/workspace",
        },
      }),
    );

    expect(detail).toContain("check git status -> show first 3 lines");
    expect(detail).toContain(".openclaw/workspace)");
  });

  it("moves cd path to context suffix and appends raw command", () => {
    const detail = formatToolDetail(
      resolveToolDisplay({
        name: "exec",
        args: { command: "cd ~/my-project && npm install" },
      }),
    );

    expect(detail).toBe("install dependencies (in ~/my-project), `cd ~/my-project && npm install`");
  });

  it("omits raw command details in explain mode", () => {
    const detail = formatToolDetail(
      resolveToolDisplay({
        name: "exec",
        args: { command: "cd ~/my-project && npm install" },
        detailMode: "explain",
      }),
    );

    expect(detail).toBe("install dependencies (in ~/my-project)");
  });

  it("moves cd path to context suffix with multiple stages and raw command", () => {
    const detail = formatToolDetail(
      resolveToolDisplay({
        name: "exec",
        args: { command: "cd ~/my-project && npm install && npm test" },
      }),
    );

    expect(detail).toBe(
      "install dependencies → run tests (in ~/my-project), `cd ~/my-project && npm install && npm test`",
    );
  });

  it("moves pushd path to context suffix and appends raw command", () => {
    const detail = formatToolDetail(
      resolveToolDisplay({
        name: "exec",
        args: { command: "pushd /tmp && git status" },
      }),
    );

    expect(detail).toBe("check git status (in /tmp), `pushd /tmp && git status`");
  });

  it("clears inferred cwd when popd is stripped from preamble", () => {
    const detail = formatToolDetail(
      resolveToolDisplay({
        name: "exec",
        args: { command: "pushd /tmp && popd && npm install" },
      }),
    );

    expect(detail).toBe("install dependencies, `pushd /tmp && popd && npm install`");
  });

  it("moves cd path to context suffix with || separator", () => {
    const detail = formatToolDetail(
      resolveToolDisplay({
        name: "exec",
        args: { command: "cd /app || npm install" },
      }),
    );

    // || means npm install runs when cd FAILS — cd should NOT be stripped as preamble.
    // Both stages are summarized; cd is not treated as context prefix.
    expect(detail).toMatch(/^run cd \/app → install dependencies/);
  });

  it("explicit workdir takes priority over cd path", () => {
    const detail = formatToolDetail(
      resolveToolDisplay({
        name: "exec",
        args: { command: "cd /tmp && npm install", workdir: "/app" },
      }),
    );

    expect(detail).toBe("install dependencies (in /app), `cd /tmp && npm install`");
  });

  it("summarizes all stages and appends raw command", () => {
    const detail = formatToolDetail(
      resolveToolDisplay({
        name: "exec",
        args: { command: "git fetch && git rebase origin/main" },
      }),
    );

    expect(detail).toBe(
      "fetch git changes → rebase git branch, `git fetch && git rebase origin/main`",
    );
  });

  it("falls back to raw command for unknown binaries", () => {
    const detail = formatToolDetail(
      resolveToolDisplay({
        name: "exec",
        args: { command: "jj rebase -s abc -d main" },
      }),
    );

    expect(detail).toBe("jj rebase -s abc -d main");
  });

  it("falls back to raw command for unknown binary with cwd", () => {
    const detail = formatToolDetail(
      resolveToolDisplay({
        name: "exec",
        args: { command: "mycli deploy --prod", workdir: "/app" },
      }),
    );

    expect(detail).toBe("mycli deploy --prod (in /app)");
  });

  it("keeps multi-stage summary when only some stages are generic", () => {
    const detail = formatToolDetail(
      resolveToolDisplay({
        name: "exec",
        args: { command: "cargo build && npm test" },
      }),
    );

    // "run cargo build" is generic, but "run tests" is known — keep joined summary
    expect(detail).toMatch(/^run cargo build → run tests/);
  });

  it("handles standalone cd as raw command", () => {
    const detail = formatToolDetail(
      resolveToolDisplay({
        name: "exec",
        args: { command: "cd /tmp" },
      }),
    );

    // standalone cd (no following command) — treated as raw since it's generic
    expect(detail).toBe("cd /tmp");
  });

  it("handles chained cd commands using last path", () => {
    const detail = formatToolDetail(
      resolveToolDisplay({
        name: "exec",
        args: { command: "cd /tmp && cd /app" },
      }),
    );

    // both cd's are preamble; last path wins
    expect(detail).toBe("cd /tmp && cd /app (in /app)");
  });

  it("respects quotes when splitting preamble separators", () => {
    const detail = formatToolDetail(
      resolveToolDisplay({
        name: "exec",
        args: { command: 'export MSG="foo && bar" && echo test' },
      }),
    );

    // The && inside quotes must not be treated as a separator —
    // summary line should be "print text", not "run export" (which would happen
    // if the quoted && was mistaken for a real separator).
    expect(detail).toMatch(/^print text/);
  });

  it("recognizes heredoc/inline script exec details", () => {
    const pyDetail = formatToolDetail(
      resolveToolDisplay({
        name: "exec",
        args: {
          command: "python3 <<PY\nprint('x')\nPY",
          workdir: "/Users/adityasingh/.openclaw/workspace",
        },
      }),
    );
    const nodeCheckDetail = formatToolDetail(
      resolveToolDisplay({
        name: "exec",
        args: {
          command: "node --check /tmp/test.js",
          workdir: "/Users/adityasingh/.openclaw/workspace",
        },
      }),
    );
    const nodeShortCheckDetail = formatToolDetail(
      resolveToolDisplay({
        name: "exec",
        args: {
          command: "node -c /tmp/test.js",
          workdir: "/Users/adityasingh/.openclaw/workspace",
        },
      }),
    );

    expect(pyDetail).toContain("run python3 inline script (heredoc)");
    expect(nodeCheckDetail).toContain("check js syntax for /tmp/test.js");
    expect(nodeShortCheckDetail).toContain("check js syntax for /tmp/test.js");
  });
});
