import { describe, expect, it } from "vitest";
import {
  buildMatrixReactionContent,
  buildMatrixReactionRelationsPath,
  extractMatrixReactionAnnotation,
  selectOwnMatrixReactionEventIds,
  summarizeMatrixReactionEvents,
} from "./reaction-common.js";

describe("matrix reaction helpers", () => {
  it("builds trimmed reaction content and relation paths", () => {
    expect(buildMatrixReactionContent(" $msg ", " 👍 ")).toEqual({
      "m.relates_to": {
        rel_type: "m.annotation",
        event_id: "$msg",
        key: "👍",
      },
    });
    expect(buildMatrixReactionRelationsPath("!room:example.org", " $msg ")).toContain(
      "/rooms/!room%3Aexample.org/relations/%24msg/m.annotation/m.reaction",
    );
  });

  it("summarizes reactions by emoji and unique sender", () => {
    expect(
      summarizeMatrixReactionEvents([
        { sender: "@alice:example.org", content: { "m.relates_to": { key: "👍" } } },
        { sender: "@alice:example.org", content: { "m.relates_to": { key: "👍" } } },
        { sender: "@bob:example.org", content: { "m.relates_to": { key: "👍" } } },
        { sender: "@alice:example.org", content: { "m.relates_to": { key: "👎" } } },
        { sender: "@ignored:example.org", content: {} },
      ]),
    ).toEqual([
      {
        key: "👍",
        count: 3,
        users: ["@alice:example.org", "@bob:example.org"],
      },
      {
        key: "👎",
        count: 1,
        users: ["@alice:example.org"],
      },
    ]);
  });

  it("selects only matching reaction event ids for the current user", () => {
    expect(
      selectOwnMatrixReactionEventIds(
        [
          {
            event_id: "$1",
            sender: "@me:example.org",
            content: { "m.relates_to": { key: "👍" } },
          },
          {
            event_id: "$2",
            sender: "@me:example.org",
            content: { "m.relates_to": { key: "👎" } },
          },
          {
            event_id: "$3",
            sender: "@other:example.org",
            content: { "m.relates_to": { key: "👍" } },
          },
        ],
        "@me:example.org",
        "👍",
      ),
    ).toEqual(["$1"]);
  });

  it("extracts annotations and ignores non-annotation relations", () => {
    expect(
      extractMatrixReactionAnnotation({
        "m.relates_to": {
          rel_type: "m.annotation",
          event_id: " $msg ",
          key: " 👍 ",
        },
      }),
    ).toEqual({
      eventId: "$msg",
      key: "👍",
    });
    expect(
      extractMatrixReactionAnnotation({
        "m.relates_to": {
          rel_type: "m.replace",
          event_id: "$msg",
          key: "👍",
        },
      }),
    ).toBeUndefined();
  });
});
