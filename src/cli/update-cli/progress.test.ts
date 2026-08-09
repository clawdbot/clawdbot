// Update progress tests cover progress event formatting for update operations.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import { printResult } from "./progress.js";

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

function renderResult(result: UpdateRunResult): string {
  const lines: string[] = [];
  vi.spyOn(defaultRuntime, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  printResult(result, { hideSteps: true });
  return lines.join("\n");
}

describe("update failure hints", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a package-manager bootstrap hint for pnpm npm-bootstrap failures", () => {
    const result = {
      status: "error",
      mode: "git",
      reason: "pnpm-npm-bootstrap-failed",
      steps: [],
      durationMs: 1,
    } satisfies UpdateRunResult;

    const output = renderResult(result);

    expect(output).toContain("bootstrap pnpm from npm");
    expect(output).toContain("Install pnpm manually");
  });

  it("returns a corepack hint when corepack is missing", () => {
    const result = {
      status: "error",
      mode: "git",
      reason: "pnpm-corepack-missing",
      steps: [],
      durationMs: 1,
    } satisfies UpdateRunResult;

    const output = renderResult(result);

    expect(output).toContain("corepack is missing");
    expect(output).toContain("Install pnpm manually");
  });

  it("returns EACCES hint for global update permission failures", () => {
    const result = makeResult(
      "global update",
      "npm ERR! code EACCES\nnpm ERR! Error: EACCES: permission denied",
    );
    const output = renderResult(result);
    expect(output).toContain("EACCES");
    expect(output).toContain("npm config set prefix ~/.local");
    expect(output).toContain("stop the Gateway first");
  });

  it("returns EACCES hint for staged package permission failures", () => {
    const result = makeResult(
      "global install stage",
      "EACCES: permission denied, mkdtemp '/usr/local/lib/node_modules/.openclaw-update-stage-'",
    );
    const output = renderResult(result);
    expect(output).toContain("EACCES");
    expect(output).toContain("npm config set prefix ~/.local");
    expect(output).toContain("<system-npm>");
    expect(output).toContain("gateway install --force");
    expect(output).toContain("gateway restart");
  });

  it("returns native optional dependency hint for node-gyp failures", () => {
    const result = makeResult("global update", "node-pre-gyp ERR!\nnode-gyp rebuild failed");
    const output = renderResult(result);
    expect(output).toContain("--omit=optional");
  });

  it("does not return npm hints for non-npm install modes", () => {
    const result = makeResult(
      "global update",
      "npm ERR! code EACCES\nnpm ERR! Error: EACCES: permission denied",
      "pnpm",
    );
    const output = renderResult(result);
    expect(output).not.toContain("Recovery hints:");
    expect(output).not.toContain("npm config set prefix ~/.local");
  });
});
