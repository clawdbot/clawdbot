import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  SessionsCatalogListParamsSchema,
  SessionsCatalogListResultSchema,
} from "./sessions-catalog.js";

describe("SessionsCatalogListResultSchema", () => {
  it("accepts a closed catalog result with hosts", () => {
    expect(
      Value.Check(SessionsCatalogListResultSchema, {
        catalogs: [
          {
            id: "claude",
            label: "Claude Code",
            capabilities: { continueSession: true, archive: false },
            hosts: [
              {
                hostId: "gateway:local",
                label: "Gateway",
                kind: "gateway",
                connected: true,
                sessions: [],
              },
            ],
          },
        ],
      }),
    ).toBe(true);
  });
});

describe("SessionsCatalogListParamsSchema", () => {
  it("requires a catalog selector for host cursors", () => {
    expect(
      Value.Check(SessionsCatalogListParamsSchema, { cursors: { "gateway:local": "1" } }),
    ).toBe(false);
    expect(
      Value.Check(SessionsCatalogListParamsSchema, {
        catalogId: "claude",
        cursors: { "gateway:local": "1" },
      }),
    ).toBe(true);
  });
});
