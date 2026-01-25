/**
 * W&B Weave Plugin for Clawdbot
 *
 * Provides LLM observability and tracing capabilities
 * through integration with Weights & Biases Weave.
 *
 * Features:
 * - Automatic tracing of agent runs and tool calls
 * - Full system prompt capture via llm_request hook
 * - Multi-turn conversation tracing
 * - Session-level observability
 *
 * @see https://weave-docs.wandb.ai/
 */

import type { ClawdbotPluginApi } from 'clawdbot/plugin-sdk';
import type { WeavePluginConfig } from './src/types.js';
import { normalizeConfig } from './src/config.js';
import { initializeWeaveClient } from './src/client.js';
import { registerHooks } from './src/hooks.js';

/**
 * Clawdbot plugin definition
 */
const pluginDefinition = {
  id: 'weave',
  name: 'W&B Weave',
  description: 'Weights & Biases Weave integration for LLM observability and tracing',
  version: '0.1.0',

  // Synchronous register - Clawdbot ignores async registration!
  register(api: ClawdbotPluginApi) {
    const logger = api.logger;

    // Get and validate plugin config
    const rawConfig = api.pluginConfig as Partial<WeavePluginConfig> | undefined;

    if (!rawConfig?.apiKey) {
      logger.warn(
        '[weave] Plugin disabled: No API key configured. Set plugins.entries.weave.config.apiKey in your config.'
      );
      return;
    }

    let config: WeavePluginConfig;
    try {
      config = normalizeConfig(rawConfig);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[weave] Configuration error: ${msg}`);
      return;
    }

    // Initialize Weave client synchronously (starts the async init in background)
    // The client will be ready by the time hooks fire
    initializeWeaveClient(config)
      .then(() => {
        logger.info(`[weave] Initialized for ${config.entity}/${config.project}`);
      })
      .catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`[weave] Failed to initialize: ${msg}`);
      });

    // Register observability hooks (they'll wait for client to be ready)
    registerHooks(api, config);
    logger.info('[weave] Observability hooks registered');

    // Log feature status
    const features = [];
    if (config.autoTrace) features.push('auto-tracing');
    if (config.traceToolCalls) features.push('tool-tracing');
    if (config.traceSessions) features.push('session-tracking');
    if (features.length > 0) {
      logger.info(`[weave] Features enabled: ${features.join(', ')}`);
    }
  },
};

export default pluginDefinition;
