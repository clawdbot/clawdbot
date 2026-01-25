/**
 * W&B Weave Plugin Configuration
 */

import type { WeavePluginConfig } from './types.js';

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: Partial<WeavePluginConfig> = {
  project: 'clawdbot',
  autoTrace: true,
  traceToolCalls: true,
  traceSessions: true,
  sampleRate: 1.0,
  debug: false,
};

/**
 * Validates and normalizes plugin configuration
 */
export function normalizeConfig(config: Partial<WeavePluginConfig>): WeavePluginConfig {
  const normalized: WeavePluginConfig = {
    apiKey: config.apiKey ?? '',
    entity: config.entity ?? '',
    project: config.project ?? DEFAULT_CONFIG.project!,
    autoTrace: config.autoTrace ?? DEFAULT_CONFIG.autoTrace,
    traceToolCalls: config.traceToolCalls ?? DEFAULT_CONFIG.traceToolCalls,
    traceSessions: config.traceSessions ?? DEFAULT_CONFIG.traceSessions,
    baseUrl: config.baseUrl,
    sampleRate: config.sampleRate ?? DEFAULT_CONFIG.sampleRate,
    debug: config.debug ?? DEFAULT_CONFIG.debug,
  };

  // Validate required fields
  if (!normalized.apiKey) {
    throw new Error('Weave plugin requires apiKey configuration');
  }
  if (!normalized.entity) {
    throw new Error('Weave plugin requires entity configuration');
  }

  // Validate sample rate
  if (normalized.sampleRate !== undefined) {
    if (normalized.sampleRate < 0 || normalized.sampleRate > 1) {
      throw new Error('Weave plugin sampleRate must be between 0 and 1');
    }
  }

  return normalized;
}

/**
 * Determines if a trace should be sampled based on sample rate
 */
export function shouldSample(sampleRate: number): boolean {
  if (sampleRate >= 1.0) return true;
  if (sampleRate <= 0) return false;
  return Math.random() < sampleRate;
}

/**
 * Gets the full project path (entity/project)
 */
export function getProjectPath(config: WeavePluginConfig): string {
  return `${config.entity}/${config.project}`;
}
