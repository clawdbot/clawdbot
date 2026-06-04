import { expect } from "vitest";

/**
 * Assertion helpers for built-in filesystem tool tests.
 */
type TextResultBlock = { type: string; text?: string };

/** Extracts the first text block from a tool result. */
export function getTextContent(result?: { content?: TextResultBlock[] }) {
  const textBlock = result?.content?.find((block) => block.type === "text");
  return textBlock?.text ?? "";
}

function expectTool<T extends { name: string }>(tools: T[], name: string): T {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) {
    throw new Error(`expected tool "${name}" in [${tools.map((entry) => entry.name).join(", ")}]`);
  }
  return tool;
}

/** Asserts read/write/edit tools are present and returns them by name. */
export function expectReadWriteEditTools<T extends { name: string }>(tools: T[]) {
  const names = tools.map((tool) => tool.name);
  expect(names).toContain("read");
  expect(names).toContain("write");
  expect(names).toContain("edit");
  return {
    readTool: expectTool(tools, "read"),
    writeTool: expectTool(tools, "write"),
    editTool: expectTool(tools, "edit"),
  };
}

/** Asserts read/write tools are present and returns them by name. */
export function expectReadWriteTools<T extends { name: string }>(tools: T[]) {
  const names = tools.map((tool) => tool.name);
  expect(names).toContain("read");
  expect(names).toContain("write");
  return {
    readTool: expectTool(tools, "read"),
    writeTool: expectTool(tools, "write"),
  };
}
