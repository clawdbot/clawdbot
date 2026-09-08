import { describe, expect, it } from "vitest";
import { parseNodeOptionsEnvVar } from "./node-options.js";

describe("parseNodeOptionsEnvVar", () => {
  it.each([
    { input: undefined, expected: [] },
    { input: "", expected: [] },
    {
      input: '--im"port" "file:///tmp/my hook.mjs"',
      expected: ["--import", "file:///tmp/my hook.mjs"],
    },
    {
      input: '"--im\\port" "file:///tmp/my hook.mjs"',
      expected: ["--import", "file:///tmp/my hook.mjs"],
    },
    {
      input: "--experimental_loader ./hook.mjs",
      expected: ["--experimental_loader", "./hook.mjs"],
    },
    {
      input: "'--import' ./hook.mjs\twith-tab",
      expected: ["'--import'", "./hook.mjs\twith-tab"],
    },
    {
      input: '--require "" ./hook.cjs',
      expected: ["--require", "./hook.cjs"],
    },
  ])("matches Node tokenization for $input", ({ input, expected }) => {
    expect(parseNodeOptionsEnvVar(input)).toEqual(expected);
  });

  it.each(['"--import ./hook.mjs', '"--import ./hook.mjs\\'])(
    "rejects malformed input %j",
    (input) => {
      expect(parseNodeOptionsEnvVar(input)).toBeNull();
    },
  );
});
