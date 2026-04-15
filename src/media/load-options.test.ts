import { describe, expect, it } from "vitest";
import { buildOutboundMediaLoadOptions, resolveOutboundMediaLocalRoots } from "./load-options.js";

describe("media load options", () => {
  function expectResolvedOutboundMediaRoots(
    mediaLocalRoots: readonly string[] | "any" | undefined,
    expectedLocalRoots: readonly string[] | "any" | undefined,
  ) {
    expect(resolveOutboundMediaLocalRoots(mediaLocalRoots)).toEqual(expectedLocalRoots);
  }

  function expectBuiltOutboundMediaLoadOptions(
    params: Parameters<typeof buildOutboundMediaLoadOptions>[0],
    expected: ReturnType<typeof buildOutboundMediaLoadOptions>,
  ) {
    expect(buildOutboundMediaLoadOptions(params)).toEqual(expected);
  }

  it.each([
    { mediaLocalRoots: undefined, expectedLocalRoots: undefined },
    { mediaLocalRoots: [], expectedLocalRoots: undefined },
    { mediaLocalRoots: ["/tmp/workspace"], expectedLocalRoots: ["/tmp/workspace"] },
    { mediaLocalRoots: "any", expectedLocalRoots: "any" },
  ] as const)("resolves outbound local roots %#", ({ mediaLocalRoots, expectedLocalRoots }) => {
    expectResolvedOutboundMediaRoots(mediaLocalRoots, expectedLocalRoots);
  });

  it.each([
    {
      params: { maxBytes: 1024, mediaLocalRoots: ["/tmp/workspace"] },
      expected: { maxBytes: 1024, localRoots: ["/tmp/workspace"] },
    },
    {
      params: { maxBytes: 2048, mediaLocalRoots: undefined },
      expected: { maxBytes: 2048, localRoots: undefined },
    },
    {
      params: {
        maxBytes: 4096,
        mediaAccess: {
          localRoots: ["/tmp/workspace"],
          readFile: async () => Buffer.from("x"),
        },
      },
      expected: {
        maxBytes: 4096,
        localRoots: ["/tmp/workspace"],
        readFile: expect.any(Function),
        hostReadCapability: true,
      },
    },
    {
      params: {
        maxBytes: 4096,
        mediaLocalRoots: "any",
        mediaReadFile: async () => Buffer.from("x"),
      },
      expected: {
        maxBytes: 4096,
        localRoots: "any",
        readFile: expect.any(Function),
        hostReadCapability: true,
      },
    },
  ] as const)("builds outbound media load options %#", ({ params, expected }) => {
    expectBuiltOutboundMediaLoadOptions(params, expected);
  });

  it("rejects host read capability without explicit local roots", () => {
    expect(() =>
      buildOutboundMediaLoadOptions({
        maxBytes: 1024,
        mediaAccess: {
          readFile: async () => Buffer.from("x"),
        },
      }),
    ).toThrow("Host media read requires explicit localRoots");
    expect(() =>
      buildOutboundMediaLoadOptions({
        maxBytes: 1024,
        mediaReadFile: async () => Buffer.from("x"),
      }),
    ).toThrow("Host media read requires explicit localRoots");
  });
});
