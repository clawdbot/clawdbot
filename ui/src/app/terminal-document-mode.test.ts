import { describe, expect, it } from "vitest";
import { isTerminalOnlyView, terminalDocumentPath } from "./terminal-document-mode.ts";

describe("terminal document mode", () => {
  it.each([
    ["the root route", { pathname: "/terminal", search: "" }, ""],
    ["a base-mounted route", { pathname: "/openclaw/terminal", search: "" }, "/openclaw"],
    ["the embedded query form", { pathname: "/", search: "?view=terminal" }, ""],
  ])("recognizes %s", (_label, location, basePath) => {
    expect(isTerminalOnlyView(location, basePath)).toBe(true);
  });

  it("does not treat an ordinary route as a terminal document", () => {
    expect(isTerminalOnlyView({ pathname: "/chat", search: "" }, "")).toBe(false);
  });

  it("builds a base-path-aware user-facing route", () => {
    expect(terminalDocumentPath("/openclaw/")).toBe("/openclaw/terminal");
  });
});
