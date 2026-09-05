import fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  appendSessionToolTruncationWarning,
  reuseTextComponent,
  shortenPath,
  trimTrailingEmptyLines,
} from "./render-utils.js";

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
};

describe("appendSessionToolTruncationWarning", () => {
  it("leaves output unchanged when no truncation metadata is present", () => {
    expect(appendSessionToolTruncationWarning("output", theme, {})).toBe("output");
  });

  it("combines limit, byte, and additional warnings in order", () => {
    expect(
      appendSessionToolTruncationWarning("output", theme, {
        limit: { count: 5, noun: "matches" },
        truncation: { truncated: true, maxBytes: 1024 },
        additionalWarnings: ["some lines truncated"],
      }),
    ).toBe(
      "output\n<warning>[Truncated: 5 matches limit, 1.0KB limit, some lines truncated]</warning>",
    );
  });
});

describe("trimTrailingEmptyLines", () => {
  it.each([
    {
      name: "removes multiple trailing empty lines",
      lines: ["first", "second", "", ""],
      expected: ["first", "second"],
    },
    { name: "removes all-empty input", lines: ["", ""], expected: [] },
    {
      name: "keeps leading and interior empty lines",
      lines: ["", "first", "", "second", ""],
      expected: ["", "first", "", "second"],
    },
    {
      name: "keeps whitespace-only trailing lines",
      lines: ["first", " ", "\t"],
      expected: ["first", " ", "\t"],
    },
  ])("$name", ({ lines, expected }) => {
    expect(trimTrailingEmptyLines(lines)).toEqual(expected);
  });

  it("does not mutate the caller-owned lines", () => {
    const lines = ["first", "", ""];
    const original = [...lines];

    trimTrailingEmptyLines(lines);

    expect(lines).toEqual(original);
  });
});

describe("reuseTextComponent", () => {
  it("creates a zero-padding Text component when no prior component exists", () => {
    const component = reuseTextComponent(undefined, "hello");

    expect(component).toBeInstanceOf(Text);
    expect(component.render(5)).toEqual(["hello"]);
  });

  it("reuses the prior Text component and invalidates its rendered content", () => {
    const component = new Text("before", 0, 0);
    expect(component.render(6)).toEqual(["before"]);

    const reused = reuseTextComponent(component, "after!");

    expect(reused).toBe(component);
    expect(reused.render(6)).toEqual(["after!"]);
  });
});

describe("shortenPath", () => {
  const home = os.homedir();

  it("shortens paths inside the home directory", () => {
    expect(shortenPath(`${home}/projects/app.ts`)).toBe("~/projects/app.ts");
  });

  it("collapses the home directory itself", () => {
    expect(shortenPath(home)).toBe("~");
  });

  it("leaves a sibling directory that merely shares the prefix untouched", () => {
    // `${home}extra` starts with `home` as a substring but is not under it,
    // so it must not be rewritten to `~extra`.
    expect(shortenPath(`${home}extra/app.ts`)).toBe(`${home}extra/app.ts`);
  });

  it("leaves unrelated paths untouched", () => {
    expect(shortenPath("/var/log/syslog")).toBe("/var/log/syslog");
  });

  it.skipIf(process.platform !== "win32")("shortens real Windows home casing aliases", () => {
    const homeAlias = home.toUpperCase();
    expect(fs.statSync(homeAlias).isDirectory()).toBe(true);

    expect(shortenPath(path.join(homeAlias, "projects", "app.ts"))).toBe(
      `~${path.sep}projects${path.sep}app.ts`,
    );
  });

  it("returns an empty string for non-string input", () => {
    expect(shortenPath(undefined)).toBe("");
  });
});
