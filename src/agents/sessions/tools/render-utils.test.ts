import * as os from "node:os";
import { describe, expect, it } from "vitest";
import { appendSessionToolTruncationWarning, shortenPath } from "./render-utils.js";

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

  it("returns an empty string for non-string input", () => {
    expect(shortenPath(undefined)).toBe("");
  });
});
