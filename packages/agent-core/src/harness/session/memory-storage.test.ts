import { describe, expect, it } from "vitest";
import type { SessionTreeEntry } from "../types.js";
import { InMemorySessionStorage } from "./memory-storage.js";

const rootEntry: SessionTreeEntry = {
  type: "custom",
  id: "root",
  parentId: null,
  timestamp: "2026-01-01T00:00:00.000Z",
  customType: "root",
};

const childEntry: SessionTreeEntry = {
  type: "custom",
  id: "child",
  parentId: "root",
  timestamp: "2026-01-01T00:00:01.000Z",
  customType: "child",
};

describe("InMemorySessionStorage", () => {
  it("uses shared entry indexes for labels, leaves, and paths", async () => {
    const storage = new InMemorySessionStorage({
      entries: [
        rootEntry,
        childEntry,
        {
          type: "label",
          id: "label-1",
          parentId: "child",
          timestamp: "2026-01-01T00:00:02.000Z",
          targetId: "child",
          label: " latest ",
        },
      ],
    });

    expect(await storage.getLeafId()).toBe("label-1");
    expect(await storage.getLabel("child")).toBe("latest");
    expect((await storage.getPathToRoot("child")).map((entry) => entry.id)).toEqual([
      "root",
      "child",
    ]);
  });

  it("records explicit leaf updates through the shared storage path", async () => {
    const storage = new InMemorySessionStorage({
      entries: [rootEntry, childEntry],
    });

    await storage.setLeafId("root");

    const entries = await storage.getEntries();
    const leaf = entries.at(-1);
    expect(await storage.getLeafId()).toBe("root");
    expect(leaf).toMatchObject({
      type: "leaf",
      parentId: "child",
      targetId: "root",
    });
  });
});
