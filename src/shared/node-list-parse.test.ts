// Node list parsing tests cover normalized node inventory records.

import { expectDefined } from "@openclaw/normalization-core";
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

  it("drops pairing rows with a non-string or empty required id instead of emitting empty-id sentinels", () => {
    const { pending, paired } = parsePairingList({
      pending: [
        { requestId: 7, nodeId: {}, ts: 1 }, // non-string required ids -> dropped
        { requestId: "  ", nodeId: "n0", ts: 2 }, // whitespace-only requestId -> dropped
        { requestId: "r1", nodeId: "n1", displayName: 42, remoteIp: 99, platform: true, ts: 3 },
      ],
      paired: [
        { nodeId: 5, token: 3 }, // non-string nodeId -> dropped
        { nodeId: "n2", displayName: { x: 1 }, remoteIp: [], lastSeenReason: 0 },
      ],
    });
    // A malformed required id drops the whole row (no "" sentinel a consumer would trust); the valid
    // row survives with optional scalars normalized to undefined so renderers never trim a non-string.
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ requestId: "r1", nodeId: "n1" });
    expect(expectDefined(pending[0], "pending[0] test invariant").displayName).toBeUndefined();
    expect(expectDefined(pending[0], "pending[0] test invariant").remoteIp).toBeUndefined();
    expect(expectDefined(pending[0], "pending[0] test invariant").platform).toBeUndefined();
    expect(paired).toHaveLength(1);
    expect(paired[0]).toMatchObject({ nodeId: "n2" });
    expect(expectDefined(paired[0], "paired[0] test invariant").displayName).toBeUndefined();
    expect(expectDefined(paired[0], "paired[0] test invariant").remoteIp).toBeUndefined();
    expect(expectDefined(paired[0], "paired[0] test invariant").lastSeenReason).toBeUndefined();
  });
});
