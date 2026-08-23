---
role: best-practices
summary: |
  Design patterns for robust, efficient, and maintainable OpenProse programs.
  Read this file when authoring new programs or reviewing existing ones.
see-also:
  - prose.md: Execution semantics, how to run programs
  - compiler.md: Full syntax grammar, validation rules
  - antipatterns.md: Patterns to avoid
---

# OpenProse Design Patterns

This document catalogs proven patterns for orchestrating AI agents effectively. Each pattern addresses specific concerns: robustness, cost efficiency, speed, maintainability, or self-improvement capability.

---

## Structural Patterns

#### parallel-independent-work

When tasks have no data dependencies, execute them concurrently. This maximizes throughput and minimizes wall-clock time.

```prose
# Good: Independent research runs in parallel
parallel:
  market = session "Research market trends"
  tech = session "Research technology landscape"
  competition = session "Analyze competitor products"

session "Synthesize findings"
  context: { market, tech, competition }
```

The synthesis session waits for all branches, but total time equals the longest branch rather than the sum of all branches.

#### fan-out-fan-in

For processing collections, fan out to parallel workers then collect results. Use `parallel for` instead of manual parallel branches.

```prose
let topics = ["AI safety", "interpretability", "alignment", "robustness"]

parallel for topic in topics:
  session "Deep dive research on {topic}"

session "Create unified report from all research"
```

This scales naturally with collection size and keeps code DRY.

#### pipeline-composition

Chain transformations using pipe operators for readable data flow. Each stage has a single responsibility.

```prose
let candidates = session "Generate 10 startup ideas"

let result = candidates
  | filter:
      session "Is this idea technically feasible? yes/no"
        context: item
  | map:
      session "Expand this idea into a one-page pitch"
        context: item
  | reduce(best, current):
      session "Compare these two pitches, return the stronger one"
        context: [best, current]
```

#### agent-specialization

Define agents with focused expertise. Specialized agents produce better results than generalist prompts.

```prose
agent security-reviewer:
  model: sonnet
  prompt: """
    You are a security expert. Focus exclusively on:
    - Authentication and authorization flaws
    - Injection vulnerabilities
    - Data exposure risks
    Ignore style, performance, and other concerns.
  """

agent performance-reviewer:
  model: sonnet
  prompt: """
    You are a performance engineer. Focus exclusively on:
    - Algorithmic complexity
    - Memory usage patterns
    - I/O bottlenecks
    Ignore security, style, and other concerns.
  """
```

#### reusable-blocks

Extract repeated workflows into parameterized blocks. Blocks are the functions of OpenProse.

```prose
block review-and-revise(artifact, criteria):
  let feedback = session "Review {artifact} against {criteria}"
  session "Revise {artifact} based on feedback"
    context: feedback

# Reuse the pattern
do review-and-revise("the architecture doc", "clarity and completeness")
do review-and-revise("the API design", "consistency and usability")
do review-and-revise("the test plan", "coverage and edge cases")
```

---

## Robustness Patterns

#### bounded-iteration

Always constrain loops with `max:` to prevent runaway execution. Even well-crafted conditions can fail to terminate.

```prose
# Good: Explicit upper bound
loop until **all tests pass** (max: 20):
  session "Identify and fix the next failing test"

# The program will terminate even if tests never fully pass
```

#### graceful-degradation

Use `on-fail: "continue"` when partial results are acceptable. Collect what you can rather than failing entirely.

```prose
parallel (on-fail: "continue"):
  primary = session "Query primary data source"
  backup = session "Query backup data source"
  cache = session "Check local cache"

# Continue with whatever succeeded
session "Merge available data"
  context: { primary, backup, cache }
```

#### retry-with-backoff

External services fail transiently. Retry with exponential backoff to handle rate limits and temporary outages.

```prose
session "Call external API"
  retry: 5
  backoff: "exponential"
```

For critical paths, combine retry with fallback:

```prose
try:
  session "Call primary API"
    retry: 3
    backoff: "exponential"
catch:
  session "Use fallback data source"
```

#### error-context-capture

Capture error context for intelligent recovery. The error variable provides information for diagnostic or remediation sessions.

```prose
try:
  session "Deploy to production"
catch as err:
  session "Analyze deployment failure and suggest fixes"
    context: err
  session "Attempt automatic remediation"
    context: err
```

#### defensive-context

Validate assumptions before expensive operations. Cheap checks prevent wasted computation.

```prose
let prereqs = session "Check all prerequisites: API keys, permissions, dependencies"

if **prerequisites are not met**:
  session "Report missing prerequisites and exit"
    context: prereqs
  throw "Prerequisites not satisfied"

# Expensive operations only run if prereqs pass
session "Execute main workflow"
```

