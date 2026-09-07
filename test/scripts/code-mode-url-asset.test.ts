import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("verifies the packaged guest URL source against the pinned installed dependency graph", () => {
  const output = execFileSync(process.execPath, ["scripts/generate-code-mode-url.mjs", "--check"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  expect(output).toMatch(
    /Code Mode URL asset verified: \d+ bytes; \d+ licensed packages; no external imports\./u,
  );
});
