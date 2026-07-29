// Browser tests cover register.batch plugin behavior.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as browserCliSharedModule from "../browser-cli-shared.js";
import {
  createBrowserProgram,
  getBrowserCliRuntime,
  getBrowserCliRuntimeCapture,
} from "../browser-cli.test-support.js";
import * as cliCoreApiModule from "../core-api.js";
import * as batchSharedModule from "./shared.js";

const mocks = vi.hoisted(() => ({
  callBrowserRequest: vi.fn<
    (
      opts?: unknown,
      req?: unknown,
      extra?: { timeoutMs?: number },
    ) => Promise<Record<string, unknown>>
  >(async () => ({ results: [{ ok: true }] })),
  readActionsPayload: vi.fn(async () => ""),
}));

vi.spyOn(browserCliSharedModule, "callBrowserRequest").mockImplementation(mocks.callBrowserRequest);
vi.spyOn(batchSharedModule, "readActionsPayload").mockImplementation(mocks.readActionsPayload);
const browserCliRuntime = getBrowserCliRuntime();
vi.spyOn(cliCoreApiModule.defaultRuntime, "log").mockImplementation(browserCliRuntime.log);
vi.spyOn(cliCoreApiModule.defaultRuntime, "writeJson").mockImplementation(
  browserCliRuntime.writeJson,
);
vi.spyOn(cliCoreApiModule.defaultRuntime, "error").mockImplementation(browserCliRuntime.error);
vi.spyOn(cliCoreApiModule.defaultRuntime, "exit").mockImplementation(browserCliRuntime.exit);

const { registerBrowserActionInputCommands } = await import("./register.js");

function createActionInputProgram(): Command {
  const { program, browser, parentOpts } = createBrowserProgram();
  registerBrowserActionInputCommands(browser, parentOpts);
  return program;
}

function getLastActionBody(): Record<string, unknown> | undefined {
  return (mocks.callBrowserRequest.mock.calls.at(-1)?.[1] as { body?: Record<string, unknown> })
    ?.body;
}

const SAMPLE_ACTIONS = [
  { kind: "open", url: "https://example.com" },
  { kind: "click", ref: "12" },
];

