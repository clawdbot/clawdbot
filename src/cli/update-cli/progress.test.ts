import { describe, expect, it } from "vitest";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { inferUpdateFailureHints } from "./progress.js";

function makeResult(
  stepName: string,
  stderrTail: string,
  mode: UpdateRunResult["mode"] = "npm",
): UpdateRunResult {
  return {
    status: "error",
    mode,
    reason: stepName,
    steps: [
      {
        name: stepName,
        command: "npm i -g openclaw@latest",
        cwd: "/tmp",
        durationMs: 1,
        exitCode: 1,
        stderrTail,
      },
    ],
    durationMs: 1,
  };
}

describe("inferUpdateFailureHints", () => {
  it("returns a package-manager bootstrap hint for pnpm npm-bootstrap failures", () => {
    const result = {
      status: "error",
      mode: "git",
      reason: "pnpm-npm-bootstrap-failed",
      steps: [],
      durationMs: 1,
    } satisfies UpdateRunResult;

    const hints = inferUpdateFailureHints(result);

    expect(hints.join("\n")).toContain("bootstrap pnpm from npm");
    expect(hints.join("\n")).toContain("Install pnpm manually");
  });

  it("returns a corepack hint when corepack is missing", () => {
    const result = {
      status: "error",
      mode: "git",
      reason: "pnpm-corepack-missing",
      steps: [],
      durationMs: 1,
    } satisfies UpdateRunResult;

    const hints = inferUpdateFailureHints(result);

    expect(hints.join("\n")).toContain("corepack is missing");
    expect(hints.join("\n")).toContain("Install pnpm manually");
  });

  it("returns EACCES hint for global update permission failures", () => {
    const result = makeResult(
      "global update",
      "npm ERR! code EACCES\nnpm ERR! Error: EACCES: permission denied",
    );
    const hints = inferUpdateFailureHints(result);
    expect(hints.join("\n")).toContain("EACCES");
    expect(hints.join("\n")).toContain("npm config set prefix ~/.local");
  });

  it("returns EACCES hint for staged package permission failures", () => {
    const result = makeResult(
      "global install stage",
      "EACCES: permission denied, mkdtemp '/usr/local/lib/node_modules/.openclaw-update-stage-'",
    );
    const hints = inferUpdateFailureHints(result);
    expect(hints.join("\n")).toContain("EACCES");
    expect(hints.join("\n")).toContain("npm config set prefix ~/.local");
  });

  it("returns native optional dependency hint for node-gyp failures", () => {
    const result = makeResult("global update", "node-pre-gyp ERR!\nnode-gyp rebuild failed");
    const hints = inferUpdateFailureHints(result);
    expect(hints.join("\n")).toContain("--omit=optional");
  });

  it("does not return npm hints for non-npm install modes", () => {
    const result = makeResult(
      "global update",
      "npm ERR! code EACCES\nnpm ERR! Error: EACCES: permission denied",
      "pnpm",
    );
    expect(inferUpdateFailureHints(result)).toStrictEqual([]);
  });
});
