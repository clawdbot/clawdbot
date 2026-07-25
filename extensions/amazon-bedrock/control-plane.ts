/** Bedrock control-plane SDK loading and deadline-bound command dispatch. */
import type {
  BedrockClient,
  GetInferenceProfileCommand,
  GetInferenceProfileCommandInput,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
  ListInferenceProfilesCommandInput,
} from "@aws-sdk/client-bedrock";
import { buildTimeoutAbortSignal } from "openclaw/plugin-sdk/extension-shared";

const BEDROCK_CONTROL_PLANE_REQUEST_TIMEOUT_MS = 30_000;

export type BedrockControlPlaneSdk = {
  createClient(region?: string): BedrockClient;
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
    createClient: (region) => new BedrockClient(region ? { region } : {}),
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
