import { describe, expect, it } from "vitest";
import {
  isSessionTranscriptLeafControl,
  mergeSessionTranscriptVisiblePathWithOpaqueAppendPath,
  parseSessionTranscriptTreeEntry,
  scanSessionTranscriptTree,
  selectSessionTranscriptLeafControlledPath,
  selectSessionTranscriptTreePathNodes,
} from "./transcript-tree.js";

describe("session transcript tree helpers", () => {
  it("recognizes only valid leaf controls", () => {
    expect(
      isSessionTranscriptLeafControl({
        type: "leaf",
        id: "leaf-control",
        parentId: "old-tail",
        targetId: null,
      }),
    ).toBe(true);
    expect(
      isSessionTranscriptLeafControl({
        type: "leaf",
        id: "leaf-control",
        parentId: "old-tail",
      }),
    ).toBe(false);
  });

  it("treats leaf controls as navigation to their target", () => {
    const leaf = {
      type: "leaf",
      id: "leaf-control",
      parentId: "inactive-tail",
      targetId: "active-tail",
    };

    expect(parseSessionTranscriptTreeEntry(leaf)).toEqual({
      id: "leaf-control",
      parentId: "active-tail",
      leafId: "active-tail",
      appendParentId: "active-tail",
    });
  });

  it("resolves a distinct opaque append parent from a leaf control", () => {
    const entries = [
      { type: "message", id: "active-tail", parentId: null },
      { type: "metadata", id: "plugin-metadata", parentId: "active-tail" },
      {
        type: "leaf",
        id: "leaf-control",
        parentId: "inactive-tail",
        targetId: "active-tail",
        appendParentId: "plugin-metadata",
      },
    ];

    expect(scanSessionTranscriptTree(entries)).toMatchObject({
      leafId: "active-tail",
      appendParentId: "plugin-metadata",
    });
    expect(selectSessionTranscriptLeafControlledPath(entries)).toEqual(entries.slice(0, 1));
  });

  it("does not let later opaque rows replace the visible leaf", () => {
    const activeRoot = { type: "message", id: "active-root", parentId: null };
    const sideEntry = { type: "message", id: "side-entry", parentId: "active-root" };
    const leafControl = {
      type: "leaf",
      id: "leaf-control",
      parentId: "side-entry",
      targetId: "active-root",
    };
    const metadata = { type: "metadata", id: "plugin-metadata", parentId: "side-entry" };
    const entries = [activeRoot, sideEntry, leafControl, metadata];

    expect(scanSessionTranscriptTree(entries)).toMatchObject({
      leafId: "active-root",
      appendParentId: "plugin-metadata",
    });
    expect(selectSessionTranscriptLeafControlledPath(entries)).toEqual([activeRoot]);
  });

  it("resolves the last valid leaf update in file order", () => {
    expect(
      scanSessionTranscriptTree([
        { type: "message", id: "active-tail", parentId: null },
        { type: "message", id: "inactive-tail", parentId: "active-tail" },
        {
          type: "leaf",
          id: "leaf-control",
          parentId: "inactive-tail",
          targetId: "active-tail",
        },
      ]).leafId,
    ).toBe("active-tail");
  });

  it("supports explicit navigation to an empty branch", () => {
    const entries = [
      { type: "message", id: "old-tail", parentId: null },
      {
        type: "leaf",
        id: "leaf-control",
        parentId: "old-tail",
        targetId: null,
        appendParentId: "old-tail",
      },
    ];

    expect(scanSessionTranscriptTree(entries)).toMatchObject({
      leafId: null,
      appendParentId: "old-tail",
    });
    expect(selectSessionTranscriptLeafControlledPath(entries)).toEqual([]);
  });

  it("retains a reset kept tail before a disjoint selected branch", () => {
    const keptUser = { type: "message", id: "kept-user", parentId: null };
    const keptAssistant = {
      type: "message",
      id: "kept-assistant",
      parentId: keptUser.id,
    };
    const reset = {
      type: "reset",
      id: "reset-boundary",
      parentId: keptAssistant.id,
      firstKeptEntryId: keptUser.id,
    };
    const branchUser = { type: "message", id: "branch-user", parentId: null };
    const leafControl = {
      type: "leaf",
      id: "branch-leaf",
      parentId: reset.id,
      targetId: branchUser.id,
    };

    expect(
      selectSessionTranscriptLeafControlledPath([
        keptUser,
        keptAssistant,
        reset,
        branchUser,
        leafControl,
      ]),
    ).toEqual([keptUser, keptAssistant, reset, { ...branchUser, parentId: reset.id }]);
  });

  it("keeps visible history when the next append starts at the root", () => {
    const activeRoot = { type: "message", id: "active-root", parentId: null };
    const leafControl = {
      type: "leaf",
      id: "leaf-control",
      parentId: "inactive-tail",
      targetId: "active-root",
      appendParentId: null,
    };

    expect(selectSessionTranscriptLeafControlledPath([activeRoot, leafControl])).toEqual([
      activeRoot,
    ]);
  });

  it("selects the active path after side rows and later active appends", () => {
    const activeRoot = { type: "message", id: "active-root", parentId: null };
    const sideEntry = { type: "message", id: "side-entry", parentId: "active-root" };
    const leafControl = {
      type: "leaf",
      id: "leaf-control",
      parentId: "side-entry",
      targetId: "active-root",
    };
    const activeTail = { type: "message", id: "active-tail", parentId: "active-root" };
    const unlinkedMetadata = { type: "metadata", id: "unlinked-metadata" };

    expect(
      selectSessionTranscriptLeafControlledPath([
        activeRoot,
        sideEntry,
        leafControl,
        activeTail,
        unlinkedMetadata,
      ]),
    ).toEqual([activeRoot, activeTail]);
  });

  it("normalizes continuations parented to an omitted leaf marker", () => {
    const activeRoot = { type: "message", id: "active-root", parentId: null };
    const sideEntry = { type: "message", id: "side-entry", parentId: "active-root" };
    const leafControl = {
      type: "leaf",
      id: "active-leaf",
      parentId: "side-entry",
      targetId: "active-root",
    };
    const activeTail = { type: "message", id: "active-tail", parentId: "active-leaf" };
    const entries = [activeRoot, sideEntry, leafControl, activeTail];

    const tree = scanSessionTranscriptTree(entries);

    expect(tree.byId.get("active-tail")?.parentId).toBe("active-root");
    expect(selectSessionTranscriptLeafControlledPath(entries)).toEqual([
      activeRoot,
      { ...activeTail, parentId: "active-root" },
    ]);
  });

  it("normalizes parentless continuations after chained leaf markers", () => {
    const activeRoot = { type: "message", id: "active-root", parentId: null };
    const firstLeaf = {
      type: "leaf",
      id: "first-leaf",
      parentId: "active-root",
      targetId: "active-root",
    };
    const secondLeaf = {
      type: "leaf",
      id: "second-leaf",
      parentId: "first-leaf",
      targetId: "first-leaf",
    };
    const activeTail = { type: "message", id: "active-tail" };
    const entries = [activeRoot, firstLeaf, secondLeaf, activeTail];

    const tree = scanSessionTranscriptTree(entries);

    expect(tree.byId.get("active-tail")?.parentId).toBe("active-root");
    expect(selectSessionTranscriptLeafControlledPath(entries)).toEqual([
      activeRoot,
      { ...activeTail, parentId: "active-root" },
    ]);
  });

  it("keeps the reachable active suffix when an older parent is missing", () => {
    const activeTail = { type: "message", id: "active-tail", parentId: "missing-parent" };
    const leafControl = {
      type: "leaf",
      id: "leaf-control",
      parentId: "inactive-tail",
      targetId: "active-tail",
    };

    expect(selectSessionTranscriptLeafControlledPath([activeTail, leafControl])).toEqual([
      activeTail,
    ]);
  });

  it("normalizes parentless canonical rows before applying a leaf control", () => {
    const entries = [
      { type: "message", id: "root", message: { role: "user", content: "root" } },
      {
        type: "message",
        id: "active",
        message: { role: "assistant", content: "active" },
      },
      {
        type: "leaf",
        id: "active-leaf",
        parentId: "side",
        targetId: "active",
      },
    ];

    const tree = scanSessionTranscriptTree(entries);

    expect(tree.byId.get("root")?.parentId).toBeNull();
    expect(tree.byId.get("active")?.parentId).toBe("root");
    expect(selectSessionTranscriptLeafControlledPath(entries)).toEqual([
      { ...entries[0], parentId: null },
      { ...entries[1], parentId: "root" },
    ]);
  });

  it("selects visible and disjoint append paths independently", () => {
    const entries = [
      { type: "custom", id: "visible", parentId: null },
      { type: "metadata", id: "append-root", parentId: null },
      {
        type: "leaf",
        id: "active-leaf",
        parentId: "append-root",
        targetId: "visible",
        appendParentId: "append-root",
      },
    ];

    const tree = scanSessionTranscriptTree(entries);

    expect(selectSessionTranscriptTreePathNodes(tree, tree.leafId).map((node) => node.id)).toEqual([
      "visible",
    ]);
    expect(
      selectSessionTranscriptTreePathNodes(tree, tree.appendParentId).map((node) => node.id),
    ).toEqual(["append-root"]);
  });

  it("keeps the selected history when a canonical row uses a disjoint raw cursor", () => {
    const entries = [
      { type: "custom", id: "visible", parentId: null },
      { type: "custom", id: "inactive", parentId: null },
      { type: "metadata", id: "append-root", parentId: "inactive" },
      {
        type: "leaf",
        id: "active-leaf",
        parentId: "inactive",
        targetId: "visible",
        appendParentId: "append-root",
        appendMode: "side",
      },
      { type: "custom", id: "continued", parentId: "append-root" },
    ];

    const tree = scanSessionTranscriptTree(entries);

    expect(tree.byId.get("continued")?.parentId).toBe("visible");
    expect(selectSessionTranscriptLeafControlledPath(entries)).toEqual([
      entries[0],
      { ...entries[4], parentId: "visible" },
    ]);
  });

  it("normalizes canonical rows with stale parents onto the active leaf", () => {
    const entries = [
      { type: "message", id: "user", parentId: null },
      { type: "message", id: "assistant", parentId: "user" },
      {
        type: "custom",
        id: "bootstrap-context",
        parentId: "missing-stale-parent",
        customType: "openclaw:bootstrap-context:full",
      },
    ];

    const tree = scanSessionTranscriptTree(entries);

    expect(tree.byId.get("bootstrap-context")?.parentId).toBe("assistant");
    expect(selectSessionTranscriptTreePathNodes(tree, tree.leafId).map((node) => node.id)).toEqual([
      "user",
      "assistant",
      "bootstrap-context",
    ]);
  });

  it("preserves side ancestry after an explicit side append leaf", () => {
    const entries = [
      { type: "custom", id: "visible", parentId: null },
      { type: "custom", id: "side-one", parentId: "visible" },
      {
        type: "leaf",
        id: "first-leaf",
        parentId: "side-one",
        targetId: "visible",
        appendParentId: "side-one",
        appendMode: "side",
      },
      { type: "custom", id: "side-two", parentId: "side-one", appendMode: "side" },
    ];

    const tree = scanSessionTranscriptTree(entries);

    expect(tree.leafId).toBe("visible");
    expect(tree.appendParentId).toBe("side-two");
    expect(tree.byId.get("side-two")?.parentId).toBe("side-one");
    expect(selectSessionTranscriptLeafControlledPath(entries)).toEqual([entries[0]]);
  });

  it("copies only the opaque suffix of a disjoint append path", () => {
    const entries = [
      { type: "custom", id: "visible", parentId: null },
      { type: "custom", id: "inactive", parentId: null },
      { type: "metadata", id: "append-metadata", parentId: "inactive" },
      {
        type: "leaf",
        id: "active-leaf",
        parentId: "inactive",
        targetId: "visible",
        appendParentId: "append-metadata",
      },
    ];
    const tree = scanSessionTranscriptTree(entries);
    const merged = mergeSessionTranscriptVisiblePathWithOpaqueAppendPath({
      visiblePath: selectSessionTranscriptTreePathNodes(tree, tree.leafId),
      appendPath: selectSessionTranscriptTreePathNodes(tree, tree.appendParentId),
      appendParentId: tree.appendParentId,
    });

    expect(merged.nodes.map((node) => [node.id, node.selectedParentId])).toEqual([
      ["visible", null],
      ["append-metadata", "visible"],
    ]);
    expect(merged.appendParentId).toBe("append-metadata");
  });

  it("ignores leaf controls with dangling references", () => {
    const root = { type: "custom", id: "root", parentId: null };
    const missingTarget = {
      type: "leaf",
      id: "missing-target",
      parentId: "root",
      targetId: "missing",
    };
    const child = {
      type: "custom",
      id: "child",
      parentId: "missing-target",
    };
    const missingAppendParent = {
      type: "leaf",
      id: "missing-append",
      parentId: "child",
      targetId: "child",
      appendParentId: "missing",
    };

    const tree = scanSessionTranscriptTree([root, missingTarget, child, missingAppendParent]);

    expect(tree.leafId).toBe("child");
    expect(tree.appendParentId).toBe("child");
    expect(tree.hasLeafControl).toBe(false);
    expect(tree.byId.get("missing-target")?.parentId).toBe("root");
    expect(tree.byId.get("child")?.parentId).toBe("root");
    expect(selectSessionTranscriptTreePathNodes(tree, tree.leafId).map((node) => node.id)).toEqual([
      "root",
      "child",
    ]);
    expect(selectSessionTranscriptLeafControlledPath([root, missingTarget])).toBeUndefined();
  });
});
