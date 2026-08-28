// @vitest-environment node
import { describe, expect, it } from "vitest";
import { disambiguate } from "./place-labels.ts";

type LabelFixture = {
  nodeId: string;
  displayName: string;
  modelIdentifier?: string;
  remoteIp?: string;
};

const nodeCandidates = [
  (node: LabelFixture) => node.modelIdentifier,
  (node: LabelFixture) => node.remoteIp,
  (node: LabelFixture) => node.nodeId.slice(0, 8),
];

describe("disambiguate", () => {
  it.each([
    {
      name: "leaves unique labels alone",
      items: [
        { nodeId: "11111111", displayName: "Mac Studio", modelIdentifier: "Mac14,12" },
        { nodeId: "22222222", displayName: "MacBook", modelIdentifier: "Mac15,3" },
      ],
      expected: [undefined, undefined],
    },
    {
      name: "uses models when they differ",
      items: [
        { nodeId: "11111111", displayName: "Mac Studio", modelIdentifier: "Mac14,12" },
        { nodeId: "22222222", displayName: "Mac Studio", modelIdentifier: "Mac15,14" },
      ],
      expected: ["Mac14,12", "Mac15,14"],
    },
    {
      name: "uses IPs when models tie",
      items: [
        {
          nodeId: "11111111",
          displayName: "Mac Studio",
          modelIdentifier: "Mac14,12",
          remoteIp: "192.168.1.11",
        },
        {
          nodeId: "22222222",
          displayName: "Mac Studio",
          modelIdentifier: "Mac14,12",
          remoteIp: "192.168.1.12",
        },
      ],
      expected: ["192.168.1.11", "192.168.1.12"],
    },
    {
      name: "advances past a partly distinct model candidate",
      items: [
        {
          nodeId: "11111111",
          displayName: "Mac Studio",
          modelIdentifier: "Model A",
          remoteIp: "192.168.1.11",
        },
        {
          nodeId: "22222222",
          displayName: "Mac Studio",
          modelIdentifier: "Model A",
          remoteIp: "192.168.1.12",
        },
        {
          nodeId: "33333333",
          displayName: "Mac Studio",
          modelIdentifier: "Model B",
          remoteIp: "192.168.1.13",
        },
      ],
      expected: ["192.168.1.11", "192.168.1.12", "192.168.1.13"],
    },
    {
      name: "falls back to short IDs when facts are missing",
      items: [
        { nodeId: "11111111aaaa", displayName: "Mac Studio" },
        { nodeId: "22222222bbbb", displayName: "Mac Studio" },
      ],
      expected: ["11111111", "22222222"],
    },
    {
      name: "uses the final fallback for a member missing the selected fact",
      items: [
        { nodeId: "11111111aaaa", displayName: "Mac Studio", modelIdentifier: "Mac14,12" },
        { nodeId: "22222222bbbb", displayName: "Mac Studio", modelIdentifier: "Mac15,14" },
        { nodeId: "33333333cccc", displayName: "Mac Studio" },
      ],
      expected: ["Mac14,12", "Mac15,14", "33333333"],
    },
    {
      name: "uses the last candidate when none is fully distinct",
      items: [
        {
          nodeId: "11111111aaaa",
          displayName: "Mac Studio",
          modelIdentifier: "Mac14,12",
          remoteIp: "192.168.1.11",
        },
        {
          nodeId: "11111111bbbb",
          displayName: "Mac Studio",
          modelIdentifier: "Mac14,12",
          remoteIp: "192.168.1.11",
        },
      ],
      expected: ["11111111", "11111111"],
    },
  ])("$name", ({ items, expected }) => {
    expect(disambiguate(items, (item) => item.displayName, nodeCandidates)).toEqual(expected);
  });

  it("uses parent folders, then full paths, for recent basename collisions", () => {
    const items: Array<{ folder: string; label: string }> = [
      { folder: "/a/openclaw", label: "openclaw" },
      { folder: "/b/openclaw", label: "openclaw" },
      { folder: "/one/shared/openclaw", label: "openclaw · Mac Studio" },
      { folder: "/two/shared/openclaw", label: "openclaw · Mac Studio" },
    ];
    expect(
      disambiguate(items, (item) => item.label, [
        (item) => item.folder.split("/").at(-2),
        (item) => item.folder,
        (item) => item.folder,
      ]),
    ).toEqual(["a", "b", "/one/shared/openclaw", "/two/shared/openclaw"]);
  });
});
