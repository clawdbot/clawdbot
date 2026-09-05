// ls tool tests cover deterministic directory listings and safe limit
// normalization for agent-visible file enumeration.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import type { DirectoryEntry } from "../../../infra/directory-entries.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { createLsTool, type LsOperations } from "./ls.js";
import { DEFAULT_MAX_BYTES } from "./truncate.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function operations(entries: string[]): LsOperations {
  return {
    readDirectory: () => entries.map((name) => ({ name, isDirectory: false })),
  };
}

function textContent(
  result: Awaited<ReturnType<ReturnType<typeof createLsTool>["execute"]>>,
): string {
  const first = result.content[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

function trackAbortListener(signal: AbortSignal) {
  const add = vi.spyOn(signal, "addEventListener");
  const remove = vi.spyOn(signal, "removeEventListener");
  return {
    expectReleased() {
      const listener = add.mock.calls.find(([type]) => type === "abort")?.[1];
      expect(listener).toBeDefined();
      expect(remove).toHaveBeenCalledWith("abort", listener);
    },
  };
}

describe("ls tool", () => {
  it.each([
    { name: "byte limit", modelBudget: undefined },
    { name: "model context", modelBudget: { maxChars: 1_800, maxContextChars: 2_500 } },
  ])("visits every filename through complete pages bounded by $name", async ({ modelBudget }) => {
    const names = Array.from(
      { length: 300 },
      (_, index) => `${String(index).padStart(3, "0")}-${"x".repeat(210)}`,
    );
    const tool = createLsTool("/workspace", { operations: operations(names), modelBudget });
    const seen: unknown[] = [];
    let after: string | undefined;
    let pageCount = 0;
    for (; pageCount < names.length; pageCount += 1) {
      const page = await tool.execute("list-page", { limit: 500, after });
      const output = textContent(page);
      const pageNames = output
        .split("\n")
        .filter((line) => line.startsWith('"'))
        .map((line) => JSON.parse(line));
      expect(pageNames.length).toBeGreaterThan(0);
      expect(Buffer.byteLength(output)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
      if (modelBudget) {
        expect(output.length).toBeLessThanOrEqual(modelBudget.maxChars);
        expect(output.length * 2).toBeLessThanOrEqual(modelBudget.maxContextChars);
      }
      seen.push(...pageNames);
      const nextAfter = page.details?.nextAfter;
      if (nextAfter === undefined) {
        break;
      }
      expect(nextAfter).toBe(pageNames.at(-1));
      expect(nextAfter).not.toBe(after);
      expect(output).toContain(`after=${JSON.stringify(nextAfter)}`);
      after = nextAfter;
    }
    expect(pageCount).toBeGreaterThan(0);
    expect(seen).toEqual(names);
  });

  it("quotes complete control-character and Unicode names in binary order", async () => {
    const tool = createLsTool("/workspace", {
      operations: operations([
        "line\nbreak",
        "á",
        "a",
        "Z",
        "A",
        "\tleading",
        '"quoted"',
        "emoji-🦀",
      ]),
    });

    const page = await tool.execute("list-unusual-names", {});

    expect(
      textContent(page)
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual(["\tleading", '"quoted"', "A", "Z", "a", "emoji-🦀", "line\nbreak", "á"]);
    expect(page.details?.nextAfter).toBeUndefined();
  });

  it("continues after a deleted directory using its raw name without skipping unseen entries", async () => {
    const cwd = tempDirs.make("openclaw-ls-delete-page-");
    await fs.mkdir(path.join(cwd, "alpha"));
    await Promise.all(["beta", "gamma"].map((name) => fs.writeFile(path.join(cwd, name), "")));
    const tool = createLsTool(cwd);
    const first = await tool.execute("first-page", { limit: 1 });
    expect(textContent(first).split("\n")[0]).toBe('"alpha/"');
    expect(first.details?.nextAfter).toBe("alpha");
    await fs.rmdir(path.join(cwd, "alpha"));

    const second = await tool.execute("second-page", { limit: 1, after: first.details?.nextAfter });
    expect(textContent(second).split("\n")[0]).toBe('"beta"');
    expect(second.details?.nextAfter).toBe("beta");
    const final = await tool.execute("final-page", { limit: 1, after: second.details?.nextAfter });
    expect(textContent(final)).toBe('"gamma"');
    expect(final.details?.nextAfter).toBeUndefined();
  });

  it("retains links without following targets and marks only actual directories", async () => {
    const cwd = tempDirs.make("openclaw-ls-links-");
    const tool = createLsTool(cwd);
    const symlinkType = process.platform === "win32" ? "junction" : "dir";
    const list = (limit?: number) => tool.execute("ls-links", limit ? { limit } : {});

    expect((await list()).content).toEqual([{ type: "text", text: "(empty directory)" }]);
    await fs.symlink(path.join(cwd, "missing-target"), path.join(cwd, "a-broken"), symlinkType);

    const dangling = await list();
    expect(dangling.content).toEqual([{ type: "text", text: '"a-broken"' }]);
    expect(dangling.details).toBeUndefined();

    await fs.mkdir(path.join(cwd, "target-dir"));
    await fs.symlink(path.join(cwd, "target-dir"), path.join(cwd, "link-to-dir"), symlinkType);
    await fs.writeFile(path.join(cwd, "z-file.txt"), "fixture\n");
    expect((await list()).content).toEqual([
      { type: "text", text: '"a-broken"\n"link-to-dir"\n"target-dir/"\n"z-file.txt"' },
    ]);

    const limited = await list(1);
    expect(textContent(limited).split("\n")[0]).toBe('"a-broken"');
    expect(limited.details).toEqual({ nextAfter: "a-broken" });
  });

  it("clamps non-positive limits instead of reporting a non-empty directory as empty", async () => {
    // Clamp to one entry so bad numeric input cannot hide directory contents.
    const tool = createLsTool("/workspace", {
      operations: operations(["beta.txt", "alpha.txt"]),
    });

    const result = await tool.execute("call-1", { limit: 0 });

    expect(textContent(result).split("\n")[0]).toBe('"alpha.txt"');
    expect(result.details?.nextAfter).toBe("alpha.txt");
  });

  it("uses the default limit for non-finite values", async () => {
    const tool = createLsTool("/workspace", {
      operations: operations(["beta.txt", "alpha.txt"]),
    });

    const result = await tool.execute("call-1", { limit: Number.NaN });

    expect(textContent(result)).toBe('"alpha.txt"\n"beta.txt"');
    expect(result.details).toBeUndefined();
  });

  it("preserves a directory read failure and releases the abort listener", async () => {
    const tool = createLsTool("/workspace", {
      operations: {
        readDirectory: () => {
          throw new Error("permission denied");
        },
      },
    });
    const controller = new AbortController();
    const listener = trackAbortListener(controller.signal);

    await expect(tool.execute("call-1", {}, controller.signal)).rejects.toThrow(
      "permission denied",
    );

    listener.expectReleased();
  });

  it("releases the abort listener after success", async () => {
    const tool = createLsTool("/workspace", { operations: operations(["alpha.txt"]) });
    const controller = new AbortController();
    const listener = trackAbortListener(controller.signal);

    await expect(tool.execute("call-1", {}, controller.signal)).resolves.toBeDefined();

    listener.expectReleased();
  });

  it("settles once and releases the listener when aborted during an operation", async () => {
    const listing = createDeferredCore<DirectoryEntry[]>();
    const reading = createDeferredCore<AbortSignal | undefined>();
    const tool = createLsTool("/workspace", {
      operations: {
        readDirectory: (_absolutePath, signal) => {
          reading.resolve(signal);
          return listing.promise;
        },
      },
    });
    const controller = new AbortController();
    const listener = trackAbortListener(controller.signal);
    const result = tool.execute("call-1", {}, controller.signal);
    await expect(reading.promise).resolves.toBe(controller.signal);

    controller.abort();

    await expect(result).rejects.toThrow("Operation aborted");
    listener.expectReleased();
    listing.resolve([]);
  });
});
