import path from "node:path";
import { describe, expect, it } from "vitest";
import { deriveToolParams } from "./host-tool-param-parsers.js";

const defaultCwd = process.cwd();
const cwdPath = (...segments: string[]) => path.join(defaultCwd, ...segments);

describe("deriveToolParams", () => {
  it("returns an empty object for tools that have no registered parser", () => {
    expect(deriveToolParams("exec", { command: "ls" })).toEqual({});
    expect(deriveToolParams("read_file", { path: "/tmp/x" })).toEqual({});
  });

  it("ignores prototype-key tool names when looking up parsers", () => {
    expect(deriveToolParams("__proto__", { input: "anything" })).toEqual({});
    expect(deriveToolParams("hasOwnProperty", { input: "anything" })).toEqual({});
  });

  it("derives apply_patch destination paths from the input envelope", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+x",
      "*** Update File: src/old.ts",
      "*** Move to: src/renamed.ts",
      "@@",
      "+y",
      "*** Delete File: src/dead.ts",
      "*** End Patch",
    ].join("\n");
    expect(deriveToolParams("apply_patch", { input: patch })).toEqual({
      derivedPaths: [
        cwdPath("src/new.ts"),
        cwdPath("src/old.ts"),
        cwdPath("src/renamed.ts"),
        cwdPath("src/dead.ts"),
      ],
    });
  });

  it("returns immutable derived path snapshots", () => {
    const patch = ["*** Begin Patch", "*** Add File: src/new.ts", "+x", "*** End Patch"].join("\n");
    const derived = deriveToolParams("apply_patch", { input: patch });
    expect(Array.isArray(derived.derivedPaths)).toBe(true);
    expect(Object.isFrozen(derived.derivedPaths)).toBe(true);
  });

  it("resolves derived apply_patch paths against the tool cwd when provided", () => {
    const patch = ["*** Begin Patch", "*** Add File: @src/../new.ts", "+x", "*** End Patch"].join(
      "\n",
    );
    const cwd = path.join("/tmp", "openclaw-derived");
    expect(deriveToolParams("apply_patch", { input: patch }, { cwd })).toEqual({
      derivedPaths: [path.join(cwd, "new.ts")],
    });
  });

  it("preserves apply_patch backslashes when deriving path facts", () => {
    const patch = [
      "*** Begin Patch",
      String.raw`*** Add File: safe\evil.ts`,
      "+x",
      "*** End Patch",
    ].join("\n");
    expect(deriveToolParams("apply_patch", { input: patch })).toEqual({
      derivedPaths: [path.resolve(defaultCwd, String.raw`safe\evil.ts`)],
    });
  });

  it("preserves apply_patch marker payload bytes after the executor header trim", () => {
    const patch = ["*** Begin Patch", "*** Add File:  src/new.ts", "+x", "*** End Patch"].join(
      "\n",
    );
    expect(deriveToolParams("apply_patch", { input: patch })).toEqual({
      derivedPaths: [path.resolve(defaultCwd, " src/new.ts")],
    });
  });

  it("resolves sandboxed apply_patch paths through the execution bridge", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: /workspace/src/new.ts",
      "+x",
      "*** End Patch",
    ].join("\n");
    expect(
      deriveToolParams(
        "apply_patch",
        { input: patch },
        {
          cwd: "/workspace",
          sandbox: {
            root: "/workspace",
            bridge: {
              resolvePath: ({ filePath }: { filePath: string }) => ({
                containerPath: filePath,
                hostPath: "/host/sandbox/src/new.ts",
                relativePath: "src/new.ts",
              }),
            } as never,
          },
        },
      ),
    ).toEqual({
      derivedPaths: ["/host/sandbox/src/new.ts"],
    });
  });

  it("returns an empty object when apply_patch input has no recognised paths", () => {
    expect(deriveToolParams("apply_patch", { input: "not a patch" })).toEqual({});
    expect(deriveToolParams("apply_patch", {})).toEqual({});
    expect(deriveToolParams("apply_patch", undefined)).toEqual({});
  });

  it("does not throw for malformed param shapes", () => {
    expect(deriveToolParams("apply_patch", null)).toEqual({});
    expect(deriveToolParams("apply_patch", 42)).toEqual({});
  });
});
