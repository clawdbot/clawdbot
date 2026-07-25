// Google Vertex provider wires Google shared streaming through Vertex credentials.
import {
  type GenerateContentParameters,
  GoogleGenAI,
  type HttpOptions,
  ResourceScope,
} from "@google/genai";
import { getAiTransportHost, resolveAiTransportHeaderSentinels } from "../host.js";
import type { Context, Model, SimpleStreamOptions, StreamFunction } from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import {
  buildGoogleGenerateContentParams,
  buildGoogleSimpleThinking,
  createGoogleAssistantOutput,
  type GoogleProviderOptions,
  runGoogleGenerateContentLifecycle,
} from "./google-shared.js";
import { buildBaseOptions } from "./simple-options.js";

interface GoogleVertexOptions extends GoogleProviderOptions {
  project?: string;
  location?: string;
}

const API_VERSION = "v1";
const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";

// Counter for generating unique tool call IDs
let toolCallCounter = 0;

export const streamGoogleVertex: StreamFunction<"google-vertex", GoogleVertexOptions> = (
  model: Model<"google-vertex">,
  context: Context,
  options?: GoogleVertexOptions,
) => {
  const stream = new AssistantMessageEventStream();
  const output = createGoogleAssistantOutput(model, "google-vertex");

  void runGoogleGenerateContentLifecycle({
    stream,
    model,
    output,
    options,
    createClient: () => {
      const apiKey = resolveApiKey(options);
      // Create the client using either a Vertex API key, if provided, or ADC with project and location
      return apiKey
        ? createClientWithApiKey(model, apiKey, options?.headers)
        : createClient(model, resolveProject(options), resolveLocation(options), options?.headers);
    },
    buildParams: () => buildParams(model, context, options),
    nextToolCallId: (name) => `${name}_${Date.now()}_${++toolCallCounter}`,
  });

  return stream;
};

export const streamSimpleGoogleVertex: StreamFunction<"google-vertex", SimpleStreamOptions> = (
  model: Model<"google-vertex">,
  context: Context,
  options?: SimpleStreamOptions,
) => {
  const base = buildBaseOptions(model, options, undefined);
  return streamGoogleVertex(model, context, {
    ...base,
    thinking: buildGoogleSimpleThinking(model, options),
  } satisfies GoogleVertexOptions);
};

function createClient(
  model: Model<"google-vertex">,
  project: string,
  location: string,
  optionsHeaders?: Record<string, string>,
): GoogleGenAI {
  return new GoogleGenAI({
    vertexai: true,
    project,
    location,
    apiVersion: API_VERSION,
    httpOptions: buildHttpOptions(model, optionsHeaders),
  });
}

function createClientWithApiKey(
  model: Model<"google-vertex">,
  apiKey: string,
  optionsHeaders?: Record<string, string>,
): GoogleGenAI {
  // @google/genai exposes RequestInit options but no custom fetch; unwrap at construction.
  const resolvedApiKey = getAiTransportHost().resolveSecretSentinel(apiKey);
  return new GoogleGenAI({
    vertexai: true,
    apiKey: resolvedApiKey,
    apiVersion: API_VERSION,
    httpOptions: buildHttpOptions(model, optionsHeaders),
  });
}

function buildHttpOptions(
  model: Model<"google-vertex">,
  optionsHeaders?: Record<string, string>,
): HttpOptions | undefined {
  const httpOptions: HttpOptions = {};
  const baseUrl = resolveCustomBaseUrl(model.baseUrl);
  if (baseUrl) {
    httpOptions.baseUrl = baseUrl;
    httpOptions.baseUrlResourceScope = ResourceScope.COLLECTION;
    if (baseUrlIncludesApiVersion(baseUrl)) {
      httpOptions.apiVersion = "";
    }
  }

  if (model.headers || optionsHeaders) {
    httpOptions.headers = resolveAiTransportHeaderSentinels({
      ...model.headers,
      ...optionsHeaders,
    });
  }

  return Object.keys(httpOptions).length > 0 ? httpOptions : undefined;
}

function resolveCustomBaseUrl(baseUrl: string): string | undefined {
  const trimmed = baseUrl.trim();
  if (!trimmed || trimmed.includes("{location}")) {
    return undefined;
  }
  return trimmed;
}

function baseUrlIncludesApiVersion(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.pathname.split("/").some((part) => /^v\d+(?:beta\d*)?$/.test(part));
  } catch {
    return /(?:^|\/)v\d+(?:beta\d*)?(?:\/|$)/.test(baseUrl);
  }
}

function resolveApiKey(options?: GoogleVertexOptions): string | undefined {
  const apiKey = options?.apiKey?.trim() || process.env.GOOGLE_CLOUD_API_KEY?.trim();
  if (!apiKey || apiKey === GCP_VERTEX_CREDENTIALS_MARKER || isPlaceholderApiKey(apiKey)) {
    return undefined;
  }
  return apiKey;
}

function isPlaceholderApiKey(apiKey: string): boolean {
  return /^<[^>]+>$/.test(apiKey);
}

function resolveProject(options?: GoogleVertexOptions): string {
  const project =
    options?.project || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
  if (!project) {
    throw new Error(
      "Vertex AI requires a project ID. Set GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT or pass project in options.",
    );
  }
  return project;
}

function resolveLocation(options?: GoogleVertexOptions): string {
  const location = options?.location || process.env.GOOGLE_CLOUD_LOCATION;
  if (!location) {
    throw new Error(
      "Vertex AI requires a location. Set GOOGLE_CLOUD_LOCATION or pass location in options.",
    );
  }
  return location;
}

function buildParams(
  model: Model<"google-vertex">,
  context: Context,
  options: GoogleVertexOptions = {},
): GenerateContentParameters {
  return buildGoogleGenerateContentParams(model, context, options);
}
