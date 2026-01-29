# Framework Integrations

## Table of Contents

- [LangChain](#langchain)
- [LlamaIndex](#llamaindex)
- [OpenAI Function Calling](#openai-function-calling)
- [Anthropic Tool Use](#anthropic-tool-use)
- [Vercel AI SDK](#vercel-ai-sdk)
- [CrewAI](#crewai)
- [No-Code Platforms](#no-code-platforms)

---

## LangChain

The `langchain-tavily` package is the official LangChain integration supporting Search, Extract, Map, Crawl, and Research.

### Installation

```bash
pip install -U langchain-tavily
```

### Search

```python
from langchain_tavily import TavilySearch

tool = TavilySearch(
    max_results=5,
    topic="general",  # or "news", "finance"
    # search_depth="basic",
    # include_answer=False,
    # include_raw_content=False,
)

# Direct invocation
result = tool.invoke({"query": "What happened at Wimbledon?"})

# With agent
from langchain.agents import create_agent
from langchain_openai import ChatOpenAI

agent = create_agent(
    model=ChatOpenAI(model="gpt-4"),
    tools=[tool],
    system_prompt="You are a helpful research assistant."
)
response = agent.invoke({
    "messages": [{"role": "user", "content": "What are the latest AI trends?"}]
})
```

**Dynamic parameters at invocation:**
- `include_images`, `search_depth`, `time_range`, `include_domains`, `exclude_domains`, `start_date`, `end_date`

### Extract

```python
from langchain_tavily import TavilyExtract

tool = TavilyExtract(
    extract_depth="basic",  # or "advanced"
    # include_images=False
)

result = tool.invoke({
    "urls": ["https://en.wikipedia.org/wiki/Lionel_Messi"]
})
```

### Map

```python
from langchain_tavily import TavilyMap

tool = TavilyMap()

result = tool.invoke({
    "url": "https://docs.example.com",
    "instructions": "Find all documentation and tutorial pages"
})
# Returns: {"base_url": ..., "results": [urls...], "response_time": ...}
```

### Crawl

```python
from langchain_tavily import TavilyCrawl

tool = TavilyCrawl()

result = tool.invoke({
    "url": "https://docs.example.com",
    "instructions": "Extract API documentation and code examples"
})
# Returns: {"base_url": ..., "results": [{url, raw_content}...], "response_time": ...}
```

### Research

```python
from langchain_tavily import TavilyResearch, TavilyGetResearch

# Start research
research_tool = TavilyResearch(model="mini")
result = research_tool.invoke({
    "input": "Research the latest developments in AI",
    "citation_format": "apa"
})

# Get results
get_tool = TavilyGetResearch()
final = get_tool.invoke({"request_id": result["request_id"]})
```

---

## LlamaIndex

```python
from llama_index.tools.tavily_research import TavilyToolSpec

# Initialize tools
tavily_tool = TavilyToolSpec(api_key="tvly-YOUR_API_KEY")
tools = tavily_tool.to_tool_list()

# Use with agent
from llama_index.agent.openai import OpenAIAgent

agent = OpenAIAgent.from_tools(tools)
response = agent.chat("What are the latest AI developments?")
```

---

## OpenAI Function Calling

Define Tavily as an OpenAI function:

```python
from openai import OpenAI
from tavily import TavilyClient
import json

openai_client = OpenAI()
tavily_client = TavilyClient()

tools = [{
    "type": "function",
    "function": {
        "name": "web_search",
        "description": "Search the web for current information",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The search query"
                }
            },
            "required": ["query"]
        }
    }
}]

def handle_tool_call(tool_call):
    if tool_call.function.name == "web_search":
        args = json.loads(tool_call.function.arguments)
        return tavily_client.search(args["query"])

# Chat completion with tools
response = openai_client.chat.completions.create(
    model="gpt-4",
    messages=[{"role": "user", "content": "What are the latest AI trends?"}],
    tools=tools
)

if response.choices[0].message.tool_calls:
    tool_call = response.choices[0].message.tool_calls[0]
    search_results = handle_tool_call(tool_call)

    # Continue conversation with results
    messages = [
        {"role": "user", "content": "What are the latest AI trends?"},
        response.choices[0].message,
        {"role": "tool", "tool_call_id": tool_call.id, "content": json.dumps(search_results)}
    ]
    final = openai_client.chat.completions.create(
        model="gpt-4",
        messages=messages
    )
```

---

## Anthropic Tool Use

Define Tavily as an Anthropic tool:

```python
from anthropic import Anthropic
from tavily import TavilyClient
import json

anthropic_client = Anthropic()
tavily_client = TavilyClient()

tools = [{
    "name": "web_search",
    "description": "Search the web for current information using Tavily",
    "input_schema": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "The search query"
            }
        },
        "required": ["query"]
    }
}]

def process_tool_use(tool_use):
    if tool_use.name == "web_search":
        return tavily_client.search(tool_use.input["query"])

# Initial request
response = anthropic_client.messages.create(
    model="claude-sonnet-4-20250514",
    max_tokens=1024,
    tools=tools,
    messages=[{"role": "user", "content": "What are the latest AI trends?"}]
)

# Handle tool use
if response.stop_reason == "tool_use":
    tool_use = next(b for b in response.content if b.type == "tool_use")
    search_results = process_tool_use(tool_use)

    # Continue with results
    final = anthropic_client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=1024,
        tools=tools,
        messages=[
            {"role": "user", "content": "What are the latest AI trends?"},
            {"role": "assistant", "content": response.content},
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": tool_use.id, "content": json.dumps(search_results)}
            ]}
        ]
    )
```

---

## Vercel AI SDK

The `@tavily/ai-sdk` package provides pre-built tools for Vercel AI SDK v5.

### Installation

```bash
npm install ai @ai-sdk/openai @tavily/ai-sdk
```

### Usage

```typescript
import { tavilySearch, tavilyCrawl } from "@tavily/ai-sdk";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

// Search
const result = await generateText({
  model: openai("gpt-4"),
  prompt: "What are the latest AI developments?",
  tools: {
    tavilySearch: tavilySearch({
      maxResults: 5,
      searchDepth: "advanced",
    }),
  },
});

// Crawl
const crawlResult = await generateText({
  model: openai("gpt-4"),
  prompt: "Crawl tavily.com and summarize their features",
  tools: {
    tavilyCrawl: tavilyCrawl({
      maxDepth: 2,
      limit: 50,
    }),
  },
});
```

**Available tools:** `tavilySearch`, `tavilyExtract`, `tavilyCrawl`, `tavilyMap`

---

## CrewAI

CrewAI provides built-in Tavily tools for multi-agent workflows.

### Installation

```bash
pip install 'crewai[tools]'
```

### Usage

```python
import os
from crewai import Agent, Task, Crew
from crewai_tools import TavilySearchTool, TavilyExtractTool

os.environ["TAVILY_API_KEY"] = "your-api-key"

# Search tool
search_tool = TavilySearchTool()

# Create agent with Tavily
researcher = Agent(
    role="Research Analyst",
    goal="Find and analyze information on given topics",
    tools=[search_tool],
    backstory="Expert at finding relevant information online"
)

task = Task(
    description="Research the latest developments in quantum computing",
    expected_output="A comprehensive summary with sources",
    agent=researcher
)

crew = Crew(agents=[researcher], tasks=[task])
result = crew.kickoff()
```

---

## No-Code Platforms

Tavily integrates with popular no-code automation platforms:

| Platform | Features | Best For |
|----------|----------|----------|
| **Zapier** | Search, Extract | CRM enrichment, automated research |
| **Make** | Search, Extract | Complex workflows, multi-step automations |
| **n8n** | Search, Extract, AI Agent tool | Self-hosted, AI agent workflows |
| **Dify** | Search, Extract | No-code AI apps, chatflows |
| **FlowiseAI** | Search | Visual LLM builders, RAG systems |
| **Langflow** | Search, Extract | Visual agent building |

### Common Use Cases

- **Lead enrichment**: Trigger on new CRM record → Search company info → Update record
- **Market monitoring**: Schedule → Search industry news → Send digest
- **Content research**: Trigger → Multi-search → LLM summarize → Store results

---

## Additional Integrations

| Framework | Package/Tool | Notes |
|-----------|--------------|-------|
| Pydantic AI | `pydantic-ai-slim[tavily]` | Type-safe AI agents |
| Google ADK | MCP Server | Gemini-powered agents |
| Composio | Composio platform | Multi-tool orchestration |
| Agno | `agno` + `tavily-python` | Lightweight agent framework |
| Tines | Native integration | Security automation |

See the [full integrations documentation](https://docs.tavily.com/documentation/integrations) for complete guides.
