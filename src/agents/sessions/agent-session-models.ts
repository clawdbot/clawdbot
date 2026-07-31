import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  modelsAreEqual,
} from "@openclaw/ai/internal/runtime";
import type { Model } from "../../llm/types.js";
import type { ThinkingLevel } from "../runtime/index.js";
import { AgentSessionPrompting } from "./agent-session-prompting.js";
import type { ModelCycleResult } from "./agent-session-types.js";
import { DEFAULT_THINKING_LEVEL } from "./defaults.js";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

export abstract class AgentSessionModels extends AgentSessionPrompting {
  // =========================================================================
  // Model Management
  // =========================================================================

  private async emitModelSelect(
    nextModel: Model,
    previousModel: Model | undefined,
    source: "set" | "cycle",
  ): Promise<void> {
    if (modelsAreEqual(previousModel, nextModel)) {
      return;
    }
    await this.currentExtensionRunner.emit({
      type: "model_select",
      model: nextModel,
      previousModel,
      source,
    });
  }

  private async applyModelSwitch(
    model: Model,
    thinkingLevel: ThinkingLevel,
    source: "set" | "cycle",
  ): Promise<void> {
    const previousModel = this.model;
    this.agent.state.model = model;
    this.sessionManager.appendModelChange(model.provider, model.id);
    this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
    this.setThinkingLevel(thinkingLevel);
    await this.emitModelSelect(model, previousModel, source);
  }

  /**
   * Set model directly.
   * Validates that auth is configured, saves to session and settings.
   * @throws Error if no auth is configured for the model
   */
  async setModel(model: Model): Promise<void> {
    if (!this.sessionModelRegistry.hasConfiguredAuth(model)) {
      throw new Error(`No API key for ${model.provider}/${model.id}`);
    }

    const thinkingLevel = this.getThinkingLevelForModelSwitch();
    await this.applyModelSwitch(model, thinkingLevel, "set");
  }

  /**
   * Cycle to next/previous model.
   * Uses scoped models (from --models flag) if available, otherwise all available models.
   * @param direction - "forward" (default) or "backward"
   * @returns The new model info, or undefined if only one model available
   */
  async cycleModel(
    direction: "forward" | "backward" = "forward",
  ): Promise<ModelCycleResult | undefined> {
    if (this.scopedModelEntries.length > 0) {
      return this.cycleScopedModel(direction);
    }
    return this.cycleAvailableModel(direction);
  }

  private async cycleScopedModel(
    direction: "forward" | "backward",
  ): Promise<ModelCycleResult | undefined> {
    const scopedModels = this.scopedModelEntries.filter((scoped) =>
      this.sessionModelRegistry.hasConfiguredAuth(scoped.model),
    );
    if (scopedModels.length <= 1) {
      return undefined;
    }

    const currentModel = this.model;
    let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

    if (currentIndex === -1) {
      currentIndex = 0;
    }
    const len = scopedModels.length;
    const nextIndex =
      direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
    const next = scopedModels.at(nextIndex);
    if (!next) {
      throw new Error("Scoped model cycle produced an invalid index");
    }
    const thinkingLevel = this.getThinkingLevelForModelSwitch(next.thinkingLevel);

    // Apply thinking level.
    // - Explicit scoped model thinking level overrides current session level
    // - Undefined scoped model thinking level inherits the current session preference
    // setThinkingLevel clamps to model capabilities.
    await this.applyModelSwitch(next.model, thinkingLevel, "cycle");

    return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
  }

  private async cycleAvailableModel(
    direction: "forward" | "backward",
  ): Promise<ModelCycleResult | undefined> {
    const availableModels = this.sessionModelRegistry.getAvailable();
    if (availableModels.length <= 1) {
      return undefined;
    }

    const currentModel = this.model;
    let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

    if (currentIndex === -1) {
      currentIndex = 0;
    }
    const len = availableModels.length;
    const nextIndex =
      direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
    const nextModel = availableModels.at(nextIndex);
    if (!nextModel) {
      throw new Error("Available model cycle produced an invalid index");
    }

    const thinkingLevel = this.getThinkingLevelForModelSwitch();
    await this.applyModelSwitch(nextModel, thinkingLevel, "cycle");

    return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
  }

  // =========================================================================
  // Thinking Level Management
  // =========================================================================

  /**
   * Set thinking level.
   * Clamps to model capabilities based on available thinking levels.
   * Saves to session and settings only if the level actually changes.
   */
  setThinkingLevel(level: ThinkingLevel): void {
    const availableLevels = this.getAvailableThinkingLevels();
    const effectiveLevel = availableLevels.includes(level) ? level : this.clampThinkingLevel(level);

    // Only persist if actually changing
    const previousLevel = this.agent.state.thinkingLevel;
    const isChanging = effectiveLevel !== previousLevel;

    this.agent.state.thinkingLevel = effectiveLevel;

    if (isChanging) {
      this.sessionManager.appendThinkingLevelChange(effectiveLevel);
      if (this.supportsThinking() || effectiveLevel !== "off") {
        this.settingsManager.setDefaultThinkingLevel(effectiveLevel);
      }
      this.emit({ type: "thinking_level_changed", level: effectiveLevel });
      void this.currentExtensionRunner.emit({
        type: "thinking_level_select",
        level: effectiveLevel,
        previousLevel,
      });
    }
  }

  /**
   * Cycle to next thinking level.
   * @returns New level, or undefined if model doesn't support thinking
   */
  cycleThinkingLevel(): ThinkingLevel | undefined {
    if (!this.supportsThinking()) {
      return undefined;
    }

    const levels = this.getAvailableThinkingLevels();
    const currentIndex = levels.indexOf(this.thinkingLevel);
    const nextIndex = (currentIndex + 1) % levels.length;
    const nextLevel = levels.at(nextIndex);
    if (!nextLevel) {
      return undefined;
    }

    this.setThinkingLevel(nextLevel);
    return nextLevel;
  }

  /**
   * Get available thinking levels for current model.
   * The provider will clamp to what the specific model supports internally.
   */
  getAvailableThinkingLevels(): ThinkingLevel[] {
    if (!this.model) {
      return THINKING_LEVELS;
    }
    return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
  }

  /**
   * Check if current model supports thinking/reasoning.
   */
  supportsThinking(): boolean {
    return Boolean(this.model?.reasoning);
  }

  private getThinkingLevelForModelSwitch(explicitLevel?: ThinkingLevel): ThinkingLevel {
    if (explicitLevel !== undefined) {
      return explicitLevel;
    }
    if (!this.supportsThinking()) {
      return this.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
    }
    return this.thinkingLevel;
  }

  private clampThinkingLevel(level: ThinkingLevel): ThinkingLevel {
    return this.model ? (clampThinkingLevel(this.model, level) as ThinkingLevel) : "off";
  }

  // =========================================================================
  // Queue Mode Management
  // =========================================================================

  /**
   * Set steering message mode.
   * Saves to settings.
   */
  setSteeringMode(mode: "all" | "one-at-a-time"): void {
    this.agent.steeringMode = mode;
    this.settingsManager.setSteeringMode(mode);
  }

  /**
   * Set follow-up message mode.
   * Saves to settings.
   */
  setFollowUpMode(mode: "all" | "one-at-a-time"): void {
    this.agent.followUpMode = mode;
    this.settingsManager.setFollowUpMode(mode);
  }
}
