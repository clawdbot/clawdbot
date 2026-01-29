/**
 * Azure OpenAI Provider Configuration
 *
 * This module provides support for Azure OpenAI Service, which uses a different
 * API endpoint format and authentication mechanism compared to OpenAI's standard API.
 *
 * Azure OpenAI endpoint format:
 * https://{resourceName}.openai.azure.com/openai/deployments/{deploymentName}/chat/completions?api-version={apiVersion}
 */

import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { ProviderConfig } from "./models-config.providers.js";

// Store for Azure OpenAI configurations to enable fetch interception
const azureOpenAIConfigs = new Map<string, { apiVersion: string }>();

/**
 * Register an Azure OpenAI resource for fetch interception.
 * This enables the global fetch wrapper to add api-version query parameters.
 */
export function registerAzureOpenAIResource(resourceName: string, apiVersion: string): void {
  azureOpenAIConfigs.set(resourceName.toLowerCase(), { apiVersion });
}

/**
 * Check if a URL is an Azure OpenAI endpoint and get its configuration.
 */
export function getAzureOpenAIConfig(
  url: string,
): { resourceName: string; apiVersion: string } | null {
  try {
    const parsed = new URL(url);
    const match = /^([^.]+)\.openai\.azure\.com$/.exec(parsed.hostname);
    if (!match) return null;
    const resourceName = match[1].toLowerCase();
    const config = azureOpenAIConfigs.get(resourceName);
    if (!config) return null;
    return { resourceName, apiVersion: config.apiVersion };
  } catch {
    return null;
  }
}

// Track if the fetch wrapper has been installed
let fetchWrapperInstalled = false;
let originalFetch: typeof fetch | null = null;

/**
 * Install a global fetch wrapper that adds api-version query parameter
 * to Azure OpenAI requests.
 */
export function installAzureOpenAIFetchWrapper(): void {
  if (fetchWrapperInstalled) return;

  originalFetch = globalThis.fetch;
  fetchWrapperInstalled = true;

  globalThis.fetch = async function azureOpenAIFetchWrapper(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const azureConfig = getAzureOpenAIConfig(url);

    if (azureConfig) {
      // Add api-version query parameter to Azure OpenAI requests
      const parsedUrl = new URL(url);
      if (!parsedUrl.searchParams.has("api-version")) {
        parsedUrl.searchParams.set("api-version", azureConfig.apiVersion);
        const newUrl = parsedUrl.toString();

        // Recreate the request with the new URL
        if (typeof input === "string") {
          return originalFetch!(newUrl, init);
        } else if (input instanceof URL) {
          return originalFetch!(new URL(newUrl), init);
        } else {
          // Request object - create new request with modified URL
          const newRequest = new Request(newUrl, {
            method: input.method,
            headers: input.headers,
            body: init?.body ?? input.body,
            mode: input.mode,
            credentials: input.credentials,
            cache: input.cache,
            redirect: input.redirect,
            referrer: input.referrer,
            integrity: input.integrity,
            signal: init?.signal ?? input.signal,
          });
          return originalFetch!(newRequest);
        }
      }
    }

    return originalFetch!(input, init);
  };
}

/**
 * Uninstall the Azure OpenAI fetch wrapper (for testing).
 */
export function uninstallAzureOpenAIFetchWrapper(): void {
  if (!fetchWrapperInstalled || !originalFetch) return;
  globalThis.fetch = originalFetch;
  fetchWrapperInstalled = false;
  originalFetch = null;
}

// Azure OpenAI default configuration
const AZURE_OPENAI_DEFAULT_API_VERSION = "2024-08-01-preview";
const AZURE_OPENAI_DEFAULT_CONTEXT_WINDOW = 128000;
const AZURE_OPENAI_DEFAULT_MAX_TOKENS = 4096;
const AZURE_OPENAI_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export interface AzureOpenAIConfig {
  /** Azure OpenAI resource name (the name of your Azure OpenAI resource) */
  resourceName: string;
  /** Deployment name (the name of your model deployment) */
  deploymentName: string;
  /** API version (defaults to 2024-08-01-preview) */
  apiVersion?: string;
  /** Azure OpenAI API key */
  apiKey?: string;
  /** Custom model display name */
  modelName?: string;
  /** Whether this is a reasoning model (like o1) */
  reasoning?: boolean;
  /** Supported input types */
  input?: Array<"text" | "image">;
  /** Context window size */
  contextWindow?: number;
  /** Max output tokens */
  maxTokens?: number;
}