---

## Cost Efficiency Patterns

#### model-tiering

Match model capability to task complexity:

| Model          | Best For                                     | Examples                                                     |
| -------------- | -------------------------------------------- | ------------------------------------------------------------ |
| **Sonnet 4.5** | Orchestration, control flow, coordination    | VM execution, captain's chair, workflow routing              |
| **Opus 4.5**   | Hard/difficult work requiring deep reasoning | Complex analysis, strategic decisions, novel problem-solving |
| **Haiku**      | Simple, self-evident tasks (use sparingly)   | Classification, summarization, formatting                    |

**Key insight:** Sonnet 4.5 excels at _orchestrating_ agents and managing control flow—it's the ideal model for the OpenProse VM itself and for "captain" agents that coordinate work. Opus 4.5 should be reserved for agents doing genuinely difficult intellectual work. Haiku can handle simple tasks but should generally be avoided where quality matters.

**Detailed task-to-model mapping:**

| Task Type                                | Model  | Rationale                                 |
| ---------------------------------------- | ------ | ----------------------------------------- |
| Orchestration, routing, coordination     | Sonnet | Fast, good at following structure         |
| Investigation, debugging, diagnosis      | Sonnet | Structured analysis, checklist-style work |
| Triage, classification, categorization   | Sonnet | Clear criteria, deterministic decisions   |
| Code review, verification (checklist)    | Sonnet | Following defined review criteria         |
| Simple implementation, fixes             | Sonnet | Applying known patterns                   |
| Complex multi-file synthesis             | Opus   | Needs to hold many things in context      |
| Novel architecture, strategic planning   | Opus   | Requires creative problem-solving         |
| Ambiguous problems, unclear requirements | Opus   | Needs to reason through uncertainty       |

**Rule of thumb:** If you can write a checklist for the task, Sonnet can do it. If the task requires genuine creativity or navigating ambiguity, use Opus.

```prose
agent captain:
  model: sonnet  # Orchestration and coordination
  persist: true  # Execution-scoped (dies with run)
  prompt: "You coordinate the team and review work"

agent researcher:
  model: opus  # Hard analytical work
  prompt: "You perform deep research and analysis"

agent formatter:
  model: haiku  # Simple transformation (use sparingly)
  prompt: "You format text into consistent structure"

agent preferences:
  model: sonnet
  persist: user  # User-scoped (survives across projects)
  prompt: "You remember user preferences and patterns"

# Captain orchestrates, specialists do the hard work
session: captain
  prompt: "Plan the research approach"

let findings = session: researcher
  prompt: "Investigate the technical architecture"

resume: captain
  prompt: "Review findings and determine next steps"
  context: findings
```

#### context-minimization

Pass only relevant context. Large contexts slow processing and increase costs.

```prose
# Bad: Passing everything
session "Write executive summary"
  context: [raw_data, analysis, methodology, appendices, references]

# Good: Pass only what's needed
let key_findings = session "Extract key findings from analysis"
  context: analysis

session "Write executive summary"
  context: key_findings
```

#### early-termination

Exit loops as soon as the goal is achieved. Don't iterate unnecessarily.

```prose
# The condition is checked each iteration
loop until **solution found and verified** (max: 10):
  session "Generate potential solution"
  session "Verify solution correctness"
# Exits immediately when condition is met, not after max iterations
```

#### early-signal-exit

When observing or monitoring, exit as soon as you have a definitive answer—don't wait for the full observation window.

```prose
# Good: Exit on signal
let observation = session: observer
  prompt: "Watch the stream. Signal immediately if you detect a blocking error."
  timeout: 120s
  early_exit: **blocking_error detected**

# Bad: Fixed observation window
loop 30 times:
  resume: observer
    prompt: "Keep watching..."  # Even if error was obvious at iteration 2
```

This respects signals when they arrive rather than waiting for arbitrary timeouts.

#### defaults-over-prompts

For standard configuration, use constants or environment variables. Only prompt when genuinely variable.

```prose
# Good: Sensible defaults
const API_URL = "https://api.example.com"
const TEST_PROGRAM = "# Simple test\nsession 'Hello'"

# Slower: Prompting for known values
let api_url = input "Enter API URL"  # Usually the same value
let program = input "Enter test program"  # Usually the same value
```

If 90% of runs use the same value, hardcode it. Let users override via CLI args if needed.

#### race-for-speed

When any valid result suffices, race multiple approaches and take the first success.

