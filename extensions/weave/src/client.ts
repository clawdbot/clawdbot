/**
 * W&B Weave Client Wrapper
 *
 * Provides a centralized interface for Weave SDK operations
 */

import { init, op, Dataset } from 'weave';
import type {
  WeavePluginConfig,
  TraceContext,
  WeaveSpan,
  WeaveLogEntry,
  WeaveFeedback,
  WeaveQuery,
  WeaveDatasetConfig,
} from './types.js';
import { getProjectPath } from './config.js';

/**
 * Debug logging helper - only logs when debug is enabled
 */
function debugLog(debug: boolean | undefined, ...args: unknown[]): void {
  if (debug) {
    console.log('[weave]', ...args);
  }
}

/**
 * Ensure project exists with RESTRICTED visibility.
 * - If project doesn't exist: create it with RESTRICTED visibility
 * - If project exists: don't touch visibility (respect user's settings)
 */
async function ensureProjectExists(config: WeavePluginConfig): Promise<void> {
  const { entity, project, apiKey, baseUrl, debug } = config;
  debugLog(debug, `ensureProjectExists called for ${entity}/${project}`);
  if (!apiKey || !entity || !project) {
    debugLog(debug, 'ensureProjectExists: missing config, skipping');
    return;
  }

  const encoded = Buffer.from(`api:${apiKey}`).toString('base64');
  const headers = {
    'Authorization': `Basic ${encoded}`,
    'Content-Type': 'application/json',
  };

  // Use custom base URL for self-hosted instances, default to W&B cloud
  const graphqlUrl = baseUrl
    ? `${baseUrl.replace(/\/$/, '')}/graphql`
    : 'https://api.wandb.ai/graphql';

  try {
    // Check if project exists
    debugLog(debug, `Checking if project ${entity}/${project} exists...`);
    const checkResponse = await fetch(graphqlUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query: `{ project(name: "${project}", entityName: "${entity}") { name } }`,
      }),
    });

    if (!checkResponse.ok) {
      debugLog(debug, `Project check failed: ${checkResponse.status} ${checkResponse.statusText}`);
      return;
    }

    const checkResult = await checkResponse.json() as { data?: { project?: { name?: string } | null } };
    debugLog(debug, `Project check result:`, JSON.stringify(checkResult));

    // Project already exists - don't touch it
    if (checkResult?.data?.project?.name) {
      debugLog(debug, `Project ${entity}/${project} already exists, not touching visibility`);
      return;
    }

    debugLog(debug, `Project ${entity}/${project} does not exist, creating with RESTRICTED visibility...`);

    // Project doesn't exist - create it with RESTRICTED visibility
    const createResponse = await fetch(graphqlUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query: `mutation { upsertModel(input: {entityName: "${entity}", name: "${project}", access: "RESTRICTED", framework: "weave"}) { model { name access } } }`,
      }),
    });

    if (createResponse.ok) {
      const result = await createResponse.json() as { data?: { upsertModel?: { model?: { name?: string; access?: string } } } };
      debugLog(debug, `Create response:`, JSON.stringify(result));
      const created = result?.data?.upsertModel?.model;
      if (created?.name) {
        // Always log successful project creation (important info)
        console.log(`[weave] Created project ${entity}/${project} with RESTRICTED visibility`);
      } else {
        debugLog(debug, `Create response OK but no model in result`);
      }
    } else {
      const errorText = await createResponse.text();
      // Always log failures (important for troubleshooting)
      console.warn(`[weave] Failed to create project: ${createResponse.status} ${createResponse.statusText}: ${errorText}`);
    }
  } catch (error) {
    // Don't fail initialization - Weave SDK will create the project if needed
    console.warn(`[weave] Could not pre-create project: ${error}`);
  }
}

/**
 * Active trace contexts by session key
 */
const activeTraces = new Map<string, TraceContext>();

/**
 * Weave client singleton
 */
let weaveClient: WeaveClient | null = null;

/**
 * SDK client from Weave init() - used for flushing
 */
let sdkClient: { waitForBatchProcessing(): Promise<void> } | null = null;

/**
 * WeaveClient wraps the Weave SDK for Clawdbot integration
 */
export class WeaveClient {
  private config: WeavePluginConfig;
  private initialized = false;

  constructor(config: WeavePluginConfig) {
    this.config = config;
  }

  /**
   * Initialize the Weave SDK
   */
  async initialize(): Promise<void> {
    const { debug } = this.config;
    debugLog(debug, 'WeaveClient.initialize() called');
    if (this.initialized) {
      debugLog(debug, 'Already initialized, skipping');
      return;
    }

    // Set API key in environment for Weave SDK
    if (this.config.apiKey) {
      process.env.WANDB_API_KEY = this.config.apiKey;
      debugLog(debug, 'API key set in environment');
    }

    // Set base URL for self-hosted instances
    if (this.config.baseUrl) {
      process.env.WANDB_BASE_URL = this.config.baseUrl;
      debugLog(debug, `Base URL set to: ${this.config.baseUrl}`);
    }

    // Pre-create project with RESTRICTED visibility (if it doesn't exist)
    // This must happen BEFORE init() to prevent Weave from auto-creating with PRIVATE
    debugLog(debug, 'Calling ensureProjectExists...');
    await ensureProjectExists(this.config);
    debugLog(debug, 'ensureProjectExists completed');

    // Initialize Weave with project - init() returns the SDK client
    const client = await init(getProjectPath(this.config));
    sdkClient = client;

    this.initialized = true;
  }

