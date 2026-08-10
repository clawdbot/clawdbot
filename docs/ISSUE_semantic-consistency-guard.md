# Semantic Consistency Guard: Detect and Correct Concept Drift in Agent Replies

## Problem Statement

### Observed Failure Mode

In long multi-turn conversations, the OpenClaw agent can produce replies where the same user-defined concept (e.g., "方案一", "option A") is correctly understood in one paragraph but **redefined with a different meaning** in a later paragraph of the **same reply**.

**Example from real usage:**

```
User defines:
  "方案一 = deploy graphify separately (in github conda env)
   方案二 = embed graphify inside robotassistant project"

Agent reply paragraph 1 (correct):
  "| 方案一（分开） | github 环境，跟 robotassistant 分离 |"

Agent reply paragraph 2 (drifted):
  "方案一就是装 uv tool 全局跑...方案二才是集成到项目里"
  ↑ "方案一" now means "uv tool install globally" instead of "separate deployment"
```

**Key properties of this failure:**
- The agent **correctly understood** the user's definitions (para 1 is accurate)
- The drift happened **within the same reply**, not across turns
- The agent was **unaware** of its own inconsistency because LLM generation lacks global "look-back" over its own output
- No existing OpenClaw mechanism detects or corrects this

### Why This Matters

As agent conversations grow longer and more complex (multi-session project planning, architecture discussions, code review), the risk of **silent semantic drift** increases linearly with context length. The user must manually catch and correct the agent's self-contradiction—defeating the purpose of an autonomous assistant.

### Why Prompt-Based Solutions Are Insufficient

Adding "please re-anchor your definitions" to SOUL.md or AGENTS.md is a **pre-generation nudge** that:
- The model can ignore during autoregressive generation
- Cannot prevent drift that happens 500+ tokens into a long reply
- Adds tokens to every reply, even trivial ones

We need a **post-generation guard** that systematically catches drift without relying on the model to police itself.

---

## Proposed Solution: Semantic Consistency Guard

A lightweight, **non-LLM**, rule-based guard inserted into the reply pipeline that:

1. **Detects** when the user's message contains contrasting structures (方案一/二, option A/B, approach 1/2, etc.)
2. **Extracts** the definitions the agent assigned to these concept labels in its reply
3. **Compares** them against the definitions in the user's prior message using simple text overlap metrics
4. **Flags** inconsistencies and triggers a correction loop: injects a system message with the detected drift, asks the agent to re-generate

### Design Principles

- **Zero LLM involvement** in the guard itself: regex detection + Jaccard similarity, no extra API calls
- **Zero latency for 99% of replies**: guard activates only when contrast structures are detected
- **Correction, not rejection**: guard doesn't block the reply; it alerts the agent to fix and re-send
- **Configurable**: on/off toggle in OpenClaw config, with adjustable sensitivity threshold
- **Single-round retry**: guard fires at most once per reply to avoid infinite loops

### Implementation Location

**`src/channels/message/reply-pipeline.ts` — `transformReplyPayload` hook**

The `transformReplyPayload` function in `createChannelReplyPipeline()` already runs between reply generation and channel delivery. It currently handles prefix resolution and channel-specific transforms. The guard would be an optional additional transform that:

1. Examines `payload.text` for concept definitions
2. Compares against extracted definitions from the user's prior message (available via the existing session/history context)
3. If drift detected → returns `null` (suppresses the payload) + triggers a correction event

### Guard Logic Pseudocode

```
function semanticConsistencyGuard(payload, conversationContext):
    // Step 1: Check if user message has contrast structure
    userPatterns = extractContrastPatterns(conversationContext.lastUserMessage)
    if userPatterns is empty:
        return (payload, null)  // pass through

    // Step 2: Extract how agent defined these concepts in its reply
    agentDefinitions = extractConceptDefinitions(payload.text, userPatterns.labels)

    // Step 3: Extract how user defined them (from user message + conversation anchor)
    userDefinitions = extractConceptDefinitions(
        conversationContext.lastUserMessage.text,
        userPatterns.labels
    )

    // Step 4: Compare
    drifted_concepts = []
    for (label, agentDef) in agentDefinitions:
        userDef = userDefinitions.get(label)
        if userDef and similarity(agentDef, userDef) < threshold:
            drifted_concepts.push({ label, userDef, agentDef })

    if drifted_concepts is empty:
        return (payload, null)  // pass through

    // Step 5: Build correction prompt
    correction = formatCorrectionPrompt(drifted_concepts)
    return (null, correction)  // suppress payload, trigger fix loop
```

### Contrast Pattern Detection (Regex-Based)

Supported Chinese patterns:
- `方案(一|二|三|四|五|六)` → labels: [方案一, 方案二, ...]
- `选项[A-E一二三四五]` → labels: [选项A, 选项B, ...]
- `方式[1-5一二三四五]` → labels: [方式1, 方式2, ...]
- `方法[一二三四五1-5]` → labels: [方法一, 方法二, ...]
- Numbered lists: `1. ... 2. ...` as contrasting alternatives

Supported English patterns:
- `Approach [A-C1-5]`
- `Option [A-C1-5]`
- `Method [A-C1-5]`
- `Plan [A-C]`

### Similarity Metric

Jaccard coefficient on tokenized (jieba for Chinese) definitions:
```
similarity = |tokens(A) ∩ tokens(B)| / |tokens(A) ∪ tokens(B)|
threshold = 0.3 (configurable)
```

### Correction Prompt Template

```
[SYSTEM] Semantic consistency check: In your reply, you defined concepts
differently than the user's definitions in a previous message.

User defined:
- "{{label1}}" as: {{userDef1}}
Your reply defined:
- "{{label1}}" as: {{agentDef1}}
Similarly for "{{label2}}": user="{{userDef2}}" vs yours="{{agentDef2}}"

Please confirm whether this redefinition was intentional, or re-generate
your reply using the user's original definitions.
```

---

## Configuration

```yaml
# In OpenClaw config
guard:
  semantic_consistency:
    enabled: true          # default: true
    threshold: 0.3         # Jaccard similarity threshold (0.0-1.0)
    max_retries: 1         # max correction attempts per reply
    languages: ["zh", "en"] # enabled language patterns
```

## Expected Impact

| Scenario | Without Guard | With Guard |
|---|---|---|
| Simple Q&A (no contrast patterns) | Normal reply | Identical (zero overhead) |
| Multi-option discussion, consistent reply | Normal reply | Identical (pass-through) |
| Multi-option discussion, drifted reply | User must catch and correct | Auto-detected, 1-round correction |
| Very short definitions (< 5 chars) | N/A | May false-positive at low thresholds; threshold tuning needed |

## Alternatives Considered

1. **LLM-based guard** (rejected): Adds latency + cost; guard model can also make mistakes; overkill for symbol-binding consistency check
2. **Prompt injection only** (rejected): Pre-generation nudges can't prevent post-generation drift within a single long reply
3. **Embedding-based similarity** (rejected): Adds dependency on embedding model; Jaccard is sufficient and zero-cost for this task
4. **Full semantic parser** (rejected): Overengineering; contrast structure + definition extraction is a regex problem, not an NLP problem

## Open Questions

1. **Should the guard fire on every reply or only when the user message contains contrast patterns?** Proposal: only on contrast pattern detection (minimizes latency impact)
2. **How to access "user's original definitions" in the pipeline?** Need to pass conversation context (at least last user message text) into the guard function
3. **Should the correction prompt be shown to the user or handled silently?** Proposal: silent correction by default; user only sees the final (corrected) reply
