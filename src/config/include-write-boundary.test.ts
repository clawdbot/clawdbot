import { describe, expect, it } from "vitest";
import {
  collectChangedConfigPaths,
  resolveIncludeWriteBoundary,
} from "./include-write-boundary.js";

const alphaInclude = {
  path: ["agents", "entries", "alpha"],
  kind: "single" as const,
  hasSiblingOverrides: false,
  targetPath: "/cfg/alpha.json5",
};

describe("collectChangedConfigPaths", () => {
  it("reports keyed leaf paths", () => {
    expect(collectChangedConfigPaths({ a: { b: 1, c: 2 } }, { a: { b: 9, c: 2 } })).toEqual({
      paths: [["a", "b"]],
      rootChanged: false,
    });
  });

  it("reports added and removed keys", () => {
    expect(collectChangedConfigPaths({ a: { b: 1 } }, { a: {} })).toEqual({
      paths: [["a", "b"]],
      rootChanged: false,
    });
  });

  it("reports no change for equal values", () => {
    expect(collectChangedConfigPaths({ a: 1 }, { a: 1 })).toEqual({
      paths: [],
      rootChanged: false,
    });
  });

  it("marks non-record replacements as a root change", () => {
    expect(collectChangedConfigPaths({ a: 1 }, null)).toEqual({ paths: [], rootChanged: true });
  });

  it("compares arrays whole instead of per index", () => {
    expect(collectChangedConfigPaths({ a: [1, 2] }, { a: [1, 3] })).toEqual({
      paths: [["a"]],
      rootChanged: false,
    });
  });
});

