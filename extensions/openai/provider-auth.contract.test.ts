// Openai tests cover provider auth.contract plugin behavior.
import { describeOpenAICodexProviderAuthContract } from "openclaw/plugin-sdk/provider-test-contracts";
import { vi } from "vitest";
import { OPENAI_CODEX_DEFAULT_MODEL } from "./api.js";

const loginOpenAICodexOAuthMock = vi.hoisted(() => vi.fn());

vi.mock("./openai-chatgpt-oauth.runtime.js", () => ({
  loginOpenAICodexOAuth: loginOpenAICodexOAuthMock,
}));

describeOpenAICodexProviderAuthContract(() => import("./index.js"), {
  loginOpenAICodexOAuthMock,
  defaultModel: OPENAI_CODEX_DEFAULT_MODEL,
});
