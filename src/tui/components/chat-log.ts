// Chat log component lays out conversation messages for the TUI viewport.
import type { Component } from "@earendil-works/pi-tui";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";
import { AssistantMessageComponent } from "./assistant-message.js";
import { BtwInlineMessage } from "./btw-inline-message.js";
import { ToolExecutionComponent } from "./tool-execution.js";
import { UserMessageComponent } from "./user-message.js";

// Tolerates history timestamps slightly before locally pending messages.
const PENDING_HISTORY_CLOCK_SKEW_TOLERANCE_MS = 60_000;

type RepeatableSystemMessage = {
  component: Container;
  textNode: Text;
  baseText: string;
  count: number;
};

/** Scrollback container that tracks pending users, streaming assistant runs, tools, and notices. */
export class ChatLog extends Container {
  private readonly maxComponents: number;
  private toolById = new Map<string, ToolExecutionComponent>();
  private toolRunIds = new Map<string, string>();
  private streamingRuns = new Map<string, AssistantMessageComponent>();
  private frozenAssistants = new Map<string, Set<AssistantMessageComponent>>();
  private committedAssistantText = new Map<string, string>();
  private latestAssistantText = new Map<string, string>();
  private liveUsers = new Map<string, UserMessageComponent>();
  private liveUserSequences = new Map<string, number>();
  private liveEventUserIds = new Set<string>();
  private pendingUsers = new Map<
    string,
    {
      component: UserMessageComponent;
      text: string;
      createdAt: number;
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
    for (const [toolId, tool] of this.toolById.entries()) {
      if (tool === component) {
        this.toolById.delete(toolId);
        this.toolRunIds.delete(toolId);
      }
    }
    for (const [runId, message] of this.streamingRuns.entries()) {
      if (message === component) {
        this.streamingRuns.delete(runId);
      }
    }
    if (component instanceof AssistantMessageComponent) {
      for (const [runId, messages] of this.frozenAssistants.entries()) {
        messages.delete(component);
        if (messages.size === 0) {
          this.frozenAssistants.delete(runId);
        }
      }
    }
    for (const [runId, entry] of this.pendingUsers.entries()) {
      if (entry.component === component) {
        this.pendingUsers.delete(runId);
      }
    }
    for (const [messageId, user] of this.liveUsers.entries()) {
      if (user === component) {
        this.liveUsers.delete(messageId);
        this.liveUserSequences.delete(messageId);
        this.liveEventUserIds.delete(messageId);
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

  private append(component: Component) {
    this.addChild(component);
    this.pruneOverflow();
  }

  private appendNonSystem(component: Component) {
    this.repeatableSystemMessage = null;
    this.append(component);
  }

  clearAll(opts?: { preservePendingUsers?: boolean; preserveLiveUsers?: boolean }) {
    this.clear();
    this.toolById.clear();
    this.toolRunIds.clear();
    this.streamingRuns.clear();
    this.frozenAssistants.clear();
    this.committedAssistantText.clear();
    this.latestAssistantText.clear();
    if (opts?.preserveLiveUsers) {
      // History rows are authoritative snapshots, not in-flight live events.
      // Keeping them would resurrect deleted or switched-away transcript branches.
      for (const messageId of this.liveUsers.keys()) {
        if (!this.liveEventUserIds.has(messageId)) {
          this.liveUsers.delete(messageId);
          this.liveUserSequences.delete(messageId);
        }
      }
    } else {
      this.liveUsers.clear();
      this.liveUserSequences.clear();
      this.liveEventUserIds.clear();
    }
    this.pendingSystemNotices.clear();
    this.btwMessage = null;
    this.repeatableSystemMessage = null;
    if (!opts?.preservePendingUsers) {
      this.pendingUsers.clear();
    }
  }

  clearTools() {
    for (const tool of this.toolById.values()) {
      this.removeChild(tool);
    }
    this.toolById.clear();
    this.toolRunIds.clear();
  }

  restoreLiveUsers(beforeMessageSeq?: number) {
    // Rebuilt history replaces matching IDs in addUser; only live prompts
    // missing from a stale snapshot are restored before the next canonical row.
    for (const messageId of this.liveEventUserIds) {
      const component = this.liveUsers.get(messageId);
      if (!component) {
        this.liveEventUserIds.delete(messageId);
        continue;
      }
      if (this.children.includes(component)) {
        continue;
      }
      if (beforeMessageSeq !== undefined) {
        const messageSeq = this.liveUserSequences.get(messageId);
        if (messageSeq === undefined || messageSeq >= beforeMessageSeq) {
          continue;
        }
      }
      this.appendNonSystem(component);
    }
  }

  restorePendingUsers() {
    for (const entry of this.pendingUsers.values()) {
      if (this.children.includes(entry.component)) {
        continue;
      }
      this.appendNonSystem(entry.component);
    }
  }

  clearPendingUsers() {
    for (const entry of this.pendingUsers.values()) {
      this.removeChild(entry.component);
    }
    this.pendingUsers.clear();
  }

  private formatRepeatedSystemText(text: string, count: number) {
    return count > 1 ? `${text} x${count}` : text;
  }

  private createSystemMessage(text: string): RepeatableSystemMessage {
    const entry = new Container();
    const textNode = new Text(theme.system(text), 1, 0);
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
        theme.system(this.formatRepeatedSystemText(text, this.repeatableSystemMessage.count)),
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

  addUser(text: string, options?: { messageId?: string; messageSeq?: number }) {
    const component = new UserMessageComponent(text);
    if (options?.messageId) {
      this.liveUsers.set(options.messageId, component);
      // Once authoritative history contains this identity it is no longer a
      // missing live event and must not survive a later deletion or branch.
      this.liveEventUserIds.delete(options.messageId);
      if (options.messageSeq !== undefined) {
        this.liveUserSequences.set(options.messageId, options.messageSeq);
      }
    }
    this.appendNonSystem(component);
  }

  addLiveUser(text: string, options: { messageId: string; messageSeq?: number; runId?: string }) {
    this.liveEventUserIds.add(options.messageId);
    if (options.messageSeq !== undefined) {
      this.liveUserSequences.set(options.messageId, options.messageSeq);
    }
    const existing = this.liveUsers.get(options.messageId);
    if (existing) {
      existing.setText(text);
      return existing;
    }

    const pending = options.runId ? this.pendingUsers.get(options.runId) : undefined;
    if (pending && options.runId && pending.text === text) {
      pending.component.setText(text);
      this.pendingUsers.delete(options.runId);
      this.liveUsers.set(options.messageId, pending.component);
      return pending.component;
    }

    const component = new UserMessageComponent(text);
    this.liveUsers.set(options.messageId, component);
    const frozen = options.runId ? this.frozenAssistants.get(options.runId) : undefined;
    const assistant =
      frozen?.values().next().value ??
      (options.runId ? this.streamingRuns.get(options.runId) : undefined);
    const assistantIndex = assistant ? this.children.indexOf(assistant) : -1;
    if (assistant && assistantIndex >= 0) {
      // Transcript broadcasts can trail the first delta; insert their prompt
      // before the existing reply. Preserve both when full scrollback evicts
      // older components so the newly recovered prompt cannot disappear.
      this.repeatableSystemMessage = null;
      this.children.splice(assistantIndex, 0, component);
      const protectedComponents = new Set<Component>([component, assistant]);
      if (options.runId) {
        for (const [toolId, tool] of this.toolById) {
          if (this.toolRunIds.get(toolId) === options.runId) {
            protectedComponents.add(tool);
          }
        }
      }
      this.pruneOverflow(protectedComponents);
      return component;
    }
    this.appendNonSystem(component);
    return component;
  }

  addPendingUser(runId: string, text: string, createdAt = Date.now()) {
    const existing = this.pendingUsers.get(runId);
    if (existing) {
      existing.text = text;
      existing.createdAt = createdAt;
      existing.component.setText(text);
      return existing.component;
    }
    const component = new UserMessageComponent(text);
    this.pendingUsers.set(runId, { component, text, createdAt });
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

  reconcilePendingUsers(
    historyUsers: Array<{
      text: string;
      timestamp?: number | null;
    }>,
  ) {
    // Gateway history may echo a just-submitted local message; remove pending rows when it does.
    const normalizedHistory = historyUsers
      .map((entry) => ({
        text: entry.text.trim(),
        timestamp: typeof entry.timestamp === "number" ? entry.timestamp : null,
      }))
      .filter((entry) => entry.text.length > 0 && entry.timestamp !== null);
    const clearedRunIds: string[] = [];
    for (const [runId, entry] of this.pendingUsers.entries()) {
      const pendingText = entry.text.trim();
      if (!pendingText) {
        continue;
      }
      const matchIndex = normalizedHistory.findIndex(
        (historyEntry) =>
          historyEntry.text === pendingText &&
          (historyEntry.timestamp ?? 0) >=
            entry.createdAt - PENDING_HISTORY_CLOCK_SKEW_TOLERANCE_MS,
      );
      if (matchIndex === -1) {
        continue;
      }
      if (this.children.includes(entry.component)) {
        this.removeChild(entry.component);
      }
      this.pendingUsers.delete(runId);
      clearedRunIds.push(runId);
      normalizedHistory.splice(matchIndex, 1);
    }
    return clearedRunIds;
  }

  countPendingUsers() {
    return this.pendingUsers.size;
  }

  private resolveRunId(runId?: string) {
    return runId ?? "default";
  }

  private resolveAssistantSegment(runId: string, text: string) {
    const committed = this.committedAssistantText.get(runId);
    if (!committed) {
      return text;
    }
    if (text.startsWith(committed)) {
      return text.slice(committed.length).replace(/^(?:\r?\n)+/u, "");
    }

    // A revised provider snapshot cannot be split at an obsolete tool boundary.
    // Drop obsolete segments so the authoritative replacement lands after the tools.
    const frozen = this.frozenAssistants.get(runId);
    if (!frozen?.size) {
      return text;
    }
    for (const component of frozen) {
      this.removeChild(component);
    }
    this.frozenAssistants.delete(runId);
    const streaming = this.streamingRuns.get(runId);
    if (streaming) {
      this.removeChild(streaming);
      this.streamingRuns.delete(runId);
    }
    this.committedAssistantText.delete(runId);
    return text;
  }

  // Tool rows freeze earlier cumulative text so later deltas render below the tool.
  private freezeStreamingAssistants() {
    for (const [runId, component] of this.streamingRuns) {
      let frozen = this.frozenAssistants.get(runId);
      if (!frozen) {
        frozen = new Set();
        this.frozenAssistants.set(runId, frozen);
      }
      frozen.add(component);
      this.committedAssistantText.set(runId, this.latestAssistantText.get(runId) ?? "");
    }
    this.streamingRuns.clear();
  }

  startAssistant(text: string, runId?: string) {
    const effectiveRunId = this.resolveRunId(runId);
    this.latestAssistantText.set(effectiveRunId, text);
    const segmentText = this.resolveAssistantSegment(effectiveRunId, text);
    const existing = this.streamingRuns.get(effectiveRunId);
    if (existing) {
      existing.setText(segmentText);
      return existing;
    }
    const component = new AssistantMessageComponent(segmentText);
    this.streamingRuns.set(effectiveRunId, component);
    this.appendNonSystem(component);
    return component;
  }

  reserveAssistantSlot(runId?: string) {
    const effectiveRunId = this.resolveRunId(runId);
    const existing = this.streamingRuns.get(effectiveRunId);
    if (existing) {
      return existing;
    }
    return this.startAssistant("", runId);
  }

  updateAssistant(text: string, runId?: string) {
    const effectiveRunId = this.resolveRunId(runId);
    this.latestAssistantText.set(effectiveRunId, text);
    const segmentText = this.resolveAssistantSegment(effectiveRunId, text);
    const existing = this.streamingRuns.get(effectiveRunId);
    if (!existing) {
      if (!segmentText && this.committedAssistantText.has(effectiveRunId)) {
        return;
      }
      this.startAssistant(text, runId);
      return;
    }
    existing.setText(segmentText);
  }

  finalizeAssistant(text: string, runId?: string) {
    const effectiveRunId = this.resolveRunId(runId);
    const segmentText = this.resolveAssistantSegment(effectiveRunId, text);
    const existing = this.streamingRuns.get(effectiveRunId);
    this.frozenAssistants.delete(effectiveRunId);
    this.committedAssistantText.delete(effectiveRunId);
    this.latestAssistantText.delete(effectiveRunId);
    if (existing) {
      if (segmentText) {
        existing.setText(segmentText);
      } else {
        this.removeChild(existing);
      }
      this.streamingRuns.delete(effectiveRunId);
      return;
    }
    if (segmentText) {
      this.appendNonSystem(new AssistantMessageComponent(segmentText));
    }
  }

  dropAssistant(runId?: string) {
    const effectiveRunId = this.resolveRunId(runId);
    for (const component of this.frozenAssistants.get(effectiveRunId) ?? []) {
      this.removeChild(component);
    }
    this.frozenAssistants.delete(effectiveRunId);
    this.committedAssistantText.delete(effectiveRunId);
    this.latestAssistantText.delete(effectiveRunId);
    const existing = this.streamingRuns.get(effectiveRunId);
    if (!existing) {
      return;
    }
    this.removeChild(existing);
    this.streamingRuns.delete(effectiveRunId);
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
    const existing = this.toolById.get(toolCallId);
    if (existing) {
      existing.setArgs(args);
      return existing;
    }
    const owningRunId =
      runId ?? (this.streamingRuns.size === 1 ? this.streamingRuns.keys().next().value : undefined);
    this.freezeStreamingAssistants();
    const component = new ToolExecutionComponent(toolName, args);
    component.setExpanded(this.toolsExpanded);
    this.toolById.set(toolCallId, component);
    if (owningRunId) {
      this.toolRunIds.set(toolCallId, owningRunId);
    }
    this.appendNonSystem(component);
    return component;
  }

  updateToolResult(
    toolCallId: string,
    result: unknown,
    opts?: { isError?: boolean; partial?: boolean },
  ) {
    const existing = this.toolById.get(toolCallId);
    if (!existing) {
      return;
    }
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