```prose
parallel ("first"):
  session "Try algorithm A"
  session "Try algorithm B"
  session "Try algorithm C"

# Continues as soon as any approach completes
session "Use winning result"
```

#### batch-similar-work

Group similar operations to amortize overhead. One session with structured output beats many small sessions.

```prose
# Inefficient: Many small sessions
for file in files:
  session "Analyze {file}"

# Efficient: Batch analysis
session "Analyze all files and return structured findings for each"
  context: files
```

---

## Self-Improvement Patterns

#### self-verification-in-prompt

For tasks that would otherwise require a separate verifier, include verification as the final step in the prompt. This saves a round-trip while maintaining rigor.

```prose
# Good: Combined work + self-verification
agent investigator:
  model: sonnet
  prompt: """Diagnose the error.
  1. Examine code paths
  2. Check logs and state
  3. Form hypothesis
  4. BEFORE OUTPUTTING: Verify your evidence supports your conclusion.

  Output only if confident. If uncertain, state what's missing."""

# Slower: Separate verifier agent
let diagnosis = session: researcher
  prompt: "Investigate the error"
let verification = session: verifier
  prompt: "Verify this diagnosis"  # Extra round-trip
  context: diagnosis
```

Use a separate verifier when you need genuine adversarial review (different perspective), but for self-consistency checks, bake verification into the prompt.

#### iterative-refinement

Use feedback loops to progressively improve outputs. Each iteration builds on the previous.

```prose
let draft = session "Create initial draft"

loop until **draft meets quality bar** (max: 5):
  let critique = session "Critically evaluate this draft"
    context: draft
  draft = session "Improve draft based on critique"
    context: [draft, critique]

session "Finalize and publish"
  context: draft
```

#### multi-perspective-review

Gather diverse viewpoints before synthesis. Different lenses catch different issues.

```prose
parallel:
  user_perspective = session "Evaluate from end-user viewpoint"
  tech_perspective = session "Evaluate from engineering viewpoint"
  business_perspective = session "Evaluate from business viewpoint"

session "Synthesize feedback and prioritize improvements"
  context: { user_perspective, tech_perspective, business_perspective }
```

#### adversarial-validation

Use one agent to challenge another's work. Adversarial pressure improves robustness.

```prose
let proposal = session "Generate proposal"

let critique = session "Find flaws and weaknesses in this proposal"
  context: proposal

let defense = session "Address each critique with evidence or revisions"
  context: [proposal, critique]

session "Produce final proposal incorporating valid critiques"
  context: [proposal, critique, defense]
```

#### consensus-building

For critical decisions, require agreement between independent evaluators.

```prose
parallel:
  eval1 = session "Independently evaluate the solution"
  eval2 = session "Independently evaluate the solution"
  eval3 = session "Independently evaluate the solution"

loop until **evaluators agree** (max: 3):
  session "Identify points of disagreement"
    context: { eval1, eval2, eval3 }
  parallel:
    eval1 = session "Reconsider position given other perspectives"
      context: { eval1, eval2, eval3 }
    eval2 = session "Reconsider position given other perspectives"
      context: { eval1, eval2, eval3 }
    eval3 = session "Reconsider position given other perspectives"
      context: { eval1, eval2, eval3 }

session "Document consensus decision"
  context: { eval1, eval2, eval3 }
```

---

## Maintainability Patterns

#### descriptive-agent-names

Name agents for their role, not their implementation. Names should convey purpose.

```prose
# Good: Role-based naming
agent code-reviewer:
agent technical-writer:
agent data-analyst:

# Bad: Implementation-based naming
agent opus-agent:
agent session-1-handler:
agent helper:
```

#### prompt-as-contract

Write prompts that specify expected inputs and outputs. Clear contracts prevent misunderstandings.

```prose
agent json-extractor:
  model: haiku
  prompt: """
    Extract structured data from text.

    Input: Unstructured text containing entity information
    Output: JSON object with fields: name, date, amount, status

    If a field cannot be determined, use null.
    Never invent information not present in the input.
  """
```

#### separation-of-concerns

Each session should do one thing well. Combine simple sessions rather than creating complex ones.

```prose
# Good: Single responsibility per session
let data = session "Fetch and validate input data"
let analysis = session "Analyze data for patterns"
  context: data
let recommendations = session "Generate recommendations from analysis"
  context: analysis
session "Format recommendations as report"
  context: recommendations

# Bad: God session
session "Fetch data, analyze it, generate recommendations, and format a report"
```

#### explicit-context-flow

Make data flow visible through explicit context passing. Avoid relying on implicit conversation history.

