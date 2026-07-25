import { describe, expect, it } from "vitest";
import {
  projectPersistedMessageMediaFacts,
  readPersistedMediaFactsWithLegacyFallback,
} from "./media-facts.js";

const canonicalFact = { path: "/media/canonical.png", contentType: "image/png" };

const persistedConsumerCases = [
  {
    name: "legacy-only",
    message: { MediaPath: "/media/legacy.png", MediaType: "image/png" },
    expectedPath: "/media/legacy.png",
  },
  {
    name: "facts-only",
    message: { __openclaw: { media: [canonicalFact] } },
    expectedPath: canonicalFact.path,
  },
  {
    name: "both-equal",
    message: {
      MediaPath: canonicalFact.path,
      MediaType: canonicalFact.contentType,
      __openclaw: { media: [canonicalFact] },
    },
    expectedPath: canonicalFact.path,
  },
  {
    name: "both-conflict",
    message: {
      MediaPath: "/media/legacy-conflict.jpg",
      MediaType: "image/jpeg",
      __openclaw: { media: [canonicalFact] },
    },
    expectedPath: canonicalFact.path,
  },
  {
    name: "sparse",
    message: { __openclaw: { media: [{}, canonicalFact] } },
    expectedPath: canonicalFact.path,
    expectedIndex: 1,
  },
  {
    name: "type-only",
    message: { __openclaw: { media: [{ contentType: "image/png" }] } },
    expectedPath: undefined,
  },
  {
    name: "media-only",
    message: { role: "user", content: "", __openclaw: { media: [canonicalFact] } },
    expectedPath: canonicalFact.path,
  },
] as const;

describe("persisted media consumer compatibility", () => {
  it.each(persistedConsumerCases)("reads $name rows facts first", (testCase) => {
    const media = readPersistedMediaFactsWithLegacyFallback(testCase.message);
    const index = "expectedIndex" in testCase ? (testCase.expectedIndex ?? 0) : 0;
    expect(media?.[index]?.path).toBe(testCase.expectedPath);
    if (testCase.name === "both-conflict") {
      expect(media?.[0]?.path).not.toBe(testCase.message.MediaPath);
    }
  });

  it.each(persistedConsumerCases)("projects $name rows to facts only", (testCase) => {
    const projected = projectPersistedMessageMediaFacts(testCase.message) as Record<
      string,
      unknown
    >;
    expect(projected).not.toHaveProperty("MediaPath");
    expect(projected).not.toHaveProperty("MediaType");
    expect(projected["__openclaw"]).toMatchObject({ media: expect.any(Array) });
  });

  it("strips empty legacy projections without inventing canonical facts", () => {
    const projected = projectPersistedMessageMediaFacts({
      role: "user",
      MediaPaths: [],
      MediaTypes: [],
    });

    expect(projected).toEqual({ role: "user" });
  });

  it("removes a conflicting top-level media copy", () => {
    const projected = projectPersistedMessageMediaFacts({
      media: [{ path: "/media/runtime.png", contentType: "image/png" }],
      __openclaw: { media: [canonicalFact] },
    });

    expect(projected).not.toHaveProperty("media");
    expect(projected["__openclaw"].media).toMatchObject([canonicalFact]);
  });

  it("strips an empty top-level media carrier", () => {
    expect(projectPersistedMessageMediaFacts({ role: "user", media: [] })).toEqual({
      role: "user",
    });
  });
});
