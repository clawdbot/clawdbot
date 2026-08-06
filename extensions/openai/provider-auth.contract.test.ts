// Openai tests cover provider auth.contract plugin behavior.
import { describeOpenAICodexProviderAuthContract } from "openclaw/plugin-sdk/provider-test-contracts";
import { vi } from "vitest";
import { OPENAI_CODEX_DEFAULT_MODEL } from "./default-models.js";

const loginOpenAICodexOAuthMock = vi.hoisted(() => vi.fn());

vi.mock("./openai-chatgpt-oauth.runtime.js", () => ({
  loginOpenAICodexOAuth: loginOpenAICodexOAuthMock,
}));

describeOpenAICodexProviderAuthContract(() => import("./index.js"), {
  expectedCodexDefaultModel: OPENAI_CODEX_DEFAULT_MODEL,
  loginOpenAICodexOAuthMock,
});
