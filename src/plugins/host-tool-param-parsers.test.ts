/** Tests host tool parameter parsers exposed to plugin callbacks. */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deriveToolParams } from "./host-tool-param-parsers.js";

const defaultCwd = process.cwd();
const cwdPath = (...segments: string[]) => path.join(defaultCwd, ...segments);

describe("deriveToolParams", () => {
  it("returns an empty object for tools that have no registered parser", async () => {
    await expect(deriveToolParams("exec", { command: "ls" })).resolves.toEqual({});
    await expect(deriveToolParams("read_file", { path: "/tmp/x" })).resolves.toEqual({});
  });

  it("ignores prototype-key tool names when looking up parsers", async () => {
    await expect(deriveToolParams("__proto__", { input: "anything" })).resolves.toEqual({});
    await expect(deriveToolParams("hasOwnProperty", { input: "anything" })).resolves.toEqual({});
  });

  it("derives apply_patch destination paths from the input envelope", async () => {
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
    await expect(deriveToolParams("apply_patch", { input: patch })).resolves.toEqual({
      derivedPaths: [
        cwdPath("src/new.ts"),
        cwdPath("src/old.ts"),
        cwdPath("src/renamed.ts"),
        cwdPath("src/dead.ts"),
      ],
    });
  });

  it("returns immutable derived path snapshots", async () => {
    const patch = ["*** Begin Patch", "*** Add File: src/new.ts", "+x", "*** End Patch"].join("\n");
    const derived = await deriveToolParams("apply_patch", { input: patch });
    expect(Array.isArray(derived.derivedPaths)).toBe(true);
    expect(Object.isFrozen(derived.derivedPaths)).toBe(true);
  });

  it("resolves derived apply_patch paths against the tool cwd when provided", async () => {
    const patch = ["*** Begin Patch", "*** Add File: @src/../new.ts", "+x", "*** End Patch"].join(
      "\n",
    );
    const cwd = path.join("/tmp", "openclaw-derived");
    await expect(deriveToolParams("apply_patch", { input: patch }, { cwd })).resolves.toEqual({
      derivedPaths: [path.join(cwd, "new.ts")],
    });
  });

  it("preserves apply_patch backslashes when deriving path facts", async () => {
    const patch = [
      "*** Begin Patch",
      String.raw`*** Add File: safe\evil.ts`,
      "+x",
      "*** End Patch",
    ].join("\n");
    await expect(deriveToolParams("apply_patch", { input: patch })).resolves.toEqual({
      derivedPaths: [path.resolve(defaultCwd, String.raw`safe\evil.ts`)],
    });
  });

  it("preserves apply_patch marker payload bytes after the executor header trim", async () => {
    const patch = ["*** Begin Patch", "*** Add File:  src/new.ts", "+x", "*** End Patch"].join(
      "\n",
    );
    await expect(deriveToolParams("apply_patch", { input: patch })).resolves.toEqual({
      derivedPaths: [path.resolve(defaultCwd, " src/new.ts")],
    });
  });

  it("resolves sandboxed apply_patch paths through the execution bridge", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: /workspace/src/new.ts",
      "+x",
      "*** End Patch",
    ].join("\n");
    await expect(
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
    ).resolves.toEqual({
      derivedPaths: ["/host/sandbox/src/new.ts"],
    });
  });

  it("returns an empty object when apply_patch input has no recognised paths", async () => {
    await expect(deriveToolParams("apply_patch", { input: "not a patch" })).resolves.toEqual({});
    await expect(deriveToolParams("apply_patch", {})).resolves.toEqual({});
    await expect(deriveToolParams("apply_patch", undefined)).resolves.toEqual({});
  });

  it("does not throw for malformed param shapes", async () => {
    await expect(deriveToolParams("apply_patch", null)).resolves.toEqual({});
    await expect(deriveToolParams("apply_patch", 42)).resolves.toEqual({});
  });
});
