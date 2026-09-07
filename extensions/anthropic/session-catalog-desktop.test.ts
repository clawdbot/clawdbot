import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readDesktopOverlay } from "./session-catalog-desktop.js";
import type { DirtyDirectoryWatch } from "./session-catalog-tree-watch.js";

const createWatch = vi.hoisted(() => vi.fn());

vi.mock("./session-catalog-tree-watch.js", () => ({
  createDirtyDirectoryWatch: createWatch,
}));

async function writeDesktopMetadata(home: string, title: string): Promise<void> {
  const directory = path.join(
    home,
    "Library",
    "Application Support",
    "Claude",
    "claude-code-sessions",
    "account",
    "workspace",
  );
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "local_fixture.json"),
    JSON.stringify({ cliSessionId: "fixture-session", title }),
  );
}

describe("Claude Desktop overlay cache", () => {
  let home: string;
  let now: number;
  let dirty: "all" | Set<string>;
  let watch: DirtyDirectoryWatch;
  let closeWatch = vi.fn();

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-desktop-overlay-"));
    now = Date.UTC(2026, 0, 1);
    dirty = new Set();
    closeWatch = vi.fn();
    watch = {
      takeDirty: () => dirty,
      observeChildDirectories: vi.fn(),
      close: closeWatch,
    };
    createWatch.mockReset().mockReturnValue(watch);
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });

  afterEach(async () => {
    watch.close();
    vi.restoreAllMocks();
    await fs.rm(home, { recursive: true, force: true });
  });

  it("retains clean coverage but refreshes metadata when watch coverage becomes unknown", async () => {
    await writeDesktopMetadata(home, "Before");
    const first = await readDesktopOverlay(home);
    expect(first.active.get("fixture-session")?.title).toBe("Before");

    await writeDesktopMetadata(home, "After");
    expect(await readDesktopOverlay(home)).toBe(first);
    expect(first.active.get("fixture-session")?.title).toBe("Before");

    dirty = "all";
    const refreshed = await readDesktopOverlay(home);
    expect(refreshed.active.get("fixture-session")?.title).toBe("After");
  });

  it("keeps an absent Desktop store cached until the sixty-second backstop", async () => {
    const absent = await readDesktopOverlay(home);
    expect(absent.available).toBe(false);
    expect(closeWatch).toHaveBeenCalledOnce();

    await writeDesktopMetadata(home, "Created");
    now += 59_999;
    expect(await readDesktopOverlay(home)).toBe(absent);

    now += 1;
    const refreshed = await readDesktopOverlay(home);
    expect(refreshed.available).toBe(true);
    expect(refreshed.active.get("fixture-session")?.title).toBe("Created");
  });
});
