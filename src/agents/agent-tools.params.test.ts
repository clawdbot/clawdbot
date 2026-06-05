/**
 * Tests required parameter validation for model-facing tools.
 * Covers retry guidance and path-only XML suffix cleanup for file operations.
 */
import { describe, expect, it, vi } from "vitest";
import {
  assertRequiredParams,
  REQUIRED_PARAM_GROUPS,
  getToolParamsRecord,
  stripMalformedXmlArgValueSuffix,
  wrapToolParamValidation,
} from "./agent-tools.params.js";

describe("assertRequiredParams", () => {
  it("returns object params unchanged", () => {
    const params = { path: "test.txt" };
    expect(getToolParamsRecord(params)).toBe(params);
  });

  it("strips only the malformed terminal XML arg-value suffix", () => {
    expect(stripMalformedXmlArgValueSuffix("echo test</arg_value>>")).toBe("echo test");
    expect(stripMalformedXmlArgValueSuffix("echo test</arg_value>>>>>")).toBe("echo test");
    expect(stripMalformedXmlArgValueSuffix("echo test</arg_value>")).toBe("echo test</arg_value>");
    expect(stripMalformedXmlArgValueSuffix("echo </arg_value>> test")).toBe(
      "echo </arg_value>> test",
    );
  });

  it("strips malformed path suffixes without touching payload text", async () => {
    const execute = vi.fn(async (_id, args) => args);
    const tool = wrapToolParamValidation(
      {
        name: "write",
        label: "write",
        description: "write a file",
        parameters: {},
        execute,
      },
      REQUIRED_PARAM_GROUPS.write,
    );

    await tool.execute("id", {
      path: "notes.txt</arg_value>>",
      content: "keep literal payload</arg_value>>",
    });

    expect(execute).toHaveBeenCalledWith(
      "id",
      {
        path: "notes.txt",
        content: "keep literal payload</arg_value>>",
      },
      undefined,
      undefined,
    );
  });

  it("rejects paths that become empty after malformed XML arg-value suffix stripping", async () => {
    const execute = vi.fn();
    const tool = wrapToolParamValidation(
      {
        name: "write",
        label: "write",
        description: "write a file",
        parameters: {},
        execute,
      },
      REQUIRED_PARAM_GROUPS.write,
    );

    await expect(tool.execute("id", { path: "</arg_value>>", content: "x" })).rejects.toThrow(
      /Missing required parameter: path/,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves edit replacement payloads while cleaning the path", async () => {
    const execute = vi.fn(async (_id, args) => args);
    const tool = wrapToolParamValidation(
      {
        name: "edit",
        label: "edit",
        description: "edit a file",
        parameters: {},
        execute,
      },
      REQUIRED_PARAM_GROUPS.edit,
    );

    const edits = [
      {
        oldText: "literal old</arg_value>>",
        newText: "literal new</arg_value>>",
      },
    ];
    await tool.execute("id", { path: "notes.txt</arg_value>>>", edits });

    expect(execute).toHaveBeenCalledWith("id", { path: "notes.txt", edits }, undefined, undefined);
  });

  it("includes received keys in error when some params are present but content is missing", () => {
    expect(() =>
      assertRequiredParams(
        { path: "test.txt" },
        [
          { keys: ["path"], label: "path" },
          { keys: ["content"], label: "content" },
        ],
        "write",
      ),
    ).toThrow(/\(received: path\)/);
  });

  it("does not normalize legacy aliases during validation", async () => {
    const tool = wrapToolParamValidation(
      {
        name: "write",
        label: "write",
        description: "write a file",
        parameters: {},
        execute: vi.fn(),
      },
      REQUIRED_PARAM_GROUPS.write,
    );
    await expect(
      tool.execute("id", { file_path: "test.txt" }, new AbortController().signal, vi.fn()),
    ).rejects.toThrow(/\(received: file_path\)/);
  });

  it("enforces canonical path/content at runtime", async () => {
    const execute = vi.fn(async (_id, args) => args);
    const tool = wrapToolParamValidation(
      {
        name: "write",
        label: "write",
        description: "test",
        parameters: {},
        execute,
      },
      REQUIRED_PARAM_GROUPS.write,
    );

    await tool.execute("tool-1", { path: "foo.txt", content: "x" });
    expect(execute).toHaveBeenCalledWith(
      "tool-1",
      { path: "foo.txt", content: "x" },
      undefined,
      undefined,
    );

    await expect(tool.execute("tool-2", { content: "x" })).rejects.toThrow(
      /Missing required parameter/,
    );
    await expect(tool.execute("tool-2", { content: "x" })).rejects.toThrow(
      /Supply correct parameters before retrying\./,
    );
    await expect(tool.execute("tool-3", { path: "   ", content: "x" })).rejects.toThrow(
      /Missing required parameter/,
    );
    await expect(tool.execute("tool-3", { path: "   ", content: "x" })).rejects.toThrow(
      /Supply correct parameters before retrying\./,
    );
    await expect(tool.execute("tool-4", {})).rejects.toThrow(
      /Missing required parameters: path, content/,
    );
    await expect(tool.execute("tool-4", {})).rejects.toThrow(
      /Supply correct parameters before retrying\./,
    );
  });

  it("excludes null and undefined values from received hint", () => {
    expect(() =>
      assertRequiredParams(
        { path: "test.txt", content: null },
        [
          { keys: ["path"], label: "path" },
          { keys: ["content"], label: "content" },
        ],
        "write",
      ),
    ).toThrow(/\(received: path\)[^,]/);
  });

  it("shows empty-string values for present params that still fail validation", () => {
    expect(() =>
      assertRequiredParams(
        { path: "/tmp/a.txt", content: "   " },
        [
          { keys: ["path"], label: "path" },
          { keys: ["content"], label: "content" },
        ],
        "write",
      ),
    ).toThrow(/\(received: path, content=<empty-string>\)/);
  });

  it("shows wrong-type values for present params that still fail validation", async () => {
    const tool = wrapToolParamValidation(
      {
        name: "write",
        label: "write",
        description: "write a file",
        parameters: {},
        execute: vi.fn(),
      },
      REQUIRED_PARAM_GROUPS.write,
    );
    await expect(
      tool.execute(
        "id",
        { path: "test.txt", content: { unexpected: true } },
        new AbortController().signal,
        vi.fn(),
      ),
    ).rejects.toThrow(/\(received: (?:path, content=<object>|content=<object>, path)\)/);
  });

  it("includes multiple received keys when several params are present", () => {
    expect(() =>
      assertRequiredParams(
        { path: "/tmp/a.txt", extra: "yes" },
        [
          { keys: ["path"], label: "path" },
          { keys: ["content"], label: "content" },
        ],
        "write",
      ),
    ).toThrow(/\(received: path, extra\)/);
  });

  it("omits received hint when the record is empty", () => {
    const err = (() => {
      try {
        assertRequiredParams({}, [{ keys: ["content"], label: "content" }], "write");
      } catch (e) {
        return e instanceof Error ? e.message : "";
      }
      return "";
    })();
    expect(err).not.toMatch(/received:/);
    expect(err).toMatch(/Missing required parameter: content/);
  });

  it("returns undefined when all required params are present", () => {
    expect(
      assertRequiredParams(
        { path: "a.txt", content: "hello" },
        [
          { keys: ["path"], label: "path" },
          { keys: ["content"], label: "content" },
        ],
        "write",
      ),
    ).toBeUndefined();
  });
});