/**
 * Builds the Azure OpenAI base URL from resource name
 */
export function buildAzureOpenAIBaseUrl(resourceName: string): string {
  return `https://${resourceName}.openai.azure.com`;
}

/**
 * Builds the full Azure OpenAI API endpoint URL
 */
export function buildAzureOpenAIEndpoint(
  resourceName: string,
  deploymentName: string,
  apiVersion: string = AZURE_OPENAI_DEFAULT_API_VERSION,
): string {
  return `${buildAzureOpenAIBaseUrl(resourceName)}/openai/deployments/${deploymentName}/chat/completions?api-version=${apiVersion}`;
}

/**
 * Creates a model definition for Azure OpenAI deployment
 */
export function buildAzureOpenAIModelDefinition(config: AzureOpenAIConfig): ModelDefinitionConfig {
  const modelId = config.deploymentName;
  const modelName = config.modelName ?? `Azure ${config.deploymentName}`;

  return {
    id: modelId,
    name: modelName,
    reasoning: config.reasoning ?? false,
    input: config.input ?? ["text"],
    cost: AZURE_OPENAI_DEFAULT_COST,
    contextWindow: config.contextWindow ?? AZURE_OPENAI_DEFAULT_CONTEXT_WINDOW,
    maxTokens: config.maxTokens ?? AZURE_OPENAI_DEFAULT_MAX_TOKENS,
  };
}

/**
 * Builds a provider configuration for Azure OpenAI
 *
 * Azure OpenAI uses a different URL format:
 * https://{resource}.openai.azure.com/openai/deployments/{deployment}/chat/completions?api-version={version}
 *
 * We set the baseUrl to include the deployment path so the OpenAI SDK appends /chat/completions correctly.
 * The api-version query parameter is added automatically via a global fetch wrapper.
 */
export function buildAzureOpenAIProvider(config: AzureOpenAIConfig): ProviderConfig {
  const apiVersion = config.apiVersion ?? AZURE_OPENAI_DEFAULT_API_VERSION;
  // Azure OpenAI requires the deployment in the URL path
  // Format: https://{resource}.openai.azure.com/openai/deployments/{deployment}
  // The SDK will append /chat/completions to this
  const baseUrl = `https://${config.resourceName}.openai.azure.com/openai/deployments/${config.deploymentName}`;

  // Register the resource for fetch interception to add api-version query param
  registerAzureOpenAIResource(config.resourceName, apiVersion);
  // Install the global fetch wrapper
  installAzureOpenAIFetchWrapper();

  return {
    baseUrl,
    api: "openai-completions",
    apiKey: config.apiKey,
    // Azure OpenAI uses api-key header instead of Bearer token
    authHeader: false,
    headers: {
      "api-key": config.apiKey ?? "",
    },
    // Azure requires api-version as query parameter - store in provider config
    azureResourceName: config.resourceName,
    azureApiVersion: apiVersion,
    models: [buildAzureOpenAIModelDefinition(config)],
  };
}

/**
 * Builds a provider configuration for Azure OpenAI with multiple deployments
 *
 * Note: Each deployment gets its own baseUrl with the deployment name in the path.
 * For multiple deployments, we use the first deployment in the baseUrl.
 * The api-version query parameter is added automatically via a global fetch wrapper.
 */