describe("resolveIncludeWriteBoundary", () => {
  it("resolves a nested include that owns every change", () => {
    expect(
      resolveIncludeWriteBoundary({
        provenance: [alphaInclude],
        changed: { paths: [["agents", "entries", "alpha", "model"]], rootChanged: false },
      }),
    ).toEqual({ boundaryPath: alphaInclude.path, includePath: "/cfg/alpha.json5" });
  });

  it("prefers the deepest owning include over its sole-owner parent", () => {
    const outer = {
      path: ["agents"],
      kind: "single" as const,
      hasSiblingOverrides: false,
      hasArrayAncestor: false,
      targetPath: "/cfg/agents.json5",
    };
    expect(
      resolveIncludeWriteBoundary({
        provenance: [alphaInclude, outer],
        changed: { paths: [["agents", "entries", "alpha", "model"]], rootChanged: false },
      })?.includePath,
    ).toBe("/cfg/alpha.json5");
  });

  it("declines the parent include when changes span nested siblings", () => {
    // The parent file authors alpha's $include directive, so the guarded writer
    // cannot persist it; selecting it would defer the failure to the root
    // flatten guard.
    const outer = {
      path: ["agents"],
      kind: "single" as const,
      hasSiblingOverrides: false,
      hasArrayAncestor: false,
      targetPath: "/cfg/agents.json5",
    };
    expect(
      resolveIncludeWriteBoundary({
        provenance: [alphaInclude, outer],
        changed: {
          paths: [
            ["agents", "entries", "alpha", "model"],
            ["agents", "entries", "beta", "model"],
          ],
          rootChanged: false,
        },
      }),
    ).toBeNull();
  });

  it("declines a parent whose changed children are both nested includes", () => {
    const outer = {
      path: ["agents"],
      kind: "single" as const,
      hasSiblingOverrides: false,
      hasArrayAncestor: false,
      targetPath: "/cfg/agents.json5",
    };
    const betaInclude = {
      path: ["agents", "entries", "beta"],
      kind: "single" as const,
      hasSiblingOverrides: false,
      hasArrayAncestor: false,
      targetPath: "/cfg/beta.json5",
    };
    expect(
      resolveIncludeWriteBoundary({
        provenance: [alphaInclude, betaInclude, outer],
        changed: {
          paths: [
            ["agents", "entries", "alpha", "model"],
            ["agents", "entries", "beta", "model"],
          ],
          rootChanged: false,
        },
      }),
    ).toBeNull();
  });

  it("declines a directive-carrying parent when only a plain sibling changes", () => {
    const outer = {
      path: ["agents"],
      kind: "single" as const,
      hasSiblingOverrides: false,
      hasArrayAncestor: false,
      targetPath: "/cfg/agents.json5",
    };
    expect(
      resolveIncludeWriteBoundary({
        provenance: [alphaInclude, outer],
        changed: {
          paths: [["agents", "entries", "beta", "model"]],
          rootChanged: false,
        },
      }),
    ).toBeNull();
  });

  it("declines a nested include enclosed by a merged parent", () => {
    expect(
      resolveIncludeWriteBoundary({
        provenance: [
          alphaInclude,
          {
            path: ["agents"],
            kind: "multiple" as const,
            hasSiblingOverrides: false,
            hasArrayAncestor: false,
          },
        ],
        changed: { paths: [["agents", "entries", "alpha", "model"]], rootChanged: false },
      }),
    ).toBeNull();
  });

  it("declines a nested include merged at the same logical path", () => {
    expect(
      resolveIncludeWriteBoundary({
        provenance: [
          alphaInclude,
          {
            path: alphaInclude.path,
            kind: "multiple" as const,
            hasSiblingOverrides: false,
            hasArrayAncestor: false,
          },
        ],
        changed: { paths: [[...alphaInclude.path, "model"]], rootChanged: false },
      }),
    ).toBeNull();
  });

  it("keeps the innermost authored file in a same-path delegation chain", () => {
    // Depth-first include processing records the innermost file before its
    // delegating parent; the outer file still contains a $include directive.
    const outerDelegate = {
      path: alphaInclude.path,
      kind: "single" as const,
      hasSiblingOverrides: false,
      hasArrayAncestor: false,
      targetPath: "/cfg/alpha-delegate.json5",
    };
    expect(
      resolveIncludeWriteBoundary({
        provenance: [alphaInclude, outerDelegate],
        changed: { paths: [[...alphaInclude.path, "model"]], rootChanged: false },
      })?.includePath,
    ).toBe("/cfg/alpha.json5");
  });

  it("declines when a change falls outside the include", () => {
    expect(
      resolveIncludeWriteBoundary({
        provenance: [alphaInclude],
        changed: {
          paths: [
            ["agents", "entries", "alpha", "model"],
            ["agents", "entries", "beta", "model"],
          ],
          rootChanged: false,
        },
      }),
    ).toBeNull();
  });

  it("declines an include merged from several files", () => {
    expect(
      resolveIncludeWriteBoundary({
        provenance: [{ ...alphaInclude, kind: "multiple", targetPath: undefined }],
        changed: { paths: [["agents", "entries", "alpha", "model"]], rootChanged: false },
      }),
    ).toBeNull();
  });

  it("declines an include with sibling overrides", () => {
    expect(
      resolveIncludeWriteBoundary({
        provenance: [{ ...alphaInclude, hasSiblingOverrides: true }],
        changed: { paths: [["agents", "entries", "alpha", "model"]], rootChanged: false },
      }),
    ).toBeNull();
  });

  it("declines an include owned by an outer merged directive", () => {
    expect(
      resolveIncludeWriteBoundary({
        provenance: [
          alphaInclude,
          {
            path: [],
            kind: "multiple" as const,
            hasSiblingOverrides: false,
            hasArrayAncestor: false,
          },
        ],
        changed: { paths: [["agents", "entries", "alpha", "model"]], rootChanged: false },
      }),
    ).toBeNull();
  });

  it("declines every nested boundary beneath a sole-owner root include", () => {
    expect(
      resolveIncludeWriteBoundary({
        provenance: [
          alphaInclude,
          {
            path: [],
            kind: "single" as const,
            hasSiblingOverrides: false,
            hasArrayAncestor: false,
            targetPath: "/cfg/base.json5",
          },
        ],
        changed: { paths: [["agents", "entries", "alpha", "model"]], rootChanged: false },
      }),
    ).toBeNull();
  });

  it("declines an array-entry include", () => {
    expect(
      resolveIncludeWriteBoundary({
        provenance: [{ ...alphaInclude, path: ["agents", "list", "0"], hasArrayAncestor: true }],
        changed: { paths: [["agents", "list", "0", "model"]], rootChanged: false },
      }),
    ).toBeNull();
  });

  it("accepts a numeric object-key include", () => {
    const numericMapInclude = {
      ...alphaInclude,
      path: ["channels", "discord", "guilds", "123456789"],
      hasArrayAncestor: false,
      targetPath: "/cfg/guild.json5",
    };
    expect(
      resolveIncludeWriteBoundary({
        provenance: [numericMapInclude],
        changed: {
          paths: [["channels", "discord", "guilds", "123456789", "requireMention"]],
          rootChanged: false,
        },
      }),
    ).toEqual({
      boundaryPath: numericMapInclude.path,
      includePath: "/cfg/guild.json5",
    });
  });

  it("declines a root change and an empty change set", () => {
    expect(
      resolveIncludeWriteBoundary({
        provenance: [alphaInclude],
        changed: { paths: [], rootChanged: true },
      }),
    ).toBeNull();
    expect(
      resolveIncludeWriteBoundary({
        provenance: [alphaInclude],
        changed: { paths: [], rootChanged: false },
      }),
    ).toBeNull();
  });

  it("declines when provenance is unavailable", () => {
    expect(
      resolveIncludeWriteBoundary({
        provenance: undefined,
        changed: { paths: [["agents", "entries", "alpha", "model"]], rootChanged: false },
      }),
    ).toBeNull();
  });
});