  /**
   * Check if client is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Start a new trace for an agent run
   */
  startTrace(sessionKey: string, metadata: Record<string, unknown> = {}): TraceContext {
    const traceId = `trace_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    const context: TraceContext = {
      traceId,
      sessionKey,
      rootSpan: null,
      activeSpan: null,
      startTime: Date.now(),
      metadata,
    };

    activeTraces.set(sessionKey, context);
    return context;
  }

  /**
   * Get the active trace context for a session
   */
  getTrace(sessionKey: string): TraceContext | undefined {
    return activeTraces.get(sessionKey);
  }

  /**
   * Start a span within a trace
   */
  startSpan(
    sessionKey: string,
    name: string,
    inputs: Record<string, unknown> = {},
    attributes: Record<string, unknown> = {}
  ): WeaveSpan {
    const trace = activeTraces.get(sessionKey);
    const parentSpan = trace?.activeSpan;

    const span: WeaveSpan = {
      id: `span_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      name,
      parentId: parentSpan?.id ?? null,
      startTime: Date.now(),
      endTime: null,
      inputs,
      outputs: null,
      attributes,
      status: 'running',
    };

    if (trace) {
      if (!trace.rootSpan) {
        trace.rootSpan = span;
      }
      trace.activeSpan = span;
    }

    return span;
  }

  /**
   * End a span with outputs
   */
  endSpan(
    span: WeaveSpan,
    outputs: Record<string, unknown> = {},
    success = true,
    error?: string
  ): void {
    span.endTime = Date.now();
    span.outputs = outputs;
    span.status = success ? 'success' : 'error';
    if (error) {
      span.error = error;
    }
  }

  /**
   * End the trace for a session
   */
  async endTrace(sessionKey: string): Promise<void> {
    console.log(`[weave] endTrace called for sessionKey: ${sessionKey}`);
    const trace = activeTraces.get(sessionKey);
    if (!trace) {
      console.log(`[weave] No trace found for sessionKey: ${sessionKey}`);
      return;
    }

    console.log(`[weave] Found trace, logging to Weave...`);
    // Log the complete trace to Weave
    await this.logTrace(trace);

    activeTraces.delete(sessionKey);
    console.log(`[weave] Trace deleted from activeTraces`);
  }

  /**
   * Log a complete trace to Weave
   */
  private async logTrace(trace: TraceContext): Promise<void> {
    console.log(`[weave] logTrace called, rootSpan: ${trace.rootSpan?.name}`);
    if (!trace.rootSpan) {
      console.log(`[weave] No rootSpan, skipping`);
      return;
    }

    // Use Weave's op decorator pattern for logging
    const traceFn = op(
      async (input: Record<string, unknown>) => {
        return trace.rootSpan?.outputs ?? {};
      },
      {
        name: trace.rootSpan.name,
      }
    );

    try {
      console.log(`[weave] Calling traceFn with inputs:`, JSON.stringify(trace.rootSpan.inputs).slice(0, 200));
      console.log(`[weave] Outputs to log:`, JSON.stringify(trace.rootSpan.outputs).slice(0, 300));
      await traceFn(trace.rootSpan.inputs);
      console.log(`[weave] traceFn completed, flushing...`);
      // Flush the trace to ensure it's sent to W&B
      await this.flush();
      console.log(`[weave] Flush completed`);
    } catch (error) {
      console.error('[weave] Failed to log trace:', error);
    }
  }

  /**
   * Flush any pending traces to W&B
   */
  async flush(): Promise<void> {
    if (sdkClient && typeof sdkClient.waitForBatchProcessing === 'function') {
      await sdkClient.waitForBatchProcessing();
    }
  }

  /**
   * Log custom data to Weave
   */
  async log(entry: WeaveLogEntry): Promise<void> {
    const logFn = op(async (data: unknown) => data, { name: entry.name });

    try {
      await logFn(entry.value);
    } catch (error) {
      console.error('[weave] Failed to log entry:', error);
    }
  }

  /**
   * Add feedback to a trace/call
   */
  async addFeedback(feedback: WeaveFeedback): Promise<void> {
    // Feedback is typically added through the Weave UI or API
    // This is a placeholder for future API integration
    console.log('[weave] Feedback:', feedback);
  }

  /**
   * Query traces from Weave
   */
  async query(params: WeaveQuery): Promise<unknown[]> {
    // Query functionality requires Weave API calls
    // This is a placeholder for future API integration
    console.log('[weave] Query:', params);
    return [];
  }

  /**
   * Create or update a dataset
   */
  async createDataset(config: WeaveDatasetConfig): Promise<void> {
    const dataset = new Dataset({
      name: config.name,
      description: config.description,
      rows: config.rows,
    });

    // Save the dataset to Weave
    try {
      await dataset.save();
      console.log(`[weave] Created dataset: ${config.name} with ${config.rows.length} rows`);
    } catch (error) {
      console.error(`[weave] Failed to create dataset: ${error}`);
      throw error;
    }
  }

  /**
   * Get configuration
   */
  getConfig(): WeavePluginConfig {
    return this.config;
  }
}

/**
 * Get or create the Weave client singleton
 */
export function getWeaveClient(config?: WeavePluginConfig): WeaveClient {
  if (!weaveClient && config) {
    weaveClient = new WeaveClient(config);
  }
  if (!weaveClient) {
    throw new Error('Weave client not initialized. Provide config on first call.');
  }
  return weaveClient;
}

/**
 * Initialize the Weave client
 */
export async function initializeWeaveClient(config: WeavePluginConfig): Promise<WeaveClient> {
  const client = getWeaveClient(config);
  await client.initialize();
  return client;
}
