// Chat log component lays out conversation messages for the TUI viewport.
import type { Component } from "@earendil-works/pi-tui";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";
import { sanitizeRenderableText } from "../tui-formatters.js";
import { AssistantMessageComponent } from "./assistant-message.js";
import { BtwInlineMessage } from "./btw-inline-message.js";
import { ToolExecutionComponent } from "./tool-execution.js";
import { UserMessageComponent } from "./user-message.js";

type RepeatableSystemMessage = {
  component: Container;
  textNode: Text;
  baseText: string;
  count: number;
};

type TrackedTool = {
  component: ToolExecutionComponent;
  runId?: string;
  active: boolean;
};

type TrackedAssistantRun = {
  streaming?: AssistantMessageComponent;
  frozen: Set<AssistantMessageComponent>;
  finalized: Set<AssistantMessageComponent>;
  committedText?: string;
  latestText?: string;
};

/** Scrollback container that tracks pending users, streaming assistant runs, tools, and notices. */
export class ChatLog extends Container {
  private readonly maxComponents: number;
  private tools = new Map<string, TrackedTool>();
  private assistantRuns = new Map<string, TrackedAssistantRun>();
  private userComponents = new Map<string, UserMessageComponent>();
  private pendingUsers = new Map<
    string,
    {
      component: UserMessageComponent;
      text: string;
    }
  >();
  private pendingSystemNotices = new Map<string, Container>();
  private btwMessage: BtwInlineMessage | null = null;
  private toolsExpanded = false;
  private repeatableSystemMessage: RepeatableSystemMessage | null = null;

  constructor(maxComponents = 180) {
    super();
    this.maxComponents = Math.max(20, Math.floor(maxComponents));
  }

  // Pruning must clear side maps so future stream/tool updates do not target detached components.
  private dropComponentReferences(component: Component) {
    for (const [toolId, tool] of this.tools.entries()) {
      if (tool.component === component) {
        this.tools.delete(toolId);
      }
    }
    if (component instanceof AssistantMessageComponent) {
      for (const [runId, run] of this.assistantRuns.entries()) {
        if (run.streaming === component) {
          run.streaming = undefined;
        }
        run.frozen.delete(component);
        run.finalized.delete(component);
        this.releaseAssistantRunIfEmpty(runId, run);
      }
    }
    for (const [runId, entry] of this.pendingUsers.entries()) {
      if (entry.component === component) {
        this.pendingUsers.delete(runId);
      }
    }
    for (const [messageId, user] of this.userComponents.entries()) {
      if (user === component) {
        this.userComponents.delete(messageId);
      }
    }
    for (const [runId, entry] of this.pendingSystemNotices.entries()) {
      if (entry === component) {
        this.pendingSystemNotices.delete(runId);
      }
    }
    if (this.btwMessage === component) {
      this.btwMessage = null;
    }
    if (this.repeatableSystemMessage?.component === component) {
      this.repeatableSystemMessage = null;
    }
  }

  private pruneOverflow(protectedComponents?: ReadonlySet<Component>) {
    while (this.children.length > this.maxComponents) {
      // Protect only the inserted prompt, its reply, and tools owned by that run.
      // If owned tools fill the log, evict the oldest tool, never the prompt or reply.
      const oldest = protectedComponents
        ? (this.children.find((component) => !protectedComponents.has(component)) ??
          this.children.find((component) => component instanceof ToolExecutionComponent))
        : this.children[0];
      if (!oldest) {
        return;
      }
      this.removeChild(oldest);
      this.dropComponentReferences(oldest);
    }
  }

  private reserveLiveUserSlot(
    protectedComponents: Set<Component>,
    firstRunComponent: Component | undefined,
    runId?: string,
  ) {
    if (protectedComponents.size <= this.maxComponents) {
      return;
    }

    // Keep live output and the sole reply; completed run history is the
    // first choice when a delayed prompt needs a bounded scrollback slot.
    const streaming = runId ? this.assistantRuns.get(runId)?.streaming : undefined;
    const completedTools = new Set<ToolExecutionComponent>();
    for (const tool of this.tools.values()) {
      if (!tool.active) {
        completedTools.add(tool.component);
      }
    }
    const evictable =
      this.children.find(
        (entry) =>
          entry !== firstRunComponent &&
          entry !== streaming &&
          entry instanceof AssistantMessageComponent &&
          protectedComponents.has(entry),
      ) ??
      this.children.find(
        (entry) =>
          entry !== firstRunComponent &&
          entry instanceof ToolExecutionComponent &&
          completedTools.has(entry) &&
          protectedComponents.has(entry),
      ) ??
      (streaming &&
      firstRunComponent instanceof AssistantMessageComponent &&
      firstRunComponent !== streaming
        ? firstRunComponent
        : undefined) ??
      (firstRunComponent instanceof ToolExecutionComponent && completedTools.has(firstRunComponent)
        ? firstRunComponent
        : undefined) ??
      this.children.find(
        (entry) =>
          entry !== firstRunComponent &&
          entry instanceof ToolExecutionComponent &&
          protectedComponents.has(entry),
      );
    if (evictable) {
      protectedComponents.delete(evictable);
    }
  }

