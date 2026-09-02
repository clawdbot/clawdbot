import { EventEmitter } from "node:events";
import fs from "node:fs";
import promises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDirtyDirectoryWatch,
  type DirtyDirectoryWatch,
} from "./session-catalog-tree-watch.js";

const armed = (watch: DirtyDirectoryWatch) =>
  vi.waitFor(() => expect(watch.takeDirty()).toBeInstanceOf(Set), { timeout: 2_000, interval: 25 });

describe("Claude project directory watch", () => {
  let root: string;
  let watch: DirtyDirectoryWatch | undefined;

  beforeEach(async () => {
    root = await promises.realpath(await promises.mkdtemp(path.join(os.tmpdir(), "claude-watch-")));
  });

  afterEach(async () => {
    watch?.close();
    watch = undefined;
    vi.restoreAllMocks();
    await promises.rm(root, { recursive: true, force: true });
  });

  it("reports dirty children for transcript writes and new project directories", async () => {
    await promises.mkdir(path.join(root, "existing"));
    watch = createDirtyDirectoryWatch(root);
    watch.observeChildDirectories(["existing"]);
    await armed(watch);
    const transcript = path.join(root, "existing", "session.jsonl");
    await promises.writeFile(transcript, "{}\n");
    await vi.waitFor(() => expect(watch?.takeDirty()).toEqual(new Set(["existing"])), {
      timeout: 2_000,
      interval: 25,
    });
    await promises.appendFile(transcript, "{}\n");
    await vi.waitFor(() => expect(watch?.takeDirty()).toEqual(new Set(["existing"])), {
      timeout: 2_000,
      interval: 25,
    });
    await promises.mkdir(path.join(root, "new"));
    await vi.waitFor(() => expect(watch?.takeDirty()).toContain("new"), {
      timeout: 2_000,
      interval: 25,
    });
  });

  it("keeps Linux child coverage after file renames and skipped missing directories", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    class Watcher extends EventEmitter {
      close = vi.fn();
      ref() {
        return this;
      }
      unref() {
        return this;
      }
    }
    const watched = new Map<string, Watcher>();
    vi.spyOn(fs, "watch").mockImplementation(
      (
        target: fs.PathLike,
        options: fs.WatchOptions | fs.WatchListener<string>,
        listener?: fs.WatchListener<string>,
      ) => {
        if (target === path.join(root, "missing")) {
          throw Object.assign(new Error("directory removed"), { code: "ENOENT" });
        }
        const handle = new Watcher();
        const callback = listener ?? (typeof options === "function" ? options : undefined);
        if (callback) {
          handle.on("change", callback);
        }
        watched.set(String(target), handle);
        return handle;
      },
    );
    watch = createDirtyDirectoryWatch(root);
    watch.observeChildDirectories(["missing", "existing"]);
    // Unarmed takes request a full read; arm by elapsing the settle window on the monotonic clock.
    expect(watch.takeDirty()).toBe("all");
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 10_000);
    expect(watch.takeDirty()).toBe("all");
    expect(watch.takeDirty()).toEqual(new Set());
    const child = watched.get(path.join(root, "existing"));
    child?.emit("change", "rename", "session.jsonl");
    expect(watch.takeDirty()).toEqual(new Set(["existing"]));
    expect(child?.close).not.toHaveBeenCalled();
    child?.emit("change", "change", "session.jsonl");
    expect(watch.takeDirty()).toEqual(new Set(["existing"]));
    watched.get(root)?.emit("change", "rename", "existing");
    expect(child?.close).toHaveBeenCalledOnce();
    watch.observeChildDirectories(["existing"]);
    expect(watched.get(path.join(root, "existing"))).not.toBe(child);
  });

  it("requests a full read instead of throwing when watcher creation fails", () => {
    const attach = vi.spyOn(fs, "watch").mockImplementation(() => {
      throw new Error("watch capacity exhausted");
    });
    watch = createDirtyDirectoryWatch(root);
    expect(watch.takeDirty()).toBe("all");
    expect(watch.takeDirty()).toBe("all");
    expect(attach).toHaveBeenCalledTimes(1);
  });

  it("closes idempotently without reattaching on later takes", () => {
    const attach = vi.spyOn(fs, "watch");
    watch = createDirtyDirectoryWatch(root);
    watch.close();
    watch.close();
    expect(watch.takeDirty()).toBe("all");
    expect(attach).toHaveBeenCalledTimes(1);
  });
});
