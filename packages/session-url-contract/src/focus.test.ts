import { describe, expect, it } from "vitest";
import {
  buildControlUiFocusPath,
  inferControlUiFocusBasePath,
  parseControlUiFocusLocation,
} from "./focus.js";

describe("Control UI focus locations", () => {
  it.each([
    ["dashboard main", "/focus/dashboard/roboclaw", undefined, "/dashboard/roboclaw"],
    [
      "dashboard short reference",
      "/focus/dashboard/roboclaw/the-daily-claw-6d7c9ccb",
      undefined,
      "/dashboard/roboclaw/the-daily-claw-6d7c9ccb",
    ],
    [
      "dashboard literal key",
      "/focus/dashboard/roboclaw/~key/12345678",
      undefined,
      "/dashboard/roboclaw/~key/12345678",
    ],
    [
      "base-path dashboard",
      "/openclaw/focus/dashboard/roboclaw/the-daily-claw-6d7c9ccb/",
      "/openclaw",
      "/openclaw/dashboard/roboclaw/the-daily-claw-6d7c9ccb",
    ],
  ])("parses %s through the underlying dashboard route", (_name, pathname, basePath, routePath) => {
    expect(parseControlUiFocusLocation(pathname, basePath)).toEqual({
      status: "valid",
      basePath: basePath ?? "",
      target: {
        kind: "dashboard",
        route: { pathname: routePath, search: "", hash: "" },
      },
    });
  });

  it.each([
    ["terminal", "/focus/terminal", { kind: "terminal" }],
    ["desktop", "/focus/desktop/", { kind: "desktop", control: false, selector: null }],
    [
      "desktop source",
      "/focus/desktop/source/environment%3AMac%20Studio%2FQA%20%26%20demo",
      {
        kind: "desktop",
        control: false,
        selector: { kind: "source", value: "environment:Mac Studio/QA & demo" },
      },
    ],
    [
      "desktop session",
      "/focus/desktop/session/agent%3Amain%3Amobile%20session",
      {
        kind: "desktop",
        control: false,
        selector: { kind: "session", value: "agent:main:mobile session" },
      },
    ],
    [
      "controlled desktop",
      "/focus/desktop/control",
      { kind: "desktop", control: true, selector: null },
    ],
    [
      "controlled source",
      "/focus/desktop/control/source/node%3Aworker-1",
      {
        kind: "desktop",
        control: true,
        selector: { kind: "source", value: "node:worker-1" },
      },
    ],
    [
      "controlled session",
      "/focus/desktop/control/session/agent%3Amain%3Amobile",
      {
        kind: "desktop",
        control: true,
        selector: { kind: "session", value: "agent:main:mobile" },
      },
    ],
  ] as const)("parses %s", (_name, pathname, target) => {
    expect(parseControlUiFocusLocation(pathname, "")).toEqual({
      status: "valid",
      basePath: "",
      target,
    });
  });

  it.each([
    "/focus",
    "/focus/unknown",
    "/focus/terminal/extra",
    "/focus/desktop/source",
    "/focus/desktop/session/%",
    "/focus/desktop/control/unknown/value",
    "/focus/dashboard",
  ])("rejects malformed or unsupported target %s", (pathname) => {
    expect(parseControlUiFocusLocation(pathname, "")).toEqual({
      status: "unsupported",
      basePath: "",
    });
  });

  it.each([
    "/?view=dashboard&session=agent%3Amain%3Awork",
    "/?view=terminal",
    "/?view=desktop",
    "/terminal",
    "/desktop",
    "/focused/terminal",
  ])("does not parse query aliases or lookalike location %s", (pathname) => {
    expect(parseControlUiFocusLocation(pathname, "")).toBeNull();
  });

  it("infers focus-aware base paths without overriding an explicit base", () => {
    expect(inferControlUiFocusBasePath("/focus/terminal")).toBe("");
    expect(inferControlUiFocusBasePath("/openclaw/focus/desktop")).toBe("/openclaw");
    expect(inferControlUiFocusBasePath("/company/focus/focus/terminal")).toBe("/company/focus");
    expect(inferControlUiFocusBasePath("/focused/terminal")).toBeNull();
    expect(parseControlUiFocusLocation("/openclaw/focus/terminal", "/other")).toBeNull();
  });

  it("passes dashboard search and hash through to the canonical route loader", () => {
    expect(
      parseControlUiFocusLocation({
        pathname: "/focus/dashboard/main",
        search: "?catalog=beam&host=gateway&thread=one",
        hash: "#pane",
      }),
    ).toEqual({
      status: "valid",
      basePath: "",
      target: {
        kind: "dashboard",
        route: {
          pathname: "/dashboard/main",
          search: "?catalog=beam&host=gateway&thread=one",
          hash: "#pane",
        },
      },
    });
  });
});

describe("buildControlUiFocusPath", () => {
  it.each([
    [
      "dashboard",
      { kind: "dashboard", path: "/dashboard/roboclaw/the-daily-claw-6d7c9ccb" },
      "",
      "/focus/dashboard/roboclaw/the-daily-claw-6d7c9ccb",
    ],
    [
      "base-path dashboard with suffix",
      { kind: "dashboard", path: "/openclaw/dashboard/roboclaw/main?catalog=beam#pane" },
      "/openclaw/",
      "/openclaw/focus/dashboard/roboclaw/main?catalog=beam#pane",
    ],
    ["terminal", { kind: "terminal" }, "/openclaw", "/openclaw/focus/terminal"],
    ["desktop", { kind: "desktop" }, "", "/focus/desktop"],
    [
      "desktop source",
      { kind: "desktop", source: "environment:Mac Studio/QA & demo" },
      "",
      "/focus/desktop/source/environment%3AMac%20Studio%2FQA%20%26%20demo",
    ],
    [
      "desktop session",
      { kind: "desktop", session: "agent:main:mobile session" },
      "",
      "/focus/desktop/session/agent%3Amain%3Amobile%20session",
    ],
    [
      "controlled source wins",
      {
        kind: "desktop",
        control: true,
        source: "node:worker-1",
        session: "agent:main:mobile",
      },
      "",
      "/focus/desktop/control/source/node%3Aworker-1",
    ],
    [
      "controlled session",
      { kind: "desktop", control: true, session: "agent:main:mobile" },
      "",
      "/focus/desktop/control/session/agent%3Amain%3Amobile",
    ],
    [
      "empty values",
      { kind: "desktop", source: " ", session: "" },
      "/openclaw",
      "/openclaw/focus/desktop",
    ],
  ] as const)("builds %s", (_name, target, basePath, expected) => {
    expect(buildControlUiFocusPath(target, basePath)).toBe(expected);
  });

  it("rejects a dashboard route outside the configured base path", () => {
    expect(
      buildControlUiFocusPath({ kind: "dashboard", path: "/dashboard/roboclaw/main" }, "/openclaw"),
    ).toBeNull();
  });
});
