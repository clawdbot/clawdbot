import { describe, expect, it } from "vitest";
import { quoteCliArg } from "./quote-cli-arg.js";

describe("quoteCliArg", () => {
  it.each([
    ["hello", "hello"],
    ["/usr/bin/node", "/usr/bin/node"],
    ["--flag=alpha,beta", "--flag=alpha,beta"],
    ["", "''"],
    ["hello world", "'hello world'"],
    ["it's", "'it'\\''s'"],
    ["$PATH", "'$PATH'"],
    ["build & run", "'build & run'"],
    ["cat file | grep x", "'cat file | grep x'"],
    ["*.txt", "'*.txt'"],
    ["$(whoami)", "'$(whoami)'"],
    ["`whoami`", "'`whoami`'"],
    ["echo; rm", "'echo; rm'"],
    ["line\nbreak", "'line\nbreak'"],
  ])("quotes %j as %j", (value, expected) => {
    expect(quoteCliArg(value)).toBe(expected);
  });
});
