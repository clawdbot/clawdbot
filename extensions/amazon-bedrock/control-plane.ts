/** Bedrock control-plane SDK loading and deadline-bound command dispatch. */
import type {
  BedrockClient,
  GetInferenceProfileCommand,
  GetInferenceProfileCommandInput,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
  ListInferenceProfilesCommandInput,
} from "@aws-sdk/client-bedrock";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { buildTimeoutAbortSignal } from "openclaw/plugin-sdk/extension-shared";
import { createHttpProxyAgentsForTarget } from "openclaw/plugin-sdk/llm";

const BEDROCK_CONTROL_PLANE_REQUEST_TIMEOUT_MS = 30_000;

export type BedrockControlPlaneSdk = {
  createClient(region?: string): Promise<BedrockClient>;
  createGetInferenceProfileCommand(
    input: GetInferenceProfileCommandInput,
  ): GetInferenceProfileCommand;
  createListFoundationModelsCommand(): ListFoundationModelsCommand;
  createListInferenceProfilesCommand(
    input: ListInferenceProfilesCommandInput,
  ): ListInferenceProfilesCommand;
};

export async function loadBedrockControlPlaneSdk(): Promise<BedrockControlPlaneSdk> {
  const {
    BedrockClient,
    GetInferenceProfileCommand,
    ListFoundationModelsCommand,
    ListInferenceProfilesCommand,
  } = await import("@aws-sdk/client-bedrock");
  return {
    createClient: async (region) => {
      const clientConfig = region ? { region } : {};
      const directClient = new BedrockClient(clientConfig);
      const endpoint = directClient.config.endpointProvider({
        Region: await directClient.config.region(),
        UseFIPS: await directClient.config.useFipsEndpoint(),
        UseDualStack: await directClient.config.useDualstackEndpoint(),
      });
      const configuredEndpoint = directClient.config.ignoreConfiguredEndpointUrls
        ? undefined
        : await directClient.config.serviceConfiguredEndpoint?.();
      if (configuredEndpoint) {
        return directClient;
      }
      const proxyAgents = createHttpProxyAgentsForTarget(endpoint.url);
      if (!proxyAgents) {
        return directClient;
      }
      directClient.destroy();
      return new BedrockClient({
        ...clientConfig,
        requestHandler: new NodeHttpHandler(proxyAgents),
      });
    },
    createGetInferenceProfileCommand: (input) => new GetInferenceProfileCommand(input),
    createListFoundationModelsCommand: () => new ListFoundationModelsCommand({}),
    createListInferenceProfilesCommand: (input) => new ListInferenceProfilesCommand(input),
  };
}

export async function runBedrockControlPlaneRequest<T>(params: {
  operation: string;
  signal?: AbortSignal;
  send: (options: { abortSignal?: AbortSignal }) => Promise<T>;
}): Promise<T> {
  const { signal, cleanup } = buildTimeoutAbortSignal({
    timeoutMs: BEDROCK_CONTROL_PLANE_REQUEST_TIMEOUT_MS,
    signal: params.signal,
    operation: params.operation,
  });
  try {
    signal?.throwIfAborted();
    const response = await params.send({ abortSignal: signal });
    signal?.throwIfAborted();
    return response;
  } finally {
    cleanup();
  }
}
