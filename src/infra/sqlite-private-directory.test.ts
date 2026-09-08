import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withEnv } from "../test-utils/env.js";
import { resolvePrivateSqliteSnapshotStagingRoot } from "./sqlite-private-directory.js";
import * as tmpOpenClawDir from "./tmp-openclaw-dir.js";

describe("private SQLite snapshot staging root", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    {
      label: "an absolute LOCALAPPDATA root",
      xdgCacheHome: undefined,
      localAppData: path.resolve("sqlite-local-app-data"),
      expectedRoot: path.resolve("sqlite-local-app-data"),
    },
    {
      label: "LOCALAPPDATA when XDG_CACHE_HOME is relative",
      xdgCacheHome: "relative/cache",
      localAppData: path.resolve("sqlite-local-app-data"),
      expectedRoot: path.resolve("sqlite-local-app-data"),
    },
    {
      label: "HOME/AppData/Local when LOCALAPPDATA is absent",
      xdgCacheHome: undefined,
      localAppData: undefined,
      expectedRoot: path.join(path.resolve("sqlite-home"), "AppData", "Local"),
    },
    {
      label: "HOME/AppData/Local when LOCALAPPDATA is relative",
      xdgCacheHome: undefined,
      localAppData: "relative/local-app-data",
      expectedRoot: path.join(path.resolve("sqlite-home"), "AppData", "Local"),
    },
    {
      label: "absolute XDG_CACHE_HOME ahead of LOCALAPPDATA",
      xdgCacheHome: path.resolve("sqlite-xdg-cache"),
      localAppData: path.resolve("sqlite-local-app-data"),
      expectedRoot: path.resolve("sqlite-xdg-cache"),
    },
  ])(
    "selects $label for the Windows snapshot cache",
    ({ xdgCacheHome, localAppData, expectedRoot }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const resolveTempRoot = vi
        .spyOn(tmpOpenClawDir, "resolvePreferredOpenClawTmpDir")
        .mockImplementation((options) => options?.preferredDir ?? "");

      withEnv(
        {
          HOME: path.resolve("sqlite-home"),
          LOCALAPPDATA: localAppData,
          XDG_CACHE_HOME: xdgCacheHome,
        },
        () => {
          expect(resolvePrivateSqliteSnapshotStagingRoot()).toBe(
            path.join(expectedRoot, "openclaw"),
          );
        },
      );

      expect(resolveTempRoot.mock.calls[0]?.[0]?.tmpdir?.()).toBe(expectedRoot);
    },
  );
});
