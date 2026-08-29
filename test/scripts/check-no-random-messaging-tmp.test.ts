// Check No Random Messaging Tmp tests cover check no random messaging tmp script behavior.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findMessagingTmpdirCallLines,
  main,
  messagingTmpdirGuardSourceRoots,
} from "../../scripts/check-no-random-messaging-tmp.mts";
import * as repoRoot from "../../scripts/lib/repo-root.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

describe("check-no-random-messaging-tmp", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  afterEach(() => vi.restoreAllMocks());

  it("allows plugin test support while rejecting runtime tmpdir calls through the guard", async () => {
    const root = tempDirs.make("openclaw-messaging-tmp-guard-");
    vi.spyOn(repoRoot, "resolveRepoRoot").mockReturnValue(root);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitError = new Error("guard exit");
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw exitError;
    });
    const writeSource = (relativePath: string) => {
      const filePath = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, 'import os from "node:os";\nconst dir = os.tmpdir();\n');
    };

    writeSource("extensions/browser/src/browser/extension-install.test-support.ts");
    await main();
    expect(exit).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();

    const runtimePaths = [
      "src/channels/runtime.ts",
      "extensions/browser/runtime-api.ts",
      "extensions/browser/src/browser/runtime.ts",
    ];
    runtimePaths.forEach(writeSource);
    await expect(main()).rejects.toBe(exitError);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(errorLog).toHaveBeenCalledTimes(5);
    expect(errorLog).toHaveBeenNthCalledWith(
      1,
      "Found os.tmpdir()/tmpdir() usage in messaging/channel runtime sources:",
    );
    expect(
      errorLog.mock.calls
        .slice(1, -1)
        .map(([message]) => message)
        .toSorted(),
    ).toEqual(runtimePaths.map((relativePath) => `- ${relativePath}:2`).toSorted());
    expect(errorLog).toHaveBeenLastCalledWith(
      "Use resolvePreferredOpenClawTmpDir() or plugin-sdk temp helpers instead of host tmp defaults.",
    );
  });

  it("finds os.tmpdir calls imported from node:os", () => {
    const source = `
      import os from "node:os";
      const dir = os.tmpdir();
    `;
    expect(findMessagingTmpdirCallLines(source)).toEqual([3]);
  });

  it("finds tmpdir named import calls from node:os", () => {
    const source = `
      import { tmpdir } from "node:os";
      const dir = tmpdir();
    `;
    expect(findMessagingTmpdirCallLines(source)).toEqual([3]);
  });

  it("finds tmpdir calls imported from os", () => {
    const source = `
      import os from "os";
      const dir = os.tmpdir();
    `;
    expect(findMessagingTmpdirCallLines(source)).toEqual([3]);
  });

  it("ignores mentions in comments and strings", () => {
    const source = `
      // os.tmpdir()
      const text = "tmpdir()";
    `;
    expect(findMessagingTmpdirCallLines(source)).toStrictEqual([]);
  });

  it("ignores tmpdir symbols that are not imported from node:os", () => {
    const source = `
      const tmpdir = () => "/tmp";
      const dir = tmpdir();
    `;
    expect(findMessagingTmpdirCallLines(source)).toStrictEqual([]);
  });

  it("guards src/media against host tmpdir usage", () => {
    expect(messagingTmpdirGuardSourceRoots).toContain("src/media");
  });
});
