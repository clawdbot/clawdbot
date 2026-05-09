import { describe, expect, it } from "vitest";
import { parseNodeList, parsePairingList } from "./node-list-parse.js";

describe("shared/node-list-parse", () => {
  it("parses node.list payloads", () => {
    expect(parseNodeList({ nodes: [{ nodeId: "node-1" }] })).toEqual([{ nodeId: "node-1" }]);
    expect(parseNodeList({ nodes: "nope" })).toStrictEqual([]);
    expect(parseNodeList(null)).toStrictEqual([]);
    expect(parseNodeList(["not-an-object"])).toStrictEqual([]);
  });

  it("parses node.pair.list payloads", () => {
    expect(
      parsePairingList({
        pending: [
          {
            requestId: "r1",
            nodeId: "n1",
            ts: 1,
            requiredApproveScopes: ["operator.pairing"],
          },
        ],
        paired: [{ nodeId: "n1" }],
      }),
    ).toEqual({
      pending: [
        {
          requestId: "r1",
          nodeId: "n1",
          ts: 1,
          requiredApproveScopes: ["operator.pairing"],
        },
      ],
      paired: [{ nodeId: "n1" }],
    });
    expect(parsePairingList({ pending: 1, paired: "x" })).toEqual({ pending: [], paired: [] });
    expect(parsePairingList(undefined)).toEqual({ pending: [], paired: [] });
    expect(parsePairingList(["not-an-object"])).toEqual({ pending: [], paired: [] });
  });

  it("preserves valid pairing arrays when the sibling field is malformed", () => {
    expect(
      parsePairingList({
        pending: [{ requestId: "r1", nodeId: "n1", ts: 1 }],
        paired: "x",
      }),
    ).toEqual({
      pending: [{ requestId: "r1", nodeId: "n1", ts: 1 }],
      paired: [],
    });

    expect(
      parsePairingList({
        pending: 1,
        paired: [{ nodeId: "n1" }],
      }),
    ).toEqual({
      pending: [],
      paired: [{ nodeId: "n1" }],
    });
  });
});
