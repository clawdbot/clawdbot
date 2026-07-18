import { readFileSync } from "node:fs";
import type { ImageContent, TextContent } from "../../llm/types.js";
import { attachRuntimeUserTurnTranscriptContext } from "../../sessions/user-turn-transcript-runtime-context.js";
import type {
  PersistedUserTurnMessage,
  UserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.types.js";
import type { AgentMessage } from "../runtime/index.js";
import { stripFrontmatter } from "../utils/frontmatter.js";
import { AgentSessionBase } from "./agent-session-base.js";
import type { PromptOptions } from "./agent-session-types.js";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.js";
import type { CustomMessage } from "./messages.js";
import { expandPromptTemplate } from "./prompt-templates.js";
import type { ResourceLoader } from "./resource-loader.js";

type PostAgentRunAction = "continue" | "settled" | "handoff";

export abstract class AgentSessionPrompting extends AgentSessionBase {
  // =========================================================================
  // Prompting
  // =========================================================================

  private async runAgentPrompt(messages: AgentMessage | AgentMessage[]): Promise<void> {
    let endedForTurnHandoff = false;
    try {
      await this.agent.prompt(messages);
      while (true) {
        const action = await this.handlePostAgentRun();
        if (action !== "continue") {
          endedForTurnHandoff = action === "handoff";
          break;
        }
        await this.agent.continue();
      }
    } finally {
      this.systemPromptOverride = undefined;
      this.flushPendingBashMessages();
      // Consume handoff state before callbacks can start a nested run and set it again.
      endedForTurnHandoff ||= this.lastRunEndedForTurnHandoff;
      this.lastRunEndedForTurnHandoff = false;
      // Failed or aborted runs can still be idle; only handoff leaves external delivery pending.
      if (!endedForTurnHandoff) {
        await this.currentExtensionRunner.emit({ type: "agent_settled" });
      }
    }
  }

  private async handlePostAgentRun(): Promise<PostAgentRunAction> {
    const msg = this.lastAssistantMessage;
    this.lastAssistantMessage = undefined;
    const endedForTurnHandoff = this.lastRunEndedForTurnHandoff;
    this.lastRunEndedForTurnHandoff = false;
    if (endedForTurnHandoff) {
      // External delivery owns the next run after a deliberate turn handoff.
      return "handoff";
    }
    if (!msg) {
      return "settled";
    }

    if (this.isRetryableError(msg) && (await this.prepareRetry(msg))) {
      return "continue";
    }

    if (msg.stopReason === "error" && this.retryCount > 0) {
      this.emit({
        type: "auto_retry_end",
        success: false,
        attempt: this.retryCount,
        finalError: msg.errorMessage,
      });
      this.retryCount = 0;
    }

    if (await this.checkCompaction(msg)) {
      return "continue";
    }

    // Messages queued by agent_end handlers arrive after the loop's final queue drain.
    return this.agent.hasQueuedMessages() ? "continue" : "settled";
  }

  private createUserContent(
    text: string,
    images?: ImageContent[],
  ): Array<TextContent | ImageContent> {
    return [{ type: "text", text }, ...(images ?? [])];
  }

  /**
   * Send a prompt to the agent.
   * - Handles extension commands immediately, even during streaming
   * - Expands file-based prompt templates by default
   * - During streaming, queues via steer() or followUp() based on streamingBehavior option
   * - Validates model and API key before sending (when not streaming)
   * @throws Error if streaming and no streamingBehavior specified
   * @throws Error if no model selected or no API key available (when not streaming)
   */
  async prompt(text: string, options?: PromptOptions): Promise<void> {
    const expandPromptTemplates = options?.expandPromptTemplates ?? true;
    const preflightResult = options?.preflightResult;
    let messages: AgentMessage[] | undefined;

    try {
      // Handle extension commands first (execute immediately, even during streaming)
      // Extension commands manage their own LLM interaction via the session API.
      if (expandPromptTemplates && text.startsWith("/")) {
        const handled = await this.tryExecuteExtensionCommand(text);
        if (handled) {
          // Extension command executed, no prompt to send
          preflightResult?.(true);
          return;
        }
      }

      // Emit input event for extension interception (before skill/template expansion)
      let currentText = text;
      let currentImages = options?.images;
      if (this.currentExtensionRunner.hasHandlers("input")) {
        const inputResult = await this.currentExtensionRunner.emitInput(
          currentText,
          currentImages,
          options?.source ?? "interactive",
        );
        if (inputResult.action === "handled") {
          preflightResult?.(true);
          return;
        }
        if (inputResult.action === "transform") {
          currentText = inputResult.text;
          currentImages = inputResult.images ?? currentImages;
        }
      }

      // Expand skill commands (/skill:name args) and prompt templates (/template args)
      let expandedText = currentText;
      if (expandPromptTemplates) {
        expandedText = this.expandSkillCommand(expandedText);
        expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
      }

      // If streaming, queue via steer() or followUp() based on option
      if (this.isStreaming) {
        if (!options?.streamingBehavior) {
          throw new Error(
            "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
          );
        }
        if (options.streamingBehavior === "followUp") {
          await this.queueFollowUp(expandedText, currentImages);
        } else {
          await this.queueSteer(expandedText, currentImages);
        }
        preflightResult?.(true);
        return;
      }

      // Flush any pending bash messages before the new prompt
      this.flushPendingBashMessages();

      // Validate model
      if (!this.model) {
        throw new Error(formatNoModelSelectedMessage());
      }

      if (!this.sessionModelRegistry.hasConfiguredAuth(this.model)) {
        const isOAuth = this.sessionModelRegistry.isUsingOAuth(this.model);
        if (isOAuth) {
          throw new Error(
            `Authentication failed for "${this.model.provider}". ` +
              `Credentials may have expired or network is unavailable. ` +
              `Run '/login ${this.model.provider}' to re-authenticate.`,
          );
        }
        throw new Error(formatNoApiKeyFoundMessage(this.model.provider));
      }

      // Check if we need to compact before sending (catches aborted responses).
      // The pending user prompt below starts the next run; no intermediate continuation is needed.
      const lastAssistant = this.findLastAssistantMessage();
      if (lastAssistant) {
        await this.checkCompaction(lastAssistant, false);
      }

      // Build messages array (custom message if any, then user message)
      messages = [];

      // Add user message
      messages.push({
        role: "user",
        content: this.createUserContent(expandedText, currentImages),
        timestamp: Date.now(),
      });

      // Inject any pending "nextTurn" messages as context alongside the user message
      for (const msg of this.pendingNextTurnMessages) {
        messages.push(msg);
      }
      this.pendingNextTurnMessages = [];

      // Emit before_agent_start extension event
      const result = await this.currentExtensionRunner.emitBeforeAgentStart(
        expandedText,
        currentImages,
        this.baseSystemPrompt,
        this.baseSystemPromptOptions,
      );
      // Add all custom messages from extensions
      if (result?.messages) {
        for (const msg of result.messages) {
          messages.push({
            role: "custom",
            customType: msg.customType,
            content: msg.content,
            display: msg.display,
            details: msg.details,
            timestamp: Date.now(),
          });
        }
      }
      // Apply extension-modified system prompt, or reset to base
      if (result?.systemPrompt !== undefined) {
        this.systemPromptOverride = result.systemPrompt;
        this.agent.state.systemPrompt = result.systemPrompt;
      } else {
        // Ensure we're using the base prompt (in case previous turn had modifications)
        this.systemPromptOverride = undefined;
        this.agent.state.systemPrompt = this.baseSystemPrompt;
      }
    } catch (error) {
      preflightResult?.(false);
      throw error;
    }

    if (!messages) {
      return;
    }

    preflightResult?.(true);
    await this.runAgentPrompt(messages);
  }

  /**
   * Try to execute an extension command. Returns true if command was found and executed.
   */
  private async tryExecuteExtensionCommand(text: string): Promise<boolean> {
    // Parse command name and args
    const spaceIndex = text.indexOf(" ");
    const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
    const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

    const command = this.currentExtensionRunner.getCommand(commandName);
    if (!command) {
      return false;
    }

    // Get command context from extension runner (includes session control methods)
    const ctx = this.currentExtensionRunner.createCommandContext();

    try {
      await command.handler(args, ctx);
      return true;
    } catch (err) {
      // Emit error via extension runner
      this.currentExtensionRunner.emitError({
        extensionPath: `command:${commandName}`,
        event: "command",
        error: err instanceof Error ? err.message : String(err),
      });
      return true;
    }
  }

  /**
   * Expand skill commands (/skill:name args) to their full content.
   * Returns the expanded text, or the original text if not a skill command or skill not found.
   * Emits errors via extension runner if file read fails.
   */
  private expandSkillCommand(text: string): string {
    if (!text.startsWith("/skill:")) {
      return text;
    }

    const spaceIndex = text.indexOf(" ");
    const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
    const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

    const skill = this.sessionResourceLoader.getSkills().skills.find((s) => s.name === skillName);
    if (!skill) {
      return text;
    } // Unknown skill, pass through

    try {
      const content = readFileSync(skill.filePath, "utf-8");
      const body = stripFrontmatter(content).trim();
      const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
      return args ? `${skillBlock}\n\n${args}` : skillBlock;
    } catch (err) {
      // Emit error like extension commands do
      this.currentExtensionRunner.emitError({
        extensionPath: skill.filePath,
        event: "skill_expansion",
        error: err instanceof Error ? err.message : String(err),
      });
      return text; // Return original on error
    }
  }

  /**
   * Queue a steering message while the agent is running.
   * Delivered after the current assistant turn finishes executing its tool calls,
   * before the next LLM call.
   * Expands skill commands and prompt templates. Errors on extension commands.
   * @param images Optional image attachments to include with the message
   * @param userTurnTranscriptRecorder Prepared channel fields for transcript-only persistence
   * @throws Error if text is an extension command
   */
  async steer(
    text: string,
    images?: ImageContent[],
    userTurnTranscriptRecorder?: UserTurnTranscriptRecorder,
  ): Promise<void> {
    // Check for extension commands (cannot be queued)
    if (text.startsWith("/")) {
      this.throwIfExtensionCommand(text);
    }

    // Expand skill commands and prompt templates
    let expandedText = this.expandSkillCommand(text);
    expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

    const preparedMessage = await userTurnTranscriptRecorder?.resolveMessage();
    await this.queueSteer(
      expandedText,
      images,
      preparedMessage && userTurnTranscriptRecorder
        ? { message: preparedMessage, recorder: userTurnTranscriptRecorder }
        : undefined,
    );
  }

  /**
   * Queue a follow-up message to be processed after the agent finishes.
   * Delivered only when agent has no more tool calls or steering messages.
   * Expands skill commands and prompt templates. Errors on extension commands.
   * @param images Optional image attachments to include with the message
   * @throws Error if text is an extension command
   */
  async followUp(text: string, images?: ImageContent[]): Promise<void> {
    // Check for extension commands (cannot be queued)
    if (text.startsWith("/")) {
      this.throwIfExtensionCommand(text);
    }

    // Expand skill commands and prompt templates
    let expandedText = this.expandSkillCommand(text);
    expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

    await this.queueFollowUp(expandedText, images);
  }

  /**
   * Internal: Queue a steering message (already expanded, no extension command check).
   */
  private async queueSteer(
    text: string,
    images?: ImageContent[],
    transcriptContext?: {
      message: PersistedUserTurnMessage;
      recorder: UserTurnTranscriptRecorder;
    },
  ): Promise<void> {
    this.steeringMessages.push(text);
    this.emitQueueUpdate();
    const runtimeMessage = {
      role: "user",
      content: this.createUserContent(text, images),
      timestamp: Date.now(),
    } satisfies PersistedUserTurnMessage;
    this.agent.steer(
      transcriptContext
        ? attachRuntimeUserTurnTranscriptContext(runtimeMessage, transcriptContext)
        : runtimeMessage,
    );
  }

  /**
   * Internal: Queue a follow-up message (already expanded, no extension command check).
   */
  private async queueFollowUp(text: string, images?: ImageContent[]): Promise<void> {
    this.followUpMessages.push(text);
    this.emitQueueUpdate();
    this.agent.followUp({
      role: "user",
      content: this.createUserContent(text, images),
      timestamp: Date.now(),
    });
  }

  /**
   * Throw an error if the text is an extension command.
   */
  private throwIfExtensionCommand(text: string): void {
    const spaceIndex = text.indexOf(" ");
    const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
    const command = this.currentExtensionRunner.getCommand(commandName);

    if (command) {
      throw new Error(
        `Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
      );
    }
  }

  /**
   * Send a custom message to the session. Creates a CustomMessageEntry.
   *
   * Handles three cases:
   * - Streaming: queues message, processed when loop pulls from queue
   * - Not streaming + triggerTurn: appends to state/session, starts new turn
   * - Not streaming + no trigger: appends to state/session, no turn
   *
   * @param message Custom message with customType, content, display, details
   * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
   * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
   */
  async sendCustomMessage<T = unknown>(
    message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): Promise<void> {
    const appMessage = {
      role: "custom" as const,
      customType: message.customType,
      content: message.content,
      display: message.display,
      details: message.details,
      timestamp: Date.now(),
    } satisfies CustomMessage<T>;
    if (options?.deliverAs === "nextTurn") {
      this.pendingNextTurnMessages.push(appMessage);
    } else if (this.isStreaming) {
      if (options?.deliverAs === "followUp") {
        this.agent.followUp(appMessage);
      } else {
        this.agent.steer(appMessage);
      }
    } else if (options?.triggerTurn) {
      await this.runAgentPrompt(appMessage);
    } else {
      this.agent.state.messages.push(appMessage);
      this.sessionManager.appendCustomMessageEntry(
        message.customType,
        message.content,
        message.display,
        message.details,
      );
      this.emit({ type: "message_start", message: appMessage });
      this.emit({ type: "message_end", message: appMessage });
    }
  }

  /**
   * Send a user message to the agent. Always triggers a turn.
   * When the agent is streaming, use deliverAs to specify how to queue the message.
   *
   * @param content User message content (string or content array)
   * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
   */
  async sendUserMessage(
    content: string | (TextContent | ImageContent)[],
    options?: { deliverAs?: "steer" | "followUp" },
  ): Promise<void> {
    // Normalize content to text string + optional images
    let text: string;
    let images: ImageContent[] | undefined;

    if (typeof content === "string") {
      text = content;
    } else {
      const textParts: string[] = [];
      images = [];
      for (const part of content) {
        if (part.type === "text") {
          textParts.push(part.text);
        } else {
          images.push(part);
        }
      }
      text = textParts.join("\n");
      if (images.length === 0) {
        images = undefined;
      }
    }

    // Use prompt() with expandPromptTemplates: false to skip command handling and template expansion
    await this.prompt(text, {
      expandPromptTemplates: false,
      streamingBehavior: options?.deliverAs,
      images,
      source: "extension",
    });
  }

  /**
   * Clear all queued messages and return them.
   * Useful for restoring to editor when user aborts.
   * @returns Object with steering and followUp arrays
   */
  clearQueue(): { steering: string[]; followUp: string[] } {
    const steering = [...this.steeringMessages];
    const followUp = [...this.followUpMessages];
    this.steeringMessages = [];
    this.followUpMessages = [];
    this.agent.clearAllQueues();
    this.emitQueueUpdate();
    return { steering, followUp };
  }

  /** Number of pending messages (includes both steering and follow-up) */
  get pendingMessageCount(): number {
    return this.steeringMessages.length + this.followUpMessages.length;
  }

  /** Get pending steering messages (read-only) */
  getSteeringMessages(): readonly string[] {
    return this.steeringMessages;
  }

  /** Get pending follow-up messages (read-only) */
  getFollowUpMessages(): readonly string[] {
    return this.followUpMessages;
  }

  get resourceLoader(): ResourceLoader {
    return this.sessionResourceLoader;
  }

  /** Abort the current run; yield callers pass a turnHandoff reason to skip interruption guidance. */
  async abort(reason?: unknown): Promise<void> {
    this.abortRetry();
    this.agent.abort(reason);
    await this.agent.waitForIdle();
  }
}
