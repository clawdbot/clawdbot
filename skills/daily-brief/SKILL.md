---
name: "daily-brief"
description: "Generate comprehensive daily briefings from communication channels, calendar, and health data"
author: "Clawdbot"
version: "1.0.0"
tags: ["productivity", "communication", "health", "automation", "voice"]
triggers:
  - "daily brief"
  - "morning briefing"
  - "daily summary"
  - "brief me"
  - "what's happening today"
parameters:
  - name: "date"
    type: "string"
    description: "Date for the brief (YYYY-MM-DD format, defaults to today)"
    required: false
  - name: "voice"
    type: "boolean"
    description: "Generate voice output (defaults to true)"
    required: false
  - name: "format"
    type: "string"
    description: "Output format - 'text', 'voice', or 'both' (defaults to 'both')"
    required: false
---

# Daily Brief Skill

Generates comprehensive daily briefings by gathering information from multiple personal communication and data sources, synthesizing it into a concise text summary, and optionally converting it to voice using ElevenLabs.

## Features

- **Multi-Source Data Collection**: Gathers data from iMessage, WhatsApp, Gmail, Google Calendar, Reminders, Notes, and Whoop health metrics
- **Intelligent Synthesis**: Uses LLM-powered filtering to extract only relevant and actionable information
- **Contact Resolution**: Integrates with contactbook for dynamic name resolution in communications
- **Meeting Preparation**: Enhances calendar events with company information via brave-search
- **Voice Generation**: Converts briefs to natural speech using ElevenLabsKit (replacing previous sag implementation)
- **Comprehensive Logging**: Detailed execution logs for debugging and monitoring

## Data Sources

### Communication Channels
- **iMessage**: Recent messages and conversations
- **WhatsApp**: WhatsApp messages and media references
- **Gmail**: Important emails and notifications

### Calendar & Tasks
- **Google Calendar**: Today's meetings and events with attendee information
- **Reminders**: Active and pending reminders
- **Notes**: Recent notes and annotations

### Health & Fitness
- **Whoop Metrics**: Daily health metrics (HRV, recovery, etc.)
- **Whoop Workouts**: Recent workout data and performance
- **Whoop Sleep**: Sleep quality and duration data

## Processing Pipeline

### 1. Data Gathering (`gather.sh`)
Collects raw data from all configured sources into timestamped JSON files in `/tmp/daily-brief-YYYY-MM-DD/`.

**Supported Commands:**
- `imsg` - iMessage data
- `wacli` - WhatsApp data
- `gog` - Gmail and Google Calendar
- `braindump` - Reminders and Notes
- `whoop` - Whoop health data

### 2. Formatting & Synthesis (`format.sh`)
Processes raw data through intelligent filtering and synthesis:

- **Relevance Filtering**: Uses LLM summarization to extract key information
- **Contact Resolution**: Resolves phone numbers to names using contactbook
- **Meeting Enhancement**: Adds company information for meeting attendees
- **Content Organization**: Structures information by priority and type

### 3. Voice Generation (`voice.sh`)
Converts the formatted text brief to speech:

- **Engine**: ElevenLabsKit CLI (Swift-based SDK)
- **Voice Selection**: Configurable voice ID (defaults to "Roger")
- **Text Sanitization**: Removes markdown formatting for optimal TTS
- **Output**: MP3 audio file

### 4. Orchestration (`brief.sh`)
Main pipeline coordinator that runs the complete workflow with comprehensive logging and error handling.

## Configuration

### Environment Variables
Create a `.env` file in the skill directory:

```bash
# ElevenLabs Configuration
ELEVENLABS_BIN="$HOME/Developer/ElevenLabsKit/Examples/ElevenLabsKitCLI/.build/release/ElevenLabsKitCLI"
ELEVENLABS_API_KEY="your-elevenlabs-api-key"
DAILY_BRIEF_DEFAULT_VOICE="Roger"
ELEVENLABS_FORMAT="mp3_44100_128"
```

### API Keys Required
- **ElevenLabs API Key**: For voice generation (check 3-custom-voice limit)
- **Contactbook**: For contact resolution (if available)
- **Brave Search**: For meeting attendee company lookup (if available)

## Usage Examples

### Basic Usage
```bash
# Generate today's brief with both text and voice
./daily-brief/scripts/brief.sh

# Generate brief for specific date
./daily-brief/scripts/brief.sh 2024-01-15
```

### Individual Components
```bash
# Just gather data
./daily-brief/scripts/gather.sh

# Just format existing data
./daily-brief/scripts/format.sh

# Just generate voice from existing brief
./daily-brief/scripts/voice.sh
```

### Output Files
All outputs are saved to `/tmp/daily-brief-YYYY-MM-DD/`:
- `final_brief.md` - Formatted text summary
- `daily-brief.mp3` - Voice audio (if voice generation succeeds)
- `data_summary.md` - Data collection statistics
- `*.log` - Execution logs for each step

## Dependencies

### Required Tools
- `imsg` - iMessage CLI tool
- `wacli` - WhatsApp CLI tool
- `gog` - Google services CLI tool
- `braindump` - Notes/Reminders CLI tool
- `whoop` - Whoop health data CLI tool
- `contactbook` - Contact resolution tool (optional)
- `brave-search` - Web search tool (optional)
- `summarize` - LLM summarization tool (optional)

### ElevenLabs Setup
1. Clone the ElevenLabsKit repository:
   ```bash
   cd ~/Developer
   git clone https://github.com/steipete/ElevenLabsKit.git
   ```

2. Build the CLI tool:
   ```bash
   cd ElevenLabsKit/Examples/ElevenLabsKitCLI
   swift build --configuration release
   ```

3. Configure API key and binary path in `.env`

## Voice Generation Notes

- **API Limits**: User has hit 3-custom-voice limit on ElevenLabs
- **Standard Voices**: Use built-in voices like "Roger", "Bella", "Antoni", etc.
- **Fallback**: If voice generation fails, text brief is still available
- **Text Sanitization**: Markdown formatting is automatically removed for optimal TTS

## Error Handling

The pipeline is designed to be resilient:
- Missing data sources are logged as warnings but don't stop execution
- Voice generation failures don't prevent text brief creation
- Comprehensive logging at each step for debugging
- Graceful degradation when optional tools are unavailable

## Integration Notes

- Designed for integration with Clawdbot's automation workflows
- Can be triggered by voice commands or scheduled execution
- Outputs are suitable for display, reading, or further processing
- Temporary files are cleaned up automatically after processing

## Future Enhancements

- Additional data sources (Slack, Discord, etc.)
- Custom voice model training within API limits
- Streaming voice output for real-time briefing
- Integration with smart home devices for voice playback
- Personalized briefing preferences and filtering rules