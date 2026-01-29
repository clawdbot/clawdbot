# Research API Reference

## Table of Contents

- [Overview](#overview)
- [Prompting Best Practices](#prompting-best-practices)
- [Model Selection](#model-selection)
- [Key Parameters](#key-parameters)
- [Basic Usage](#basic-usage)
- [Streaming vs Polling](#streaming-vs-polling)
- [Structured Output vs Report](#structured-output-vs-report)
- [Response Fields](#response-fields)
- [Summary](#summary)

---

## Overview

The Research API conducts comprehensive research on any topic with automatic source gathering, analysis, and response generation with citations. It's an end-to-end solution when you need AI-powered research without building your own pipeline.

---

## Prompting Best Practices

Define a **clear goal** with all **details** and **direction**.

**Guidelines:**
- **Be specific when you can.** Include known details: target market, competitors, geography, constraints
- **Stay open-ended only for discovery.** Make it explicit: "tell me about the most impactful AI innovations in healthcare in 2025"
- **Avoid contradictions.** Don't include conflicting constraints or goals
- **Share what's already known.** Include prior assumptions so research doesn't repeat existing knowledge
- **Keep prompts clean and directed.** Clear task + essential context + desired output format

### Example Queries

**Company research:**
```
Research the company ____ and its 2026 outlook. Provide a brief overview
of the company, its products, services, and market position.
```

**Competitive analysis:**
```
Conduct a competitive analysis of ____ in 2026. Identify their main
competitors, compare market positioning, and analyze key differentiators.
```

**With prior context:**
```
We're evaluating Notion as a potential partner. We already know they
primarily serve SMB and mid-market teams, expanded their AI features
significantly in 2025, and most often compete with Confluence and ClickUp.
Research Notion's 2026 outlook, including market position, growth risks,
and where a partnership could be most valuable. Include citations.
```

---

## Model Selection

| Model | Best For |
|-------|----------|
| `pro` | Comprehensive, multi-agent research for complex, multi-domain topics |
| `mini` | Targeted, efficient research for narrow or well-scoped questions |
| `auto` | When unsure how complex research will be (default) |

### Pro Model

Multi-agent research suited for complex topics spanning multiple subtopics or domains. Use for deeper analysis, thorough reports, or maximum accuracy.

```python
result = client.research(
    input="Analyze the competitive landscape for ____ in the SMB market, "
          "including key competitors, positioning, pricing models, customer "
          "segments, recent product moves, and defensible advantages or risks "
          "over the next 2-3 years.",
    model="pro"
)
```

### Mini Model

Optimized for targeted, efficient research. Best for narrow or well-scoped questions where you still benefit from agentic searching and synthesis.

```python
result = client.research(
    input="What are the top 5 competitors to ____ in the SMB market, and how do they differentiate?",
    model="mini"
)
```

---

## Key Parameters

### research()

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `input` | string | Required | The research topic or question |
| `model` | enum | `"auto"` | `"mini"`, `"pro"`, or `"auto"` |
| `stream` | boolean | false | Enable streaming responses |
| `output_schema` | object | null | JSON Schema for structured output |
| `citation_format` | enum | `"numbered"` | `"numbered"`, `"mla"`, `"apa"`, `"chicago"` |

### get_research()

| Parameter | Type | Description |
|-----------|------|-------------|
| `request_id` | string | Task ID from `research()` response |

---

## Basic Usage

Research tasks are two-step: initiate with `research()`, retrieve with `get_research()`.

```python
import time
from tavily import TavilyClient

client = TavilyClient()

# Step 1: Start research task
result = client.research(
    input="Latest developments in quantum computing and their practical applications",
    model="pro"
)
request_id = result["request_id"]

# Step 2: Poll until completed
response = client.get_research(request_id)
while response["status"] not in ["completed", "failed"]:
    print(f"Status: {response['status']}... polling again in 10 seconds")
    time.sleep(10)
    response = client.get_research(request_id)

# Step 3: Handle result
if response["status"] == "failed":
    raise RuntimeError(f"Research failed: {response.get('error', 'Unknown error')}")

report = response["content"]
sources = response["sources"]
```

---

## Streaming vs Polling

**Streaming** — Best for user interfaces where you want real-time updates.
**Polling** — Best for background processes where you check status periodically.

### Streaming

Enable real-time progress monitoring with `stream=True`.

```python
stream = client.research(
    input="Latest developments in quantum computing",
    model="pro",
    stream=True
)

for chunk in stream:
    print(chunk.decode('utf-8'))
```

### Event Types

| Event Type | Description |
|------------|-------------|
| **Tool Call** | Agent initiates action (Planning, WebSearch, etc.) |
| **Tool Response** | Results after tool execution with sources |
| **Content** | Research report streamed as markdown (or JSON with `output_schema`) |
| **Sources** | Complete list of sources, emitted after content |
| **Done** | Signals completion |

### Tool Types

| Tool | Description | Models |
|------|-------------|--------|
| `Planning` | Initializes research strategy | mini, pro |
| `WebSearch` | Executes web searches | mini, pro |
| `Generating` | Creates final report | mini, pro |
| `ResearchSubtopic` | Deep research on subtopics | pro only |

### Typical Flow

1. `Planning` tool_call → tool_response
2. `WebSearch` tool_call → tool_response (with sources)
3. `ResearchSubtopic` cycles (Pro mode only)
4. `Generating` tool_call → tool_response
5. `Content` chunks (markdown or structured JSON)
6. `Sources` event
7. `Done` event

See [streaming cookbook](https://github.com/tavily-ai/tavily-cookbook/blob/main/cookbooks/research/streaming.ipynb) and [polling cookbook](https://github.com/tavily-ai/tavily-cookbook/blob/main/cookbooks/research/polling.ipynb) for complete examples.

---

## Structured Output vs. Report

| Format | Best For |
|--------|----------|
| **Report** (default) | Reading, sharing, or displaying verbatim (chat interfaces, briefs, newsletters) |
| **Structured Output** | Data enrichment, pipelines, or powering UIs with specific fields |

## Structured Output

Use `output_schema` to receive research in a predefined JSON structure.

```python
schema = {
    "properties": {
        "summary": {
            "type": "string",
            "description": "Executive summary of findings"
        },
        "key_points": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Main takeaways from the research"
        },
        "metrics": {
            "type": "object",
            "properties": {
                "market_size": {"type": "string", "description": "Total market size"},
                "growth_rate": {"type": "number", "description": "Annual growth percentage"}
            }
        }
    },
    "required": ["summary", "key_points"]
}

result = client.research(
    input="Electric vehicle market analysis 2024",
    output_schema=schema
)
```

### Schema Best Practices

- **Write clear field descriptions.** 1-3 sentences explaining what the field should contain
- **Match the structure you need.** Use arrays, objects, enums appropriately (e.g., `competitors: string[]`, not `"A, B, C"`)
- **Avoid duplicate fields.** Keep each field unique and specific
- **Use `required` arrays** to enforce mandatory fields at any nesting level

**Supported types:** `object`, `string`, `integer`, `number`, `array`

### Streaming with Structured Output

When `output_schema` is provided, content arrives as structured JSON:

```python
stream = client.research(
    input="AI agent frameworks comparison",
    model="mini",
    stream=True,
    output_schema={
        "properties": {
            "summary": {"type": "string", "description": "Executive summary"},
            "key_points": {"type": "array", "items": {"type": "string"}}
        },
        "required": ["summary", "key_points"]
    }
)

for chunk in stream:
    data = chunk.decode('utf-8')
    print(data)  # Content chunks will be structured JSON
```

---

## Response Fields

### research() Response

| Field | Description |
|-------|-------------|
| `request_id` | Unique identifier for tracking |
| `created_at` | Timestamp when task was created |
| `status` | Initial status |
| `input` | The research topic submitted |
| `model` | Model used by research agent |

### get_research() Response

| Field | Description |
|-------|-------------|
| `status` | `"pending"`, `"processing"`, `"completed"`, `"failed"` |
| `content` | Generated research report (when completed) |
| `sources` | Array of source citations |
| `response_time` | Time in seconds |

### Source Object

| Field | Description |
|-------|-------------|
| `url` | Source URL |
| `title` | Source title |
| `citation` | Formatted citation string |

---

## Summary

1. **Be specific in prompts** — Include known details: target market, competitors, geography, constraints
2. **Share prior context** — Include what you already know to avoid repetition
3. **Choose the right model** — `mini` for focused queries, `pro` for comprehensive multi-domain analysis
4. **Use streaming for UX** — Display real-time progress during long research tasks
5. **Use structured output for pipelines** — Define schemas for consistent, parseable responses
6. **Use reports for reading** — Default format is best for chat interfaces and sharing

For more examples, see the [Tavily Cookbook](https://github.com/tavily-ai/tavily-cookbook/tree/main/research) and [live demo](https://chat-research.tavily.com/).
