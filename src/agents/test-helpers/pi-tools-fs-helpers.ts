import { expect } from "vitest";

type TextResultBlock = { type: string; text?: string };

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

export function expectReadWriteEditTools<T extends { name: string }>(tools: T[]) {
  expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["read", "write", "edit"]));
  return {
    readTool: expectTool(tools, "read"),
    writeTool: expectTool(tools, "write"),
    editTool: expectTool(tools, "edit"),
  };
}

export function expectReadWriteTools<T extends { name: string }>(tools: T[]) {
  expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["read", "write"]));
  return {
    readTool: expectTool(tools, "read"),
    writeTool: expectTool(tools, "write"),
  };
}
