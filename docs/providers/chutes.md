---
summary: "Use Chutes AI with Moltbot"
read_when:
  - You want to use Chutes AI models in Moltbot
  - You need to configure Chutes via OAuth or API key
---
# Chutes AI

Chutes provides high-performance inference for open-weight models, including GLM 4.7 Flash. Moltbot supports Chutes via both OAuth and API key authentication.

Models are fetched dynamically from the Chutes API, ensuring you always have access to the latest models, accurate pricing, and context window limits.

## CLI setup

To configure Chutes with an API key:

```bash
moltbot onboard --auth-choice chutes-api-key
# or non-interactive
moltbot onboard --chutes-api-key "$CHUTES_API_KEY"
```

To configure Chutes with OAuth (browser-based):

```bash
moltbot onboard --auth-choice chutes
```

OAuth allows you to use your Chutes account without manually managing API keys. Moltbot uses the standard [Sign in with Chutes](https://github.com/chutesai/Sign-in-with-Chutes) flow.

### OAuth Scopes

Moltbot requests the following scopes by default:
- `openid` (Required for authentication)
- `profile` (Access to username)
- `chutes:invoke` (Required to make AI API calls on your behalf)

### Custom OAuth App (Advanced)

If you wish to use your own OAuth application instead of the default, set these environment variables before running onboarding:

- `CHUTES_CLIENT_ID`: Your OAuth client ID
- `CHUTES_CLIENT_SECRET`: Your OAuth client secret (if applicable)
- `CHUTES_OAUTH_REDIRECT_URI`: Your redirect URI (default: `http://127.0.0.1:1456/oauth-callback`)


## Config snippet

```json5
{
  env: { CHUTES_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "chutes/zai-org/GLM-4.7-Flash" } } },
  models: {
    providers: {
      chutes: {
        baseUrl: "https://llm.chutes.ai/v1",
        api: "openai-completions",
        apiKey: "${CHUTES_API_KEY}",
        teeOnly: false // Set to true to filter models by Trusted Execution Environment
      }
    }
  }
}
```

## Notes

- Chutes models are available under the `chutes/` provider prefix.
- The default model is `chutes/zai-org/GLM-4.7-Flash`.
- Chutes uses OpenAI-compatible endpoints.
- **Trusted Execution Environment (TEE)**: Models running in a TEE are marked with a "TEE" badge in the model picker. You can filter for these models by setting `teeOnly: true` in your provider config.
- Many top models on Chutes support tool calling, including:
  - `Qwen/Qwen3-235B-A22B-Instruct-2507-TEE` (TEE)
  - `deepseek-ai/DeepSeek-V3.2-TEE` (TEE)
  - `chutesai/Mistral-Small-3.1-24B-Instruct-2503`
  - `NousResearch/Hermes-4-14B`
- For a full list of available models, see the [Chutes Models API](https://llm.chutes.ai/v1/models). Popular models include:
  - `deepseek-ai/DeepSeek-V3.2-TEE`
  - `Qwen/Qwen3-235B-A22B-Instruct-2507-TEE`
  - `mistralai/Mistral-Small-24B-Instruct-2501-TEE`
  - `NousResearch/Hermes-4-14B`