```prose
# Good: Explicit flow
let step1 = session "First step"
let step2 = session "Second step"
  context: step1
let step3 = session "Third step"
  context: [step1, step2]

# Bad: Implicit flow (relies on conversation state)
session "First step"
session "Second step using previous results"
session "Third step using all previous"
```

---

## Performance Patterns

#### lazy-evaluation

Defer expensive operations until their results are needed. Don't compute what might not be used.

```prose
session "Assess situation"

if **detailed analysis needed**:
  # Expensive operations only when necessary
  parallel:
    deep_analysis = session "Perform deep analysis"
      model: opus
    historical = session "Gather historical comparisons"
  session "Comprehensive report"
    context: { deep_analysis, historical }
else:
  session "Quick summary"
    model: haiku
```

#### progressive-disclosure

Start with fast, cheap operations. Escalate to expensive ones only when needed.

```prose
# Tier 1: Fast screening (haiku)
let initial = session "Quick assessment"
  model: haiku

if **needs deeper review**:
  # Tier 2: Moderate analysis (sonnet)
  let detailed = session "Detailed analysis"
    model: sonnet
    context: initial

  if **needs expert review**:
    # Tier 3: Deep reasoning (opus)
    session "Expert-level analysis"
      model: opus
      context: [initial, detailed]
```

#### work-stealing

Use `parallel ("any", count: N)` to get results as fast as possible from a pool of workers.

```prose
# Get 3 good ideas as fast as possible from 5 parallel attempts
parallel ("any", count: 3, on-fail: "ignore"):
  session "Generate creative solution approach 1"
  session "Generate creative solution approach 2"
  session "Generate creative solution approach 3"
  session "Generate creative solution approach 4"
  session "Generate creative solution approach 5"

session "Select best from the first 3 completed"
```

---

## Composition Patterns

#### workflow-template

Create blocks that encode entire workflow patterns. Instantiate with different parameters.

```prose
block research-report(topic, depth):
  let research = session "Research {topic} at {depth} level"
  let analysis = session "Analyze findings about {topic}"
    context: research
  let report = session "Write {depth}-level report on {topic}"
    context: [research, analysis]

# Instantiate for different needs
do research-report("market trends", "executive")
do research-report("technical architecture", "detailed")
do research-report("competitive landscape", "comprehensive")
```

#### middleware-pattern

Wrap sessions with cross-cutting concerns like logging, timing, or validation.

```prose
block with-validation(task, validator):
  let result = session "{task}"
  let valid = session "{validator}"
    context: result
  if **validation failed**:
    throw "Validation failed for: {task}"

do with-validation("Generate SQL query", "Check SQL for injection vulnerabilities")
do with-validation("Generate config file", "Validate config syntax")
```

#### circuit-breaker

After repeated failures, stop trying and fail fast. Prevents cascading failures.

```prose
let failures = 0
let max_failures = 3

loop while **service needed and failures < max_failures** (max: 10):
  try:
    session "Call external service"
    # Reset on success
    failures = 0
  catch:
    failures = failures + 1
    if **failures >= max_failures**:
      session "Circuit open - using fallback"
      throw "Service unavailable"
```

---

## Observability Patterns

#### checkpoint-narration

For long workflows, emit progress markers. Helps with debugging and monitoring.

```prose
session "Phase 1: Data Collection"
# ... collection work ...

session "Phase 2: Analysis"
# ... analysis work ...

session "Phase 3: Report Generation"
# ... report work ...

session "Phase 4: Quality Assurance"
# ... QA work ...
```

#### structured-output-contracts

Request structured outputs that can be reliably parsed and validated.

```prose
agent structured-reviewer:
  model: sonnet
  prompt: """
    Always respond with this exact JSON structure:
    {
      "verdict": "pass" | "fail" | "needs_review",
      "issues": [{"severity": "high"|"medium"|"low", "description": "..."}],
      "suggestions": ["..."]
    }
  """

let review = session: structured-reviewer
  prompt: "Review this code for security issues"
```

---

## Summary

The most effective OpenProse programs combine these patterns:

1. **Structure**: Parallelize independent work, use blocks for reuse
2. **Robustness**: Bound loops, handle errors, retry transient failures
3. **Efficiency**: Tier models, minimize context, terminate early
4. **Quality**: Iterate, get multiple perspectives, validate adversarially
5. **Maintainability**: Name clearly, separate concerns, make flow explicit

Choose patterns based on your specific constraints. A quick prototype prioritizes speed over robustness. A production workflow prioritizes reliability over cost. A research exploration prioritizes thoroughness over efficiency.
