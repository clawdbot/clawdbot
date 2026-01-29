---
name: research
description: "Get AI-synthesized research on any topic with citations, directly in your terminal. Supports structured JSON output for pipelines. Use when you need comprehensive research grounded in web data without writing code."
---

# Research Skill

Conduct comprehensive research on any topic with automatic source gathering, analysis, and response generation with citations.

## Prerequisites

**Tavily API Key Required** - Get your key at https://tavily.com

Add to `~/.claude/settings.json`:
```json
{
  "env": {
    "TAVILY_API_KEY": "tvly-your-api-key-here"
  }
}
```

## Quick Start

> **Tip**: Research can take 30-120 seconds. Press **Ctrl+B** to run in the background.

### Using the Script

```bash
./scripts/research.sh '<json>' [output_file]
```

**Examples:**
```bash
# Basic research
./scripts/research.sh '{"input": "quantum computing trends"}'

# With pro model for comprehensive analysis
./scripts/research.sh '{"input": "AI agents comparison", "model": "pro"}'

# Save to file
./scripts/research.sh '{"input": "market analysis for EVs", "model": "pro"}' ./ev-report.md

# With custom citation format
./scripts/research.sh '{"input": "climate change impacts", "model": "mini", "citation_format": "apa"}'

# With structured output schema
./scripts/research.sh '{"input": "fintech startups 2025", "model": "pro", "output_schema": {"properties": {"summary": {"type": "string"}, "companies": {"type": "array", "items": {"type": "string"}}}, "required": ["summary"]}}'
```

### Basic Research

```bash
curl --request POST \
  --url https://api.tavily.com/research \
  --header "Authorization: Bearer $TAVILY_API_KEY" \
  --header 'Content-Type: application/json' \
  --data '{
    "input": "Latest developments in quantum computing",
    "model": "mini",
    "stream": false,
    "citation_format": "numbered"
  }'
```

> **Note**: Streaming is disabled for token management. The call waits until research completes and returns clean JSON.

### With Custom Schema

```bash
curl --request POST \
  --url https://api.tavily.com/research \
  --header "Authorization: Bearer $TAVILY_API_KEY" \
  --header 'Content-Type: application/json' \
  --data '{
    "input": "Electric vehicle market analysis",
    "model": "pro",
    "stream": false,
    "citation_format": "numbered",
    "output_schema": {
      "properties": {
        "market_overview": {
          "type": "string",
          "description": "2-3 sentence overview of the market"
        },
        "key_players": {
          "type": "array",
          "description": "Major companies in this market",
          "items": {
            "type": "object",
            "properties": {
              "name": {"type": "string", "description": "Company name"},
              "market_share": {"type": "string", "description": "Approximate market share"}
            },
            "required": ["name"]
          }
        }
      },
      "required": ["market_overview", "key_players"]
    }
  }'
```

## API Reference

### Endpoint

```
POST https://api.tavily.com/research
```

### Headers

| Header | Value |
|--------|-------|
| `Authorization` | `Bearer <TAVILY_API_KEY>` |
| `Content-Type` | `application/json` |

### Request Body

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `input` | string | Required | Research topic or question |
| `model` | string | `"mini"` | Model: `mini`, `pro`, `auto` |
| `stream` | boolean | `false` | Streaming disabled for token management |
| `output_schema` | object | null | JSON schema for structured output |
| `citation_format` | string | `"numbered"` | Citation format: `numbered`, `mla`, `apa`, `chicago` |

### Response Format (JSON)

With `stream: false`, the response is clean JSON:

```json
{
  "content": "# Research Results\n\n...",
  "sources": [{"url": "https://...", "title": "Source Title"}],
  "response_time": 45.2
}
```

## Model Selection

**Rule of thumb**: "what does X do?" -> mini. "X vs Y vs Z" or "best way to..." -> pro.

| Model | Use Case | Speed |
|-------|----------|-------|
| `mini` | Single topic, targeted research | ~30s |
| `pro` | Comprehensive multi-angle analysis | ~60-120s |
| `auto` | API chooses based on complexity | Varies |

## Schema Usage

Schemas make output structured and predictable. Every property **MUST** include both `type` and `description`.

```json
{
  "properties": {
    "summary": {
      "type": "string",
      "description": "2-3 sentence executive summary"
    },
    "key_points": {
      "type": "array",
      "description": "Main takeaways",
      "items": {"type": "string"}
    }
  },
  "required": ["summary", "key_points"]
}
```

## Examples

### Market Research

```bash
curl --request POST \
  --url https://api.tavily.com/research \
  --header "Authorization: Bearer $TAVILY_API_KEY" \
  --header 'Content-Type: application/json' \
  --data '{
    "input": "Fintech startup landscape 2025",
    "model": "pro",
    "stream": false,
    "citation_format": "numbered",
    "output_schema": {
      "properties": {
        "market_overview": {"type": "string", "description": "Executive summary of fintech market"},
        "top_startups": {
          "type": "array",
          "description": "Notable fintech startups",
          "items": {
            "type": "object",
            "properties": {
              "name": {"type": "string", "description": "Startup name"},
              "focus": {"type": "string", "description": "Primary business focus"},
              "funding": {"type": "string", "description": "Total funding raised"}
            },
            "required": ["name", "focus"]
          }
        },
        "trends": {"type": "array", "description": "Key market trends", "items": {"type": "string"}}
      },
      "required": ["market_overview", "top_startups"]
    }
  }'
```

### Technical Comparison

```bash
curl --request POST \
  --url https://api.tavily.com/research \
  --header "Authorization: Bearer $TAVILY_API_KEY" \
  --header 'Content-Type: application/json' \
  --data '{
    "input": "LangGraph vs CrewAI for multi-agent systems",
    "model": "pro",
    "stream": false,
    "citation_format": "mla"
  }'
```

### Quick Overview

```bash
curl --request POST \
  --url https://api.tavily.com/research \
  --header "Authorization: Bearer $TAVILY_API_KEY" \
  --header 'Content-Type: application/json' \
  --data '{
    "input": "What is retrieval augmented generation?",
    "model": "mini",
    "stream": false
  }'
```
