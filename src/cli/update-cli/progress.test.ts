// Update progress tests cover progress event formatting for update operations.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateRunResult, UpdateStepResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import { createUpdateProgress, printResult } from "./progress.js";

function makeResult(
  stepName: string,
  stderrTail: string,
  mode: UpdateRunResult["mode"] = "npm",
): UpdateRunResult & { steps: [UpdateStepResult] } {
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

function renderResult(result: UpdateRunResult, hideSteps = true): string {
  const lines: string[] = [];
  vi.spyOn(defaultRuntime, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  printResult(result, { hideSteps });
  return lines.join("\n");
}

describe("update failure hints", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("explains capacity exhaustion without blaming candidate commits", () => {
    const result = makeResult("preflight-insufficient-space", "", "git");
    const output = renderResult(result);
    expect(output).toContain("Free space");
    expect(output).toContain("preflight staging and package-manager store");
    expect(output).toContain("rerun the update");
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

  it("shows the final diagnostics from both build streams", () => {
    const result = makeResult("build", "Build failed", "git");
    result.steps[0].stdoutTail = [
      "old output",
      ...Array.from({ length: 10 }, (_, i) => `diagnostic ${i}`),
    ].join("\n");

    const output = renderResult(result, false);

    expect(output).toContain("Building");
    expect(output).toContain("diagnostic 9");
    expect(output).toContain("Build failed");
    expect(output).not.toContain("old output");
  });

  it("explains a timeout even when the subprocess produced no output", () => {
    const result = makeResult("build", "", "git");
    result.steps[0].exitCode = null;
    result.steps[0].termination = "timeout";

    expect(renderResult(result, false)).toContain("Building — timed out");
  });

  it("reports redirected progress before completion and preserves stdout failures", () => {
    const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const { progress, stop } = createUpdateProgress(true);
    const step = { name: "build", command: "pnpm build", index: 0, total: 1 };
    try {
      progress.onStepStart?.(step);
      expect(log).toHaveBeenCalledWith("Building...");
      progress.onStepComplete?.({
        ...step,
        durationMs: 1200,
        exitCode: 1,
        stdoutTail: "Build type error",
      });
      expect(log.mock.calls.flat().join("\n")).toContain("Build type error");
    } finally {
      stop();
      if (tty) {
        Object.defineProperty(process.stdout, "isTTY", tty);
      } else {
        Reflect.deleteProperty(process.stdout, "isTTY");
      }
    }
  });

  it("keeps progress silent when JSON output owns stdout", () => {
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const { progress, stop } = createUpdateProgress(false);
    const step = { name: "build", command: "pnpm build", index: 0, total: 1 };
    progress.onStepStart?.(step);
    progress.onStepComplete?.({ ...step, durationMs: 1, exitCode: 0 });
    stop();
    expect(log).not.toHaveBeenCalled();
  });
});