  private append(component: Component) {
    this.addChild(component);
    this.pruneOverflow();
  }

  private appendNonSystem(component: Component) {
    this.repeatableSystemMessage = null;
    this.append(component);
  }

  clearAll() {
    this.clear();
    this.tools.clear();
    this.assistantRuns.clear();
    this.userComponents.clear();
    this.pendingUsers.clear();
    this.pendingSystemNotices.clear();
    this.btwMessage = null;
    this.repeatableSystemMessage = null;
  }

  clearTools() {
    for (const tool of this.tools.values()) {
      this.removeChild(tool.component);
    }
    this.tools.clear();
  }

  clearPendingUsers() {
    for (const entry of this.pendingUsers.values()) {
      this.removeChild(entry.component);
    }
    this.pendingUsers.clear();
  }

  private formatSystemText(text: string, count = 1) {
    const sanitized = sanitizeRenderableText(text);
    const visible = sanitized.trim() || (text ? "(no output)" : "");
    return theme.system(count > 1 ? `${visible} x${count}` : visible);
  }

  private createSystemMessage(text: string): RepeatableSystemMessage {
    const entry = new Container();
    const textNode = new Text(this.formatSystemText(text), 1, 0);
    entry.addChild(new Spacer(1));
    entry.addChild(textNode);
    return {
      component: entry,
      textNode,
      baseText: text,
      count: 1,
    };
  }

  addSystem(text: string, opts?: { coalesceConsecutive?: boolean }) {
    if (
      opts?.coalesceConsecutive &&
      this.repeatableSystemMessage?.baseText === text &&
      this.children[this.children.length - 1] === this.repeatableSystemMessage.component
    ) {
      this.repeatableSystemMessage.count += 1;
      this.repeatableSystemMessage.textNode.setText(
        this.formatSystemText(text, this.repeatableSystemMessage.count),
      );
      return;
    }
    const message = this.createSystemMessage(text);
    this.append(message.component);
    this.repeatableSystemMessage = opts?.coalesceConsecutive ? message : null;
  }

  addPendingSystem(runId: string, text: string) {
    const existing = this.pendingSystemNotices.get(runId);
    if (existing) {
      this.removeChild(existing);
    }
    const message = this.createSystemMessage(text);
    this.pendingSystemNotices.set(runId, message.component);
    this.append(message.component);
  }

  dismissPendingSystem(runId: string) {
    const existing = this.pendingSystemNotices.get(runId);
    if (!existing) {
      return false;
    }
    this.removeChild(existing);
    this.pendingSystemNotices.delete(runId);
    return true;
  }

  addUser(text: string, options?: { messageId?: string }) {
    const previous = options?.messageId ? this.userComponents.get(options.messageId) : undefined;
    if (previous) {
      previous.setText(text);
      return previous;
    }
    const component = new UserMessageComponent(text);
    if (options?.messageId) {
      this.userComponents.set(options.messageId, component);
    }
    this.appendNonSystem(component);
    return component;
  }

  addLiveUser(text: string, options: { messageId: string; runId?: string }) {
    const existing = this.userComponents.get(options.messageId);
    if (existing) {
      existing.setText(text);
      return existing;
    }

    const pending = options.runId ? this.pendingUsers.get(options.runId) : undefined;
    if (pending && options.runId && pending.text === text) {
      pending.component.setText(text);
      this.pendingUsers.delete(options.runId);
      this.userComponents.set(options.messageId, pending.component);
      return pending.component;
    }

    const component = new UserMessageComponent(text);
    this.userComponents.set(options.messageId, component);
    const protectedComponents = new Set<Component>([component]);
    if (options.runId) {
      const run = this.assistantRuns.get(options.runId);
      for (const segment of run?.frozen ?? []) {
        protectedComponents.add(segment);
      }
      const streaming = run?.streaming;
      if (streaming) {
        protectedComponents.add(streaming);
      }
      for (const segment of run?.finalized ?? []) {
        protectedComponents.add(segment);
      }
      for (const tool of this.tools.values()) {
        if (tool.runId === options.runId) {
          protectedComponents.add(tool.component);
        }
      }
    }
    const firstRunComponentIndex = this.children.findIndex((entry) =>
      protectedComponents.has(entry),
    );
    if (firstRunComponentIndex >= 0) {
      const firstRunComponent = this.children[firstRunComponentIndex];
      // Scrollback may evict early reply segments before a peer prompt arrives;
      // anchor before the earliest surviving reply or tool from the same run.
      this.repeatableSystemMessage = null;
      this.children.splice(firstRunComponentIndex, 0, component);
      this.reserveLiveUserSlot(protectedComponents, firstRunComponent, options.runId);
      this.pruneOverflow(protectedComponents);
      return component;
    }
    this.appendNonSystem(component);
    return component;
  }

