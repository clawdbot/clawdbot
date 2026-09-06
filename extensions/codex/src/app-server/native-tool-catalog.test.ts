import { describe, expect, it } from "vitest";
import { parseCodexNativeToolCatalog } from "./native-tool-catalog.js";
import { codexDynamicToolsFingerprint } from "./thread-fingerprints.js";

const threadId = "native-thread";
const tool = {
  type: "function" as const,
  name: "example",
  description: "Synthetic tool",
  inputSchema: { type: "object" },
};

describe("parseCodexNativeToolCatalog", () => {
  it.each([{}, { dynamic_tools: null }, { dynamic_tools: [] }])(
    "restores the native empty representation %j without accepting a missing nonempty catalog",
    (catalog) => {
      const metadata = { id: threadId, ...catalog };
      expect(
        parseCodexNativeToolCatalog(metadata, threadId, codexDynamicToolsFingerprint([])),
      ).toEqual([]);
      expect(() =>
        parseCodexNativeToolCatalog(metadata, threadId, codexDynamicToolsFingerprint([tool])),
      ).toThrow("native tool catalog is missing, corrupt, or changed");
    },
  );

  it.each([
    null,
    {},
    { id: "other" },
    ...[false, 0, "", {}, [null]].map((dynamic_tools) => ({ id: threadId, dynamic_tools })),
  ])("rejects invalid metadata %j", (metadata) => {
    expect(() => parseCodexNativeToolCatalog(metadata, threadId)).toThrow(
      "native tool catalog is missing, corrupt, or changed",
    );
  });

  it("retains nonempty declarations and the pinned false-defer omission", () => {
    expect(
      parseCodexNativeToolCatalog(
        { id: threadId, dynamic_tools: [{ ...tool, deferLoading: false }] },
        threadId,
        codexDynamicToolsFingerprint([tool]),
      ),
    ).toEqual([tool]);
  });
});
