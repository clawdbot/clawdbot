// Program nodes test-helper tests cover node command fixture helpers.
import { describe, expect, it } from "vitest";
import { IOS_NODE, createIosNodeListResponse } from "./program.nodes-test-helpers.js";

describe("program.nodes-test-helpers", () => {
  it("builds a node.list response with iOS node fixture", () => {
    const response = createIosNodeListResponse(1234);
    expect(response).toEqual({
      ts: 1234,
      nodes: [IOS_NODE],
    });
  });
});