  addPendingUser(runId: string, text: string) {
    const existing = this.pendingUsers.get(runId);
    if (existing) {
      existing.text = text;
      existing.component.setText(text);
      return existing.component;
    }
    const component = new UserMessageComponent(text);
    this.pendingUsers.set(runId, { component, text });
    this.appendNonSystem(component);
    return component;
  }

  dropPendingUser(runId: string) {
    const existing = this.pendingUsers.get(runId);
    if (!existing) {
      return false;
    }
    this.removeChild(existing.component);
    this.pendingUsers.delete(runId);
    return true;
  }

  // Re-key in place: the gateway can assign its own runId after the optimistic
  // row is rendered. Swap the map key without re-mounting the component so the
  // row keeps its transcript position even if a reply already rendered below it.
  rekeyPendingUser(fromRunId: string, toRunId: string) {
    if (fromRunId === toRunId) {
      return false;
    }
    const existing = this.pendingUsers.get(fromRunId);
    if (!existing) {
      return false;
    }
    this.pendingUsers.delete(fromRunId);
    this.pendingUsers.set(toRunId, existing);
    return true;
  }

  countPendingUsers() {
    return this.pendingUsers.size;
  }

  private resolveRunId(runId?: string) {
    return runId ?? "default";
  }

  private getAssistantRun(runId: string): TrackedAssistantRun {
    let run = this.assistantRuns.get(runId);
    if (!run) {
      run = {
        frozen: new Set(),
        finalized: new Set(),
      };
      this.assistantRuns.set(runId, run);
    }
    return run;
  }

  private releaseAssistantRunIfEmpty(runId: string, run: TrackedAssistantRun) {
    if (
      !run.streaming &&
      run.frozen.size === 0 &&
      run.finalized.size === 0 &&
      run.committedText === undefined &&
      run.latestText === undefined
    ) {
      this.assistantRuns.delete(runId);
    }
  }

  private resolveSingleStreamingRunId(): string | undefined {
    let streamingRunId: string | undefined;
    for (const [runId, run] of this.assistantRuns) {
      if (!run.streaming) {
        continue;
      }
      if (streamingRunId !== undefined) {
        return undefined;
      }
      streamingRunId = runId;
    }
    return streamingRunId;
  }

  private resolveAssistantSegment(runId: string, text: string) {
    const run = this.assistantRuns.get(runId);
    const committed = run?.committedText;
    if (!run || !committed) {
      return text;
    }
    if (text.startsWith(committed)) {
      return text.slice(committed.length).replace(/^(?:\r?\n)+/u, "");
    }

    // A revised provider snapshot cannot be split at an obsolete tool boundary.
    // Drop obsolete segments so the authoritative replacement lands after the tools.
    if (!run.frozen.size) {
      return text;
    }
    for (const component of run.frozen) {
      this.removeChild(component);
    }
    run.frozen.clear();
    if (run.streaming) {
      this.removeChild(run.streaming);
      run.streaming = undefined;
    }
    run.committedText = undefined;
    return text;
  }

  // Tool rows freeze earlier cumulative text so later deltas render below the tool.
  private freezeStreamingAssistants() {
    for (const run of this.assistantRuns.values()) {
      if (!run.streaming) {
        continue;
      }
      run.frozen.add(run.streaming);
      run.committedText = run.latestText ?? "";
      run.streaming = undefined;
    }
  }

  startAssistant(text: string, runId?: string) {
    const effectiveRunId = this.resolveRunId(runId);
    const run = this.getAssistantRun(effectiveRunId);
    run.finalized.clear();
    run.latestText = text;
    const segmentText = this.resolveAssistantSegment(effectiveRunId, text);
    const existing = run.streaming;
    if (existing) {
      existing.setText(segmentText);
      return existing;
    }
    const component = new AssistantMessageComponent(segmentText);
    run.streaming = component;
    this.appendNonSystem(component);
    return component;
  }

