import { describe, expect, it } from "vitest";
import { normalizeCaptureSavedView, normalizeCaptureSavedViews } from "./capture-saved-view.js";

describe("capture saved views", () => {
  it("drops non-object and nameless saved views", () => {
    expect(normalizeCaptureSavedView(null)).toBeNull();
    expect(normalizeCaptureSavedView({ id: "view-1" })).toBeNull();
    expect(normalizeCaptureSavedViews([{ id: "view-1" }, "bad", null])).toEqual([]);
  });

  it("keeps valid saved view fields", () => {
    expect(
      normalizeCaptureSavedView({
        id: "view-1",
        name: "Errors",
        sessionIds: ["session-a"],
        kindFilter: ["request"],
        providerFilter: ["openai"],
        hostFilter: ["api.example.test"],
        searchText: "timeout",
        headerMode: "all",
        viewMode: "timeline",
        groupMode: "flow",
        timelineLaneMode: "provider",
        timelineLaneSort: "severity",
        timelineZoom: 200,
        timelineSparklineMode: "lane-relative",
        errorsOnly: true,
        detailPlacement: "bottom",
        payloadLayout: "raw",
        payloadExtent: "full",
      }),
    ).toEqual({
      id: "view-1",
      name: "Errors",
      sessionIds: ["session-a"],
      kindFilter: ["request"],
      providerFilter: ["openai"],
      hostFilter: ["api.example.test"],
      searchText: "timeout",
      headerMode: "all",
      viewMode: "timeline",
      groupMode: "flow",
      timelineLaneMode: "provider",
      timelineLaneSort: "severity",
      timelineZoom: 200,
      timelineSparklineMode: "lane-relative",
      errorsOnly: true,
      detailPlacement: "bottom",
      payloadLayout: "raw",
      payloadExtent: "full",
    });
  });

  it("falls back invalid enum and scalar fields to safe defaults", () => {
    expect(
      normalizeCaptureSavedView({
        id: "view-1",
        name: "Corrupt",
        sessionIds: ["session-a", 42, "  "],
        kindFilter: "request",
        providerFilter: ["openai"],
        hostFilter: null,
        searchText: 123,
        headerMode: "everything",
        viewMode: "grid",
        groupMode: "cards",
        timelineLaneMode: "host",
        timelineLaneSort: "random",
        timelineZoom: 999,
        timelineSparklineMode: "global",
        errorsOnly: "yes",
        detailPlacement: "left",
        payloadLayout: "html",
        payloadExtent: "all",
      }),
    ).toMatchObject({
      sessionIds: ["session-a"],
      kindFilter: [],
      providerFilter: ["openai"],
      hostFilter: [],
      searchText: "",
      headerMode: "key",
      viewMode: "list",
      groupMode: "none",
      timelineLaneMode: "domain",
      timelineLaneSort: "most-events",
      timelineZoom: 100,
      timelineSparklineMode: "session-relative",
      errorsOnly: false,
      detailPlacement: "right",
      payloadLayout: null,
      payloadExtent: "preview",
    });
  });

  it("caps loaded saved views to the UI limit", () => {
    const views = Array.from({ length: 20 }, (_, index) => ({
      id: `view-${index}`,
      name: `View ${index}`,
    }));

    expect(normalizeCaptureSavedViews(views)).toHaveLength(12);
  });
});
