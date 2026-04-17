import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { startQaGatewayChild, type QaCliBackendAuthMode } from "../../gateway-child.js";
import type { QaProviderMode } from "../../model-selection.js";
import { startQaProviderServer } from "../../providers/server-runtime.js";
import type { QaThinkingLevel } from "../../qa-gateway-config.js";
import { appendLiveLaneIssue } from "./live-lane-helpers.js";

async function stopQaLiveLaneResources(resources: {
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>;
  mock: { baseUrl: string; stop(): Promise<void> } | null;
}) {
  const errors: string[] = [];
  try {
    await resources.gateway.stop();
  } catch (error) {
    appendLiveLaneIssue(errors, "gateway stop failed", error);
  }
  if (resources.mock) {
    try {
      await resources.mock.stop();
    } catch (error) {
      appendLiveLaneIssue(errors, "mock provider stop failed", error);
    }
  }
  if (errors.length > 0) {
    throw new Error(`failed to stop QA live lane resources:\n${errors.join("\n")}`);
  }
}

export async function startQaLiveLaneGateway(params: {
  repoRoot: string;
  transport: {
    requiredPluginIds: readonly string[];
    createGatewayConfig: (params: {
      baseUrl: string;
    }) => Pick<OpenClawConfig, "channels" | "messages">;
  };
  transportBaseUrl: string;
  controlUiAllowedOrigins?: string[];
  providerMode: QaProviderMode;
  primaryModel: string;
  alternateModel: string;
  fastMode?: boolean;
  thinkingDefault?: QaThinkingLevel;
  claudeCliAuthMode?: QaCliBackendAuthMode;
  controlUiEnabled?: boolean;
  mutateConfig?: (cfg: OpenClawConfig) => OpenClawConfig;
}) {
  const mock = await startQaProviderServer(params.providerMode);
  try {
    const gateway = await startQaGatewayChild({
      repoRoot: params.repoRoot,
      providerBaseUrl: mock ? `${mock.baseUrl}/v1` : undefined,
      transport: params.transport,
      transportBaseUrl: params.transportBaseUrl,
      controlUiAllowedOrigins: params.controlUiAllowedOrigins,
      providerMode: params.providerMode,
      primaryModel: params.primaryModel,
      alternateModel: params.alternateModel,
      fastMode: params.fastMode,
      thinkingDefault: params.thinkingDefault,
      claudeCliAuthMode: params.claudeCliAuthMode,
      controlUiEnabled: params.controlUiEnabled,
      mutateConfig: params.mutateConfig,
    });
    return {
      gateway,
      mock,
      async stop() {
        await stopQaLiveLaneResources({ gateway, mock });
      },
    };
  } catch (error) {
    await mock?.stop().catch(() => {});
    throw error;
  }
}
