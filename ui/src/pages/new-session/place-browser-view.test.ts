import { describe, expect, it } from "vitest";
import type {
  FsDirEntry,
  FsListDirResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { resolvePlaceBrowserView, splitBrowserDraft } from "./place-browser-view.ts";

describe("splitBrowserDraft", () => {
  it.each([
    ["/Users/p/Projects/ac", "/Users/p/Projects", "ac"],
    ["/Users/p/Projects/", "/Users/p/Projects", ""],
    ["/Users/p/Projects///", "/Users/p/Projects", ""],
    ["/Users/p/Projects", "/Users/p", "Projects"],
    ["/ac", "/", "ac"],
    ["/", "/", ""],
    ["///", "/", ""],
    ["C:\\Users\\p", "C:\\Users", "p"],
    ["C:\\Us", "C:\\", "Us"],
    ["C:\\Users\\p\\\\", "C:\\Users\\p", ""],
    ["C:\\", "C:\\", ""],
    ["C:/Us", "C:/", "Us"],
    ["C:/", "C:/", ""],
    ["\\", "\\", ""],
    ["\\\\server\\share\\pa", "\\\\server\\share", "pa"],
    ["\\\\server\\share\\", "\\\\server\\share", ""],
  ])("splits %j into directory %j and prefix %j", (draft, directory, prefix) => {
    expect(splitBrowserDraft(draft)).toEqual({ directory, prefix });
  });

  it.each(["", "packages", "./packages", "~/packages", "C:packages"])(
    "does not search a non-absolute draft %j",
    (draft) => {
      expect(splitBrowserDraft(draft)).toBeNull();
    },
  );
});

describe("filterBrowserEntries", () => {
  const entries = [
    { name: "App", path: "/workspace/App" },
    { name: "app-old", path: "/workspace/app-old" },
    { name: "app", path: "/workspace/app" },
    { name: "old-packages", path: "/workspace/old-packages" },
    { name: "Packages", path: "/workspace/Packages" },
    { name: "tools", path: "/workspace/tools" },
    { name: "package-tools", path: "/workspace/package-tools" },
    { name: "my-packages", path: "/workspace/my-packages" },
    { name: ".packages", path: "/workspace/.packages", hidden: true },
  ] satisfies FsDirEntry[];

  const filteredEntries = (prefix: string) =>
    resolvePlaceBrowserView({
      listing: { path: "/workspace", home: "/", entries },
      draft: `/workspace/${prefix}`,
      loading: false,
    }).entries;

  it.each([
    ["PA", ["Packages", "package-tools", "old-packages", "my-packages"]],
    ["APP", ["App", "app", "app-old"]],
    // The typed spelling wins over a case-insensitive twin on case-sensitive filesystems.
    ["app", ["app", "App", "app-old"]],
    ["App", ["App", "app", "app-old"]],
  ])("ranks spelled, exact, prefix, then substring matches for %s", (prefix, expectedNames) => {
    expect(filteredEntries(prefix).map((entry) => entry.name)).toEqual(expectedNames);
  });

  it("includes hidden folders only for a leading-dot search", () => {
    expect(filteredEntries(".pa").map((entry) => entry.name)).toEqual([".packages"]);
    expect(filteredEntries("ages").some((entry) => entry.hidden)).toBe(false);
  });

  it("preserves the full listing, including hidden folders, for an empty prefix", () => {
    expect(filteredEntries("")).toEqual(entries);
  });
});

describe("resolvePlaceBrowserView", () => {
  const entries = [{ name: "packages", path: "/workspace/packages" }];
  const listing = { path: "/workspace", home: "/home/user", entries } satisfies FsListDirResult;
  const emptyListing = { ...listing, entries: [] };

  it.each([
    ["empty draft", listing, "", false, entries, "none"],
    ["relative draft", listing, "pa", false, entries, "none"],
    ["draft equals listing path", listing, "/workspace", false, entries, "none"],
    ["matching prefix", listing, "/workspace/pa", false, entries, "none"],
    ["empty prefix", listing, "/workspace/", false, entries, "none"],
    ["unmatched prefix", listing, "/workspace/zzz", false, [], "no-matches"],
    ["loading prefix", listing, "/workspace/zzz", true, [], "none"],
    ["different directory", listing, "/other/pa", false, [], "no-matches"],
    ["loading directory", listing, "/other/pa", true, [], "none"],
    ["no listing", null, "", false, [], "none"],
    ["unloaded directory", null, "/workspace/pa", false, [], "no-matches"],
    ["empty listing and relative draft", emptyListing, "pa", false, [], "no-subfolders"],
    ["empty listed directory", emptyListing, "/workspace/", false, [], "no-subfolders"],
    ["loading empty listing", emptyListing, "", true, [], "none"],
  ])("resolves %s", (_name, currentListing, draft, loading, expectedEntries, empty) => {
    expect(resolvePlaceBrowserView({ listing: currentListing, draft, loading })).toEqual({
      entries: expectedEntries,
      empty,
    });
  });

  it("matches Windows directory spellings before filtering", () => {
    const windowsListing = { path: "C:\\Workspace\\", home: "C:\\", entries };
    expect(
      resolvePlaceBrowserView({
        listing: windowsListing,
        draft: "c:/workspace/pa",
        loading: false,
      }),
    ).toEqual({
      entries,
      empty: "none",
    });
  });
});
