import { Container, Spacer, Text } from "@mariozechner/pi-tui";
import { theme } from "../theme/theme.js";
import { AssistantMessageComponent } from "./assistant-message.js";
import { ToolExecutionComponent } from "./tool-execution.js";
import { UserMessageComponent } from "./user-message.js";

export class ChatLog extends Container {
  private toolById = new Map<string, ToolExecutionComponent>();
  private streamingAssistant: AssistantMessageComponent | null = null;
  private streamingRunId: string | null = null;
  private streamingText: string | null = null;
  private toolsExpanded = false;

  clearAll() {
    this.clear();
    this.toolById.clear();
    this.streamingAssistant = null;
    this.streamingRunId = null;
    this.streamingText = null;
  }

  addSystem(text: string) {
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.system(text), 1, 0));
  }

  addUser(text: string) {
    this.addChild(new UserMessageComponent(text));
  }

  startAssistant(text: string, runId?: string) {
    const component = new AssistantMessageComponent(text);
    this.streamingAssistant = component;
    this.streamingRunId = runId ?? null;
    this.streamingText = text;
    this.addChild(component);
    return component;
  }

  updateAssistant(text: string, runId?: string) {
    if (
      !this.streamingAssistant ||
      (runId && this.streamingRunId && runId !== this.streamingRunId)
    ) {
      this.startAssistant(text, runId);
      return;
    }
    this.streamingText = text;
    this.streamingAssistant.setText(text);
  }

  getStreamingText(runId?: string) {
    if (!this.streamingAssistant) return null;
    if (runId && this.streamingRunId && runId !== this.streamingRunId) {
      return null;
    }
    return this.streamingText;
  }

  finalizeAssistant(text: string, runId?: string) {
    if (
      this.streamingAssistant &&
      (!runId || runId === this.streamingRunId || text === this.streamingText)
    ) {
      this.streamingText = text;
      this.streamingAssistant.setText(text);
    } else {
      this.startAssistant(text, runId);
    }
    this.streamingAssistant = null;
    this.streamingRunId = null;
    this.streamingText = null;
  }

  startTool(toolCallId: string, toolName: string, args: unknown) {
    const existing = this.toolById.get(toolCallId);
    if (existing) {
      existing.setArgs(args);
      return existing;
    }
    const component = new ToolExecutionComponent(toolName, args);
    component.setExpanded(this.toolsExpanded);
    this.toolById.set(toolCallId, component);
    this.addChild(component);
    return component;
  }

  updateToolArgs(toolCallId: string, args: unknown) {
    const existing = this.toolById.get(toolCallId);
    if (!existing) return;
    existing.setArgs(args);
  }

  updateToolResult(
    toolCallId: string,
    result: unknown,
    opts?: { isError?: boolean; partial?: boolean },
  ) {
    const existing = this.toolById.get(toolCallId);
    if (!existing) return;
    if (opts?.partial) {
      existing.setPartialResult(result as Record<string, unknown>);
      return;
    }
    existing.setResult(result as Record<string, unknown>, {
      isError: opts?.isError,
    });
  }

  setToolsExpanded(expanded: boolean) {
    this.toolsExpanded = expanded;
    for (const tool of this.toolById.values()) {
      tool.setExpanded(expanded);
    }
  }
}