  reserveAssistantSlot(runId?: string) {
    const effectiveRunId = this.resolveRunId(runId);
    const existing = this.assistantRuns.get(effectiveRunId)?.streaming;
    if (existing) {
      return existing;
    }
    return this.startAssistant("", runId);
  }

  updateAssistant(text: string, runId?: string) {
    const effectiveRunId = this.resolveRunId(runId);
    const run = this.getAssistantRun(effectiveRunId);
    run.latestText = text;
    const segmentText = this.resolveAssistantSegment(effectiveRunId, text);
    const existing = run.streaming;
    if (!existing) {
      if (!segmentText && run.committedText !== undefined) {
        return;
      }
      this.startAssistant(text, runId);
      return;
    }
    existing.setText(segmentText);
  }

  finalizeAssistant(text: string, runId?: string) {
    const effectiveRunId = this.resolveRunId(runId);
    const run = this.getAssistantRun(effectiveRunId);
    const segmentText = this.resolveAssistantSegment(effectiveRunId, text);
    const existing = run.streaming;
    const finalized = new Set(run.frozen);
    let lastAssistant: AssistantMessageComponent | undefined;
    run.frozen.clear();
    run.committedText = undefined;
    run.latestText = undefined;
    if (existing) {
      if (segmentText) {
        existing.setText(segmentText);
        lastAssistant = existing;
      } else {
        this.removeChild(existing);
      }
      run.streaming = undefined;
    } else if (segmentText) {
      const component = new AssistantMessageComponent(segmentText);
      this.appendNonSystem(component);
      lastAssistant = component;
    }

    if (lastAssistant) {
      finalized.add(lastAssistant);
    }
    for (const segment of finalized) {
      if (!this.children.includes(segment)) {
        finalized.delete(segment);
      }
    }
    if (finalized.size > 0) {
      // Persisted peer prompts can trail finalization; retain every surviving
      // reply segment so full scrollback cannot evict the tool-split tail.
      run.finalized = finalized;
      this.assistantRuns.set(effectiveRunId, run);
    }
    this.releaseAssistantRunIfEmpty(effectiveRunId, run);
  }

  dropAssistant(runId?: string) {
    const effectiveRunId = this.resolveRunId(runId);
    const run = this.assistantRuns.get(effectiveRunId);
    if (!run) {
      return;
    }
    for (const component of run.frozen) {
      this.removeChild(component);
    }
    if (run.streaming) {
      this.removeChild(run.streaming);
    }
    this.assistantRuns.delete(effectiveRunId);
  }

  showBtw(params: { question: string; text: string; isError?: boolean }) {
    if (this.btwMessage) {
      this.btwMessage.setResult(params);
      if (this.children[this.children.length - 1] !== this.btwMessage) {
        this.removeChild(this.btwMessage);
        this.appendNonSystem(this.btwMessage);
      }
      return this.btwMessage;
    }
    const component = new BtwInlineMessage(params);
    this.btwMessage = component;
    this.appendNonSystem(component);
    return component;
  }

  dismissBtw() {
    if (!this.btwMessage) {
      return;
    }
    this.removeChild(this.btwMessage);
    this.btwMessage = null;
  }

  hasVisibleBtw() {
    return this.btwMessage !== null;
  }

  startTool(toolCallId: string, toolName: string, args: unknown, runId?: string) {
    const existing = this.tools.get(toolCallId);
    if (existing) {
      existing.component.setArgs(args);
      return existing.component;
    }
    const owningRunId = runId ?? this.resolveSingleStreamingRunId();
    this.freezeStreamingAssistants();
    const component = new ToolExecutionComponent(toolName, args);
    component.setExpanded(this.toolsExpanded);
    this.tools.set(toolCallId, { component, runId: owningRunId, active: true });
    this.appendNonSystem(component);
    return component;
  }

  updateToolResult(
    toolCallId: string,
    result: unknown,
    opts?: { isError?: boolean; partial?: boolean },
  ) {
    const existing = this.tools.get(toolCallId);
    if (!existing) {
      return;
    }
    if (opts?.partial) {
      existing.active = true;
      existing.component.setPartialResult(result as Record<string, unknown>);
      return;
    }
    existing.active = false;
    existing.component.setResult(result as Record<string, unknown>, {
      isError: opts?.isError,
    });
  }

  setToolsExpanded(expanded: boolean) {
    this.toolsExpanded = expanded;
    for (const tool of this.tools.values()) {
      tool.component.setExpanded(expanded);
    }
  }
}
