import { describe, expect, it } from "vitest";
import {
  classifyTool,
  hashInput,
  hashOutput,
  extractTarget,
  createR6Request,
} from "./r6.js";

describe("classifyTool", () => {
  it("should classify file read tools", () => {
    expect(classifyTool("Read")).toBe("file_read");
    expect(classifyTool("Glob")).toBe("file_read");
    expect(classifyTool("Grep")).toBe("file_read");
  });

  it("should classify file write tools", () => {
    expect(classifyTool("Write")).toBe("file_write");
    expect(classifyTool("Edit")).toBe("file_write");
    expect(classifyTool("NotebookEdit")).toBe("file_write");
  });

  it("should classify command tools", () => {
    expect(classifyTool("Bash")).toBe("command");
  });

  it("should classify network tools", () => {
    expect(classifyTool("WebFetch")).toBe("network");
    expect(classifyTool("WebSearch")).toBe("network");
  });

  it("should classify delegation tools", () => {
    expect(classifyTool("Task")).toBe("delegation");
  });

  it("should classify state tools", () => {
    expect(classifyTool("TodoWrite")).toBe("state");
  });

  it("should return unknown for unrecognized tools", () => {
    expect(classifyTool("CustomTool")).toBe("unknown");
    expect(classifyTool("")).toBe("unknown");
  });
});

describe("hashInput", () => {
  it("should return a 16-char hex string", () => {
    const h = hashInput({ foo: "bar" });
    expect(h).toMatch(/^[a-f0-9]{16}$/);
  });

  it("should produce deterministic hashes", () => {
    expect(hashInput({ a: 1 })).toBe(hashInput({ a: 1 }));
  });

  it("should produce different hashes for different input", () => {
    expect(hashInput({ a: 1 })).not.toBe(hashInput({ a: 2 }));
  });
});

describe("hashOutput", () => {
  it("should hash string output directly", () => {
    const h = hashOutput("hello");
    expect(h).toMatch(/^[a-f0-9]{16}$/);
  });

  it("should JSON-stringify non-string output", () => {
    const h = hashOutput({ result: true });
    expect(h).toMatch(/^[a-f0-9]{16}$/);
  });

  it("should produce deterministic hashes", () => {
    expect(hashOutput("test")).toBe(hashOutput("test"));
  });
});

describe("extractTarget", () => {
  it("should extract file_path", () => {
    expect(extractTarget("Read", { file_path: "/foo/bar.ts" })).toBe("/foo/bar.ts");
  });

  it("should extract path", () => {
    expect(extractTarget("Glob", { path: "/src" })).toBe("/src");
  });

  it("should extract pattern", () => {
    expect(extractTarget("Grep", { pattern: "TODO" })).toBe("TODO");
  });

  it("should extract and truncate long commands", () => {
    const longCmd = "a".repeat(100);
    const result = extractTarget("Bash", { command: longCmd });
    expect(result).toHaveLength(83); // 80 + "..."
    expect(result!.endsWith("...")).toBe(true);
  });

  it("should extract short commands without truncation", () => {
    expect(extractTarget("Bash", { command: "ls -la" })).toBe("ls -la");
  });

  it("should extract url", () => {
    expect(extractTarget("WebFetch", { url: "https://example.com" })).toBe("https://example.com");
  });

  it("should return undefined when no target found", () => {
    expect(extractTarget("Task", { prompt: "do something" })).toBeUndefined();
  });
});

describe("createR6Request", () => {
  it("should create a well-formed R6 request", () => {
    const r6 = createR6Request("sess-1", "agent-1", "Read", { file_path: "/foo" }, 0, undefined, "standard");

    expect(r6.id).toMatch(/^r6:[a-f0-9]{8}$/);
    expect(r6.timestamp).toBeTruthy();
    expect(r6.rules).toEqual({ auditLevel: "standard", constraints: [] });
    expect(r6.role).toEqual({
      sessionId: "sess-1",
      agentId: "agent-1",
      actionIndex: 0,
      bindingType: "soft-lct",
    });
    expect(r6.request.toolName).toBe("Read");
    expect(r6.request.category).toBe("file_read");
    expect(r6.request.target).toBe("/foo");
    expect(r6.request.inputHash).toMatch(/^[a-f0-9]{16}$/);
    expect(r6.reference).toEqual({
      sessionId: "sess-1",
      prevR6Id: undefined,
      chainPosition: 0,
    });
    expect(r6.resource).toEqual({ approvalRequired: false });
    expect(r6.result).toBeUndefined();
  });

  it("should link to previous R6 request", () => {
    const r6 = createR6Request("s", undefined, "Bash", { command: "ls" }, 5, "r6:prev0001", "minimal");
    expect(r6.reference.prevR6Id).toBe("r6:prev0001");
    expect(r6.reference.chainPosition).toBe(5);
  });
});
