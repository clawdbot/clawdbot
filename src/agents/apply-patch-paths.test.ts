import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractApplyPatchTargetPaths } from "./apply-patch-paths.js";

const defaultCwd = process.cwd();
const cwdPath = (...segments: string[]) => path.join(defaultCwd, ...segments);

describe("extractApplyPatchTargetPaths", () => {
  it("returns an empty array for non-string input", () => {
    expect(extractApplyPatchTargetPaths(undefined)).toEqual([]);
    expect(extractApplyPatchTargetPaths(null)).toEqual([]);
    expect(extractApplyPatchTargetPaths(42)).toEqual([]);
    expect(extractApplyPatchTargetPaths({})).toEqual([]);
    expect(extractApplyPatchTargetPaths({ input: 7 })).toEqual([]);
  });

  it("returns an empty array for an empty patch", () => {
    expect(extractApplyPatchTargetPaths("")).toEqual([]);
    expect(extractApplyPatchTargetPaths({ input: "" })).toEqual([]);
  });

  it("extracts Add File markers from the envelope payload", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+export const a = 1;",
      "*** End Patch",
    ].join("\n");
    expect(extractApplyPatchTargetPaths(patch)).toEqual([cwdPath("src/new.ts")]);
  });

  it("extracts Update File and Delete File markers", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.ts",
      "@@",
      " context",
      "+added",
      "*** Delete File: b.ts",
      "*** End Patch",
    ].join("\n");
    expect(extractApplyPatchTargetPaths(patch)).toEqual([cwdPath("a.ts"), cwdPath("b.ts")]);
  });

  it("includes the Move to: target paired with an Update File", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: old/path.ts",
      "*** Move to: new/path.ts",
      "@@",
      " context",
      "+added",
      "*** End Patch",
    ].join("\n");
    expect(extractApplyPatchTargetPaths(patch)).toEqual([
      cwdPath("old/path.ts"),
      cwdPath("new/path.ts"),
    ]);
  });

  it("tolerates blank lines between Update File and Move to", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.ts",
      "",
      "*** Move to: b.ts",
      "*** End Patch",
    ].join("\n");
    expect(extractApplyPatchTargetPaths(patch)).toEqual([cwdPath("a.ts"), cwdPath("b.ts")]);
  });

  it("accepts the wrapper object form used by the apply_patch tool", () => {
    const patch = ["*** Begin Patch", "*** Add File: foo.ts", "+x", "*** End Patch"].join("\n");
    expect(extractApplyPatchTargetPaths({ input: patch })).toEqual([cwdPath("foo.ts")]);
  });

  it("de-duplicates repeated paths within a single envelope", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: same.ts",
      "+a",
      "*** Update File: same.ts",
      "@@",
      "+b",
      "*** End Patch",
    ].join("\n");
    expect(extractApplyPatchTargetPaths(patch)).toEqual([cwdPath("same.ts")]);
  });

  it("normalizes derived paths before de-duplicating them", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: safe/../secret.ts",
      "+x",
      "*** Update File: ./src//old.ts",
      "*** Move to: src/temp/../renamed.ts",
      "@@",
      "+y",
      "*** Delete File: secret.ts",
      "*** End Patch",
    ].join("\n");
    expect(extractApplyPatchTargetPaths(patch)).toEqual([
      cwdPath("secret.ts"),
      cwdPath("src/old.ts"),
      cwdPath("src/renamed.ts"),
    ]);
  });

  it("preserves POSIX backslashes to match apply_patch execution", () => {
    const patch = [
      "*** Begin Patch",
      String.raw`*** Add File: src\windows\path.ts`,
      "+x",
      String.raw`*** Add File: safe\evil.ts`,
      "*** End Patch",
    ].join("\n");
    expect(extractApplyPatchTargetPaths(patch)).toEqual([
      path.resolve(defaultCwd, String.raw`src\windows\path.ts`),
      path.resolve(defaultCwd, String.raw`safe\evil.ts`),
    ]);
    expect(extractApplyPatchTargetPaths(patch)).not.toContain(cwdPath("safe", "evil.ts"));
  });

  it("handles CRLF line endings", () => {
    const patch = ["*** Begin Patch", "*** Add File: crlf.ts", "+x", "*** End Patch"].join("\r\n");
    expect(extractApplyPatchTargetPaths(patch)).toEqual([cwdPath("crlf.ts")]);
  });

  it("matches indented hunk headers the same way as the apply_patch executor", () => {
    const patch = [
      "  *** Begin Patch",
      "  *** Add File: src/new.ts",
      "+x",
      "  *** Delete File: src/dead.ts",
      "  *** Update File: src/old.ts",
      "  *** Move to: src/renamed.ts",
      "@@",
      "-old",
      "+new",
      "  *** End Patch",
    ].join("\n");
    expect(extractApplyPatchTargetPaths(patch)).toEqual([
      cwdPath("src/new.ts"),
      cwdPath("src/dead.ts"),
      cwdPath("src/old.ts"),
      cwdPath("src/renamed.ts"),
    ]);
  });

  it("matches single-space-indented top-level headers the same way as the executor", () => {
    const patch = [
      "*** Begin Patch",
      " *** Add File: src/new.ts",
      "+x",
      " *** Delete File: src/dead.ts",
      "*** End Patch",
    ].join("\n");
    expect(extractApplyPatchTargetPaths(patch)).toEqual([
      cwdPath("src/new.ts"),
      cwdPath("src/dead.ts"),
    ]);
  });

  it("finds top-level markers after an update hunk", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/old.ts",
      "@@",
      "-old",
      "+new",
      "*** Delete File: src/dead.ts",
      "*** End Patch",
    ].join("\n");
    expect(extractApplyPatchTargetPaths(patch)).toEqual([
      cwdPath("src/old.ts"),
      cwdPath("src/dead.ts"),
    ]);
  });

  it("ignores markers outside of the envelope grammar", () => {
    expect(
      extractApplyPatchTargetPaths(
        ["nothing here", "*** Random Marker: x", "+a", "context"].join("\n"),
      ),
    ).toEqual([]);
  });

  it("ignores marker-like context and body lines inside update hunks", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: real.ts",
      "@@",
      " *** Add File: fake-context.ts",
      "  *** Delete File: fake-indented-context.ts",
      "-*** Delete File: fake-remove.ts",
      "+*** Add File: fake-add.ts",
      "*** End Patch",
    ].join("\n");
    expect(extractApplyPatchTargetPaths(patch)).toEqual([cwdPath("real.ts")]);
  });

  it("can resolve paths with the same cwd semantics as apply_patch execution", () => {
    const cwd = path.join(os.tmpdir(), "openclaw-derived-paths");
    const patch = [
      "*** Begin Patch",
      "*** Add File: @src/../resolved.ts",
      "+x",
      "*** Update File: ~/renamed-source.ts",
      "*** Move to: /tmp/openclaw-target.ts",
      "@@",
      "+y",
      "*** End Patch",
    ].join("\n");
    expect(extractApplyPatchTargetPaths(patch, { cwd })).toEqual([
      path.join(cwd, "resolved.ts"),
      path.join(os.homedir(), "renamed-source.ts"),
      path.join("/tmp", "openclaw-target.ts"),
    ]);
  });

  it("defaults missing cwd to apply_patch process cwd semantics", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: @src/../resolved.ts",
      "+x",
      "*** Update File: ~/source.ts",
      "*** Move to: src/moved.ts",
      "@@",
      "+y",
      "*** End Patch",
    ].join("\n");
    expect(extractApplyPatchTargetPaths(patch)).toEqual([
      cwdPath("resolved.ts"),
      path.join(os.homedir(), "source.ts"),
      cwdPath("src/moved.ts"),
    ]);
  });

  it("skips sandbox paths the bridge rejects", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: /workspace/src/ok.ts",
      "+x",
      "*** Add File: /outside.ts",
      "+y",
      "*** End Patch",
    ].join("\n");
    expect(
      extractApplyPatchTargetPaths(patch, {
        cwd: "/workspace",
        sandbox: {
          root: "/workspace",
          bridge: {
            resolvePath: ({ filePath }: { filePath: string }) => {
              if (filePath === "/outside.ts") {
                throw new Error("Path escapes sandbox root");
              }
              return {
                containerPath: filePath,
                hostPath: filePath.replace("/workspace", "/host/workspace"),
                relativePath: filePath.replace("/workspace/", ""),
              };
            },
          } as never,
        },
      }),
    ).toEqual(["/host/workspace/src/ok.ts"]);
  });

  it("does not require the begin/end envelope markers to be present", () => {
    const patch = ["*** Add File: loose.ts", "+x"].join("\n");
    expect(extractApplyPatchTargetPaths(patch)).toEqual([cwdPath("loose.ts")]);
  });
});