export function buildAzureOpenAIProviderMultiDeployment(params: {
  resourceName: string;
  apiKey?: string;
  apiVersion?: string;
  deployments: Array<{
    name: string;
    displayName?: string;
    reasoning?: boolean;
    input?: Array<"text" | "image">;
    contextWindow?: number;
    maxTokens?: number;
  }>;
}): ProviderConfig {
  const apiVersion = params.apiVersion ?? AZURE_OPENAI_DEFAULT_API_VERSION;
  const firstDeployment = params.deployments[0]?.name ?? "default";
  const baseUrl = `https://${params.resourceName}.openai.azure.com/openai/deployments/${firstDeployment}`;

  // Register the resource for fetch interception to add api-version query param
  registerAzureOpenAIResource(params.resourceName, apiVersion);
  // Install the global fetch wrapper
  installAzureOpenAIFetchWrapper();

  const models: ModelDefinitionConfig[] = params.deployments.map((deployment) => ({
    id: deployment.name,
    name: deployment.displayName ?? `Azure ${deployment.name}`,
    reasoning: deployment.reasoning ?? false,
    input: deployment.input ?? ["text"],
    cost: AZURE_OPENAI_DEFAULT_COST,
    contextWindow: deployment.contextWindow ?? AZURE_OPENAI_DEFAULT_CONTEXT_WINDOW,
    maxTokens: deployment.maxTokens ?? AZURE_OPENAI_DEFAULT_MAX_TOKENS,
  }));

  return {
    baseUrl,
    api: "openai-completions",
    apiKey: params.apiKey,
    authHeader: false,
    headers: {
      "api-key": params.apiKey ?? "",
    },
    azureResourceName: params.resourceName,
    azureApiVersion: apiVersion,
    models,
  };
}

/**
 * Environment variable names for Azure OpenAI configuration
 */
export const AZURE_OPENAI_ENV = {
  API_KEY: "AZURE_OPENAI_API_KEY",
  RESOURCE_NAME: "AZURE_OPENAI_RESOURCE_NAME",
  DEPLOYMENT_NAME: "AZURE_OPENAI_DEPLOYMENT_NAME",
  API_VERSION: "AZURE_OPENAI_API_VERSION",
  ENDPOINT: "AZURE_OPENAI_ENDPOINT",
} as const;

/**
 * Resolves Azure OpenAI configuration from environment variables
 */
export function resolveAzureOpenAIConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AzureOpenAIConfig | null {
  const apiKey = env[AZURE_OPENAI_ENV.API_KEY]?.trim();
  const resourceName = env[AZURE_OPENAI_ENV.RESOURCE_NAME]?.trim();
  const deploymentName = env[AZURE_OPENAI_ENV.DEPLOYMENT_NAME]?.trim();
  const apiVersion = env[AZURE_OPENAI_ENV.API_VERSION]?.trim();

  // If endpoint is provided directly, parse resource name from it
  const endpoint = env[AZURE_OPENAI_ENV.ENDPOINT]?.trim();
  let resolvedResourceName = resourceName;
  if (!resolvedResourceName && endpoint) {
    const match = /https:\/\/([^.]+)\.openai\.azure\.com/.exec(endpoint);
    if (match) {
      resolvedResourceName = match[1];
    }
  }

  if (!apiKey || !resolvedResourceName || !deploymentName) {
    return null;
  }

  return {
    resourceName: resolvedResourceName,
    deploymentName,
    apiVersion: apiVersion || AZURE_OPENAI_DEFAULT_API_VERSION,
    apiKey,
  };
}

/**
 * Default export for common models available on Azure OpenAI
 * These are the most commonly deployed models
 */
export const AZURE_OPENAI_COMMON_MODELS = {
  "gpt-5": {
    reasoning: false,
    input: ["text", "image"] as Array<"text" | "image">,
    contextWindow: AZURE_OPENAI_DEFAULT_CONTEXT_WINDOW,
    maxTokens: AZURE_OPENAI_DEFAULT_MAX_TOKENS,
  },
  "gpt-5-mini": {
    reasoning: false,
    input: ["text", "image"] as Array<"text" | "image">,
    contextWindow: AZURE_OPENAI_DEFAULT_CONTEXT_WINDOW,
    maxTokens: AZURE_OPENAI_DEFAULT_MAX_TOKENS,
  },
  "gpt-5-nano": {
    reasoning: false,
    input: ["text", "image"] as Array<"text" | "image">,
    contextWindow: AZURE_OPENAI_DEFAULT_CONTEXT_WINDOW,
    maxTokens: AZURE_OPENAI_DEFAULT_MAX_TOKENS,
  },
  "gpt-5-codex": {
    reasoning: false,
    input: ["text"] as Array<"text" | "image">,
    contextWindow: AZURE_OPENAI_DEFAULT_CONTEXT_WINDOW,
    maxTokens: AZURE_OPENAI_DEFAULT_MAX_TOKENS,
  },
} as const;
