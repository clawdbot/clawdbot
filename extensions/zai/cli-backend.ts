/** Z.AI's native Claude Agent SDK backend. */
import { buildClaudeAgentSdkCliBackend } from "@openclaw/anthropic-provider/agent-sdk-backend-api";

const ZAI_CLAUDE_AGENT_SDK_BACKEND_ID = "zai-claude-agent-sdk";
const ZAI_ANTHROPIC_BASE_URL = "https://api.z.ai/api/anthropic";

/**
 * Run configured Z.AI models through Claude Code's official Agent SDK.
 *
 * This is intentionally an explicit runtime opt-in. It never changes the
 * native Anthropic backend's endpoint or ambient authentication behavior.
 */
export function buildZaiClaudeAgentSdkBackend() {
  return buildClaudeAgentSdkCliBackend({
    backendId: ZAI_CLAUDE_AGENT_SDK_BACKEND_ID,
    modelProvider: "zai",
    defaultModelRef: "zai/glm-4.7",
    endpoint: ZAI_ANTHROPIC_BASE_URL,
    apiKeyAsAuthToken: true,
    modelAliases: {},
    supportsOneMillionModelSuffix: false,
    // Z.AI credentials are ordinary API keys; they do not need subscription
    // auth dispatch semantics reserved for Anthropic's OAuth plans.
    subscriptionAuthDispatch: false,
  });
}