describe("browser action input batch command", () => {
  beforeEach(() => {
    mocks.callBrowserRequest.mockClear();
    mocks.readActionsPayload.mockClear();
    getBrowserCliRuntimeCapture().resetRuntimeCapture();
  });

  it("sends normalized batch body with inline actions and target id", async () => {
    mocks.readActionsPayload.mockResolvedValueOnce(JSON.stringify(SAMPLE_ACTIONS));
    const program = createActionInputProgram();

    await program.parseAsync(
      ["browser", "batch", "--actions", JSON.stringify(SAMPLE_ACTIONS), "--target-id", "tab-1"],
      { from: "user" },
    );

    expect(getLastActionBody()).toMatchObject({
      kind: "batch",
      actions: SAMPLE_ACTIONS,
      targetId: "tab-1",
    });
  });

  it("omits stopOnError by default so the route applies its fail-fast default", async () => {
    mocks.readActionsPayload.mockResolvedValueOnce(JSON.stringify(SAMPLE_ACTIONS));
    const program = createActionInputProgram();

    await program.parseAsync(["browser", "batch", "--actions", JSON.stringify(SAMPLE_ACTIONS)], {
      from: "user",
    });

    const body = getLastActionBody();
    expect(body).toMatchObject({ kind: "batch" });
    expect(body).not.toHaveProperty("stopOnError");
  });

  it("sets stopOnError=false when --continue is passed", async () => {
    mocks.readActionsPayload.mockResolvedValueOnce(JSON.stringify(SAMPLE_ACTIONS));
    const program = createActionInputProgram();

    await program.parseAsync(
      ["browser", "batch", "--actions", JSON.stringify(SAMPLE_ACTIONS), "--continue"],
      { from: "user" },
    );

    expect(getLastActionBody()).toMatchObject({ kind: "batch", stopOnError: false });
  });

  it("reports a failed batch action and exits nonzero in text mode", async () => {
    mocks.readActionsPayload.mockResolvedValueOnce(JSON.stringify(SAMPLE_ACTIONS));
    mocks.callBrowserRequest.mockResolvedValueOnce({
      results: [{ ok: true }, { ok: false, error: "ref is stale" }],
    });
    const program = createActionInputProgram();

    await expect(
      program.parseAsync(["browser", "batch", "--actions", JSON.stringify(SAMPLE_ACTIONS)], {
        from: "user",
      }),
    ).rejects.toThrow("__exit__:1");

    expect(getBrowserCliRuntimeCapture().runtimeErrors.join("\n")).toContain(
      "batch failed: action 2: ref is stale",
    );
  });

  it("preserves failed batch results in JSON mode before exiting nonzero", async () => {
    const result = { results: [{ ok: false, error: "ref is stale" }] };
    mocks.readActionsPayload.mockResolvedValueOnce(JSON.stringify(SAMPLE_ACTIONS));
    mocks.callBrowserRequest.mockResolvedValueOnce(result);
    const program = createActionInputProgram();

    await expect(
      program.parseAsync(
        ["browser", "--json", "batch", "--actions", JSON.stringify(SAMPLE_ACTIONS)],
        { from: "user" },
      ),
    ).rejects.toThrow("__exit__:1");

    expect(getBrowserCliRuntimeCapture().defaultRuntime.writeJson).toHaveBeenCalledWith(result);
  });

  it("reads actions from a file via --actions-file", async () => {
    mocks.readActionsPayload.mockResolvedValueOnce(JSON.stringify(SAMPLE_ACTIONS));
    const program = createActionInputProgram();

    await program.parseAsync(
      ["browser", "batch", "--actions-file", "/tmp/openclaw/batch-actions.json"],
      { from: "user" },
    );

    expect(mocks.readActionsPayload).toHaveBeenCalledWith({
      actions: undefined,
      actionsFile: "/tmp/openclaw/batch-actions.json",
    });
    expect(getLastActionBody()).toMatchObject({ kind: "batch", actions: SAMPLE_ACTIONS });
  });

  it("reads actions from stdin when --actions-file is -", async () => {
    mocks.readActionsPayload.mockResolvedValueOnce(JSON.stringify(SAMPLE_ACTIONS));
    const program = createActionInputProgram();

    await program.parseAsync(["browser", "batch", "--actions-file", "-"], { from: "user" });

    expect(mocks.readActionsPayload).toHaveBeenCalledWith({
      actions: undefined,
      actionsFile: "-",
    });
    expect(getLastActionBody()).toMatchObject({ kind: "batch", actions: SAMPLE_ACTIONS });
  });

  it("rejects malformed actions JSON before dispatch", async () => {
    mocks.readActionsPayload.mockResolvedValueOnce("NOT JSON {{{");
    const program = createActionInputProgram();

    await expect(
      program.parseAsync(["browser", "batch", "--actions", "NOT JSON {{{"], { from: "user" }),
    ).rejects.toThrow("__exit__:1");

    expect(getBrowserCliRuntimeCapture().runtimeErrors.join("\n")).toContain(
      "actions must be valid JSON",
    );
    expect(mocks.callBrowserRequest).not.toHaveBeenCalled();
  });

  it("rejects non-array actions before dispatch", async () => {
    mocks.readActionsPayload.mockResolvedValueOnce(JSON.stringify({ kind: "click" }));
    const program = createActionInputProgram();

    await expect(
      program.parseAsync(["browser", "batch", "--actions", JSON.stringify({ kind: "click" })], {
        from: "user",
      }),
    ).rejects.toThrow("__exit__:1");

    expect(getBrowserCliRuntimeCapture().runtimeErrors.join("\n")).toContain(
      "actions must be a JSON array",
    );
    expect(mocks.callBrowserRequest).not.toHaveBeenCalled();
  });

  it("rejects empty actions before dispatch", async () => {
    mocks.readActionsPayload.mockResolvedValueOnce("[]");
    const program = createActionInputProgram();

    await expect(
      program.parseAsync(["browser", "batch", "--actions", "[]"], { from: "user" }),
    ).rejects.toThrow("__exit__:1");

    expect(getBrowserCliRuntimeCapture().runtimeErrors.join("\n")).toContain(
      "actions must contain at least one entry",
    );
    expect(mocks.callBrowserRequest).not.toHaveBeenCalled();
  });

  it("requires actions from --actions, --actions-file, or stdin", async () => {
    const program = createActionInputProgram();

    await expect(program.parseAsync(["browser", "batch"], { from: "user" })).rejects.toThrow(
      "__exit__:1",
    );

    expect(getBrowserCliRuntimeCapture().runtimeErrors.join("\n")).toContain(
      "Provide --actions, --actions-file, or --actions-file -",
    );
    expect(mocks.callBrowserRequest).not.toHaveBeenCalled();
  });

  it("budgets the outer request from the batch execution budget", async () => {
    mocks.readActionsPayload.mockResolvedValueOnce(
      JSON.stringify([
        { kind: "wait", timeMs: 5000 },
        { kind: "wait", timeMs: 5000 },
      ]),
    );
    const program = createActionInputProgram();

    await program.parseAsync(
      ["browser", "batch", "--actions", JSON.stringify([{ kind: "wait", timeMs: 5000 }])],
      { from: "user" },
    );

    const options = mocks.callBrowserRequest.mock.calls.at(-1)?.[2] as
      | { timeoutMs?: number }
      | undefined;
    expect(options?.timeoutMs).toBeGreaterThan(10_000);
  });
});
