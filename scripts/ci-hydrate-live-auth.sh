#!/usr/bin/env bash
set -euo pipefail

profile_path="${1:-${RUNNER_TEMP:-/tmp}/openclaw-live.profile}"

mkdir -p "$(dirname "$profile_path")"
: >"$profile_path"
chmod 600 "$profile_path"

append_profile_env() {
  local key="$1"
  local value="${!key:-}"
  if [[ -z "$value" || "$value" == "undefined" || "$value" == "null" ]]; then
    return
  fi
  printf 'export %s=%q\n' "$key" "$value" >>"$profile_path"
}

write_secret_file() {
  local destination="$1"
  local source_env="$2"
  local value="${!source_env:-}"
  if [[ -z "$value" ]]; then
    return
  fi
  mkdir -p "$(dirname "$destination")"
  printf '%s' "$value" >"$destination"
  chmod 600 "$destination"
}

for env_key in \
  OPENAI_API_KEY \
  OPENAI_BASE_URL \
  ANTHROPIC_API_KEY \
  ANTHROPIC_API_KEY_OLD \
  ANTHROPIC_API_TOKEN \
  BYTEPLUS_API_KEY \
  CEREBRAS_API_KEY \
  DASHSCOPE_API_KEY \
  GROQ_API_KEY \
  KIMI_API_KEY \
  MODELSTUDIO_API_KEY \
  MOONSHOT_API_KEY \
  MISTRAL_API_KEY \
  MINIMAX_API_KEY \
  OPENCODE_API_KEY \
  OPENCODE_ZEN_API_KEY \
  OPENCLAW_LIVE_BROWSER_CDP_URL \
  OPENCLAW_LIVE_SETUP_TOKEN \
  OPENCLAW_LIVE_SETUP_TOKEN_MODEL \
  OPENCLAW_LIVE_SETUP_TOKEN_PROFILE \
  OPENCLAW_LIVE_SETUP_TOKEN_VALUE \
  GEMINI_API_KEY \
  GOOGLE_API_KEY \
  OPENROUTER_API_KEY \
  QWEN_API_KEY \
  FAL_KEY \
  RUNWAY_API_KEY \
  DEEPGRAM_API_KEY \
  TOGETHER_API_KEY \
  VYDRA_API_KEY \
  XAI_API_KEY \
  ZAI_API_KEY \
  Z_AI_API_KEY \
  BYTEPLUS_ACCESS_KEY_ID \
  BYTEPLUS_SECRET_ACCESS_KEY \
  CLAUDE_CODE_OAUTH_TOKEN \
  FIREWORKS_API_KEY
do
  append_profile_env "$env_key"
done

write_secret_file "$HOME/.codex/auth.json" OPENCLAW_CODEX_AUTH_JSON
write_secret_file "$HOME/.codex/config.toml" OPENCLAW_CODEX_CONFIG_TOML
write_secret_file "$HOME/.claude.json" OPENCLAW_CLAUDE_JSON
write_secret_file "$HOME/.claude/.credentials.json" OPENCLAW_CLAUDE_CREDENTIALS_JSON
write_secret_file "$HOME/.claude/settings.json" OPENCLAW_CLAUDE_SETTINGS_JSON
write_secret_file "$HOME/.claude/settings.local.json" OPENCLAW_CLAUDE_SETTINGS_LOCAL_JSON
write_secret_file "$HOME/.gemini/settings.json" OPENCLAW_GEMINI_SETTINGS_JSON

if [[ -n "${GITHUB_ENV:-}" ]]; then
  {
    echo "OPENCLAW_PROFILE_FILE=$profile_path"
  } >>"$GITHUB_ENV"
fi
