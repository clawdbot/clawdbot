# Telegram TTS Extension

Automatic text-to-speech for chat responses using ElevenLabs or OpenAI.

## Features

- **Auto-TTS**: Automatically converts all text responses to voice when enabled
- **`speak` Tool**: Converts text to speech and sends as voice message
- **RPC Methods**: Control TTS via Gateway (`tts.status`, `tts.enable`, `tts.disable`, `tts.convert`, `tts.providers`)
- **User Commands**: `/tts_on`, `/tts_off`, `/tts_provider`, `/tts_limit`, `/tts_summary`, `/tts_status`
- **Auto-Summarization**: Long texts are automatically summarized before TTS conversion
- **Multi-provider**: ElevenLabs and OpenAI TTS with automatic fallback
- **Self-contained**: No external CLI dependencies - calls APIs directly

## Requirements

- **For TTS**: ElevenLabs API key OR OpenAI API key
- **For Auto-Summarization**: OpenAI API key (uses gpt-4o-mini to summarize long texts)

## Installation

The extension is bundled with Clawdbot. Enable it in your config:

```json
{
  "plugins": {
    "entries": {
      "telegram-tts": {
        "enabled": true,
        "provider": "elevenlabs",
        "elevenlabs": {
          "apiKey": "your-api-key"
        }
      }
    }
  }
}
```

Or use OpenAI:

```json
{
  "plugins": {
    "entries": {
      "telegram-tts": {
        "enabled": true,
        "provider": "openai",
        "openai": {
          "apiKey": "your-api-key",
          "voice": "nova"
        }
      }
    }
  }
}
```

Or set API keys via environment variables:

```bash
# For ElevenLabs
export ELEVENLABS_API_KEY=your-api-key
# or
export XI_API_KEY=your-api-key

# For OpenAI
export OPENAI_API_KEY=your-api-key
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable the plugin |
| `provider` | string | `"openai"` | TTS provider (`elevenlabs` or `openai`) |
| `elevenlabs.apiKey` | string | - | ElevenLabs API key |
| `elevenlabs.voiceId` | string | `"pMsXgVXv3BLzUgSXRplE"` | ElevenLabs Voice ID |
| `elevenlabs.modelId` | string | `"eleven_multilingual_v2"` | ElevenLabs Model ID |
| `openai.apiKey` | string | - | OpenAI API key |
| `openai.model` | string | `"gpt-4o-mini-tts"` | OpenAI model (`gpt-4o-mini-tts`, `tts-1`, or `tts-1-hd`) |
| `openai.voice` | string | `"alloy"` | OpenAI voice |
| `prefsPath` | string | `~/clawd/.user-preferences.json` | User preferences file |
| `maxTextLength` | number | `4000` | Max characters for TTS |
| `timeoutMs` | number | `30000` | API request timeout in milliseconds |

### OpenAI Voices

Available voices: `alloy`, `ash`, `coral`, `echo`, `fable`, `onyx`, `nova`, `sage`, `shimmer`

## Usage

### Agent Tool

The agent can use the `speak` tool to send voice messages:

```
User: Send me a voice message saying hello
Agent: [calls speak({ text: "Hello! How can I help you today?" })]
```

### RPC Methods

```bash
# Check TTS status
clawdbot gateway call tts.status

# Enable/disable TTS
clawdbot gateway call tts.enable
clawdbot gateway call tts.disable

# Convert text to audio
clawdbot gateway call tts.convert '{"text": "Hello world"}'

# List available providers
clawdbot gateway call tts.providers
```

### Telegram Commands

The plugin registers the following commands automatically:

| Command | Description |
|---------|-------------|
| `/tts_on` | Enable auto-TTS for all responses |
| `/tts_off` | Disable auto-TTS |
| `/tts_provider [openai\|elevenlabs]` | Switch TTS provider (with fallback) |
| `/tts_limit [chars]` | Set max text length before summarization (default: 1500) |
| `/tts_summary [on\|off]` | Enable/disable auto-summarization for long texts |
| `/tts_status` | Show TTS status, config, and last attempt result |

## Auto-Summarization

When enabled (default), texts exceeding the configured limit are automatically summarized using OpenAI's gpt-4o-mini before TTS conversion. This ensures long responses can still be converted to audio.

**Requirements**: OpenAI API key must be configured for summarization to work, even if using ElevenLabs for TTS.

**Behavior**:
- Texts under the limit are converted directly
- Texts over the limit are summarized first, then converted
- If summarization is disabled (`/tts_summary off`), long texts are skipped (no audio)
- After summarization, a hard limit is applied to prevent oversized TTS requests

## License

MIT
