import { describe, expect, it } from "vitest";
import { detectToolCallShapedText } from "./tool-call-shaped-text.js";

describe("detectToolCallShapedText", () => {
  it("detects standalone OpenAI-style function-call JSON", () => {
    expect(detectToolCallShapedText('{"name":"read","arguments":{"path":"README.md"}}')).toEqual({
      kind: "json_tool_call",
      toolName: "read",
    });
  });

  it("detects fenced tool_calls JSON", () => {
    expect(
      detectToolCallShapedText(
        '```json\n{"tool_calls":[{"function":{"name":"web_search","arguments":{"query":"x"}}}]}\n```',
      ),
    ).toEqual({ kind: "json_tool_call", toolName: "web_search" });
  });

  it("detects XML and ReAct-style tool text", () => {
    expect(
      detectToolCallShapedText(
        "<tool_call><function=read><parameter=path>README.md</parameter></function></tool_call>",
      ),
    ).toEqual({ kind: "xml_tool_call", toolName: "read" });
    expect(detectToolCallShapedText('Action: exec\nAction Input: {"command":"pwd"}')).toEqual({
      kind: "react_action",
      toolName: "exec",
    });
  });

  it("detects legacy uppercase TOOL_CALL assistant text", () => {
    expect(
      detectToolCallShapedText(
        '[TOOL_CALL]{tool => "web_search", args => {"query":"NET stock price"}}[/TOOL_CALL]',
      ),
    ).toEqual({ kind: "bracketed_tool_call", toolName: "web_search" });
  });

  it("ignores normal JSON and prose mentions", () => {
    expect(detectToolCallShapedText('{"status":"ok","message":"done"}')).toBeNull();
    expect(detectToolCallShapedText("Use tool_call tags only in examples.")).toBeNull();
    expect(detectToolCallShapedText("Use <tool_call> to invoke tools.")).toBeNull();
  });
});
