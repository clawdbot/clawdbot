---
role: antipatterns
summary: |
  Common mistakes and patterns to avoid in OpenProse programs.
  Read this file to identify and fix problematic code patterns.
see-also:
  - prose.md: Execution semantics, how to run programs
  - compiler.md: Full syntax grammar, validation rules
  - patterns.md: Recommended design patterns
---

# OpenProse Antipatterns

This document catalogs patterns that lead to brittle, expensive, slow, or unmaintainable programs. Each antipattern includes recognition criteria and remediation guidance.

---

## Structural Antipatterns

#### god-session

A single session that tries to do everything. God sessions are hard to debug, impossible to parallelize, and produce inconsistent results.

```prose
# Bad: One session doing too much
session """
  Read all the code in the repository.
  Identify security vulnerabilities.
  Find performance bottlenecks.
  Check for style violations.
  Generate a comprehensive report.
  Suggest fixes for each issue.
  Prioritize by severity.
  Create a remediation plan.
"""
```

**Why it's bad**: The session has no clear completion criteria. It mixes concerns that could be parallelized. Failure anywhere fails everything.

**Fix**: Decompose into focused sessions:

```prose
# Good: Focused sessions
parallel:
  security = session "Identify security vulnerabilities"
  perf = session "Find performance bottlenecks"
  style = session "Check for style violations"

session "Synthesize findings and prioritize by severity"
  context: { security, perf, style }

session "Create remediation plan"
```

#### sequential-when-parallel

Running independent operations sequentially when they could run concurrently. Wastes wall-clock time.

```prose
# Bad: Sequential independent work
let market = session "Research market"
let tech = session "Research technology"
let competition = session "Research competition"

session "Synthesize"
  context: [market, tech, competition]
```

**Why it's bad**: Total time is sum of all research times. Each session waits for the previous one unnecessarily.

**Fix**: Parallelize independent work:

```prose
# Good: Parallel independent work
parallel:
  market = session "Research market"
  tech = session "Research technology"
  competition = session "Research competition"

session "Synthesize"
  context: { market, tech, competition }
```

#### spaghetti-context

Context passed haphazardly without clear data flow. Makes programs hard to understand and modify.

```prose
# Bad: Unclear what context is actually used
let a = session "Step A"
let b = session "Step B"
  context: a
let c = session "Step C"
  context: [a, b]
let d = session "Step D"
  context: [a, b, c]
let e = session "Step E"
  context: [a, c, d]  # Why not b?
let f = session "Step F"
  context: [a, b, c, d, e]  # Everything?
```

**Why it's bad**: Unclear which sessions depend on which outputs. Hard to parallelize or refactor.

**Fix**: Minimize context to actual dependencies:

```prose
# Good: Clear, minimal dependencies
let research = session "Research"
let analysis = session "Analyze"
  context: research
let recommendations = session "Recommend"
  context: analysis  # Only needs analysis, not research
let report = session "Report"
  context: recommendations
```

#### parallel-then-synthesize

Spawning parallel agents for related analytical work, then synthesizing, when a single focused agent could do the entire job more efficiently.

```prose
# Antipattern: Parallel investigation + synthesis
parallel:
  code = session "Analyze code path"
  logs = session "Analyze logs"
  context = session "Analyze execution context"

synthesis = session "Synthesize all findings"
  context: { code, logs, context }
# 4 LLM calls, coordination overhead, fragmented context
```

**Why it's bad**: For related analysis that feeds into one conclusion, the coordination overhead and context fragmentation often outweigh parallelism benefits. Each parallel agent sees only part of the picture.

**Fix**: Use a single focused agent with multi-step instructions:

```prose
# Good: Single comprehensive investigator
diagnosis = session "Investigate the error"
  prompt: """Analyze comprehensively:
  1. Check the code path that produced the error
  2. Examine logs for timing and state
  3. Review execution context
  Synthesize into a unified diagnosis."""
# 1 LLM call, full context, no coordination
```

**When parallel IS right**: When analyses are truly independent (security vs performance), when you want diverse perspectives that shouldn't influence each other, or when the work is so large it genuinely benefits from division.

#### copy-paste-workflows

Duplicating session sequences instead of using blocks. Leads to inconsistent changes and maintenance burden.

```prose
# Bad: Duplicated workflow
session "Security review of module A"
session "Performance review of module A"
session "Synthesize reviews of module A"

session "Security review of module B"
session "Performance review of module B"
session "Synthesize reviews of module B"

session "Security review of module C"
session "Performance review of module C"
session "Synthesize reviews of module C"
```

**Why it's bad**: If the workflow needs to change, you must change it everywhere. Easy to miss one.

**Fix**: Extract into a block:

```prose
# Good: Reusable block
block review-module(module):
  parallel:
    sec = session "Security review of {module}"
    perf = session "Performance review of {module}"
  session "Synthesize reviews of {module}"
    context: { sec, perf }

do review-module("module A")
do review-module("module B")
do review-module("module C")
```

---

## Robustness Antipatterns

#### unbounded-loop

A loop without max iterations. Can run forever if the condition is never satisfied.

```prose
# Bad: No escape hatch
loop until **the code is perfect**:
  session "Improve the code"
```

**Why it's bad**: "Perfect" may never be achieved. The program could run indefinitely, consuming resources.

**Fix**: Always specify `max:`:

```prose
# Good: Bounded iteration
loop until **the code is perfect** (max: 10):
  session "Improve the code"
```

#### optimistic-execution

Assuming everything will succeed. No error handling for operations that can fail.

```prose
# Bad: No error handling
session "Call external API"
session "Process API response"
session "Store results in database"
session "Send notification"
```

**Why it's bad**: If the API fails, subsequent sessions receive no valid input. Silent corruption.

**Fix**: Handle failures explicitly:

```prose
# Good: Error handling
try:
  let response = session "Call external API"
    retry: 3
    backoff: "exponential"
  session "Process API response"
    context: response
catch as err:
  session "Handle API failure gracefully"
    context: err
```

#### ignored-errors

Using `on-fail: "ignore"` when failures actually matter. Masks problems that should surface.

```prose
# Bad: Ignoring failures that matter
parallel (on-fail: "ignore"):
  session "Charge customer credit card"
  session "Ship the product"
  session "Send confirmation email"

session "Order complete!"  # But was it really?
```

**Why it's bad**: The order might be marked complete even if payment failed.

**Fix**: Use appropriate failure policy:

```prose
# Good: Fail-fast for critical operations
parallel:  # Default: fail-fast
  payment = session "Charge customer credit card"
  inventory = session "Reserve inventory"

# Only ship if both succeeded
session "Ship the product"
  context: { payment, inventory }

# Email can fail without blocking
try:
  session "Send confirmation email"
catch:
  session "Queue email for retry"
```

#### vague-discretion

Discretion conditions that are ambiguous or unmeasurable.

```prose
# Bad: What does "good enough" mean?
loop until **the output is good enough**:
  session "Improve output"

# Bad: Highly subjective
if **the user will be happy**:
  session "Ship it"
```

**Why it's bad**: The VM has no clear criteria for evaluation. Results are unpredictable.

**Fix**: Provide concrete, evaluatable criteria:

```prose
# Good: Specific criteria
loop until **all tests pass and code coverage exceeds 80%** (max: 10):
  session "Improve test coverage"

# Good: Observable conditions
if **the response contains valid JSON with all required fields**:
  session "Process the response"
```

#### catch-and-swallow

Catching errors without meaningful handling. Hides problems without solving them.

```prose
# Bad: Silent swallow
try:
  session "Critical operation"
catch:
  # Nothing here - error disappears
```

**Why it's bad**: Errors vanish. No recovery, no logging, no visibility.

**Fix**: Handle errors meaningfully:

```prose
# Good: Meaningful handling
try:
  session "Critical operation"
catch as err:
  session "Log error for investigation"
    context: err
  session "Execute fallback procedure"
  # Or rethrow if unrecoverable:
  throw
```

---

## Cost Antipatterns

#### opus-for-everything

Using the most powerful (expensive) model for all tasks, including trivial ones.

```prose
# Bad: Opus for simple classification
agent classifier:
  model: opus
  prompt: "Categorize items as: spam, not-spam"

# Expensive for a binary classification
for email in emails:
  session: classifier
    prompt: "Classify: {email}"
```

**Why it's bad**: Opus costs significantly more than haiku. Simple tasks don't benefit from advanced reasoning.

**Fix**: Match model to task complexity:

```prose
# Good: Haiku for simple tasks
agent classifier:
  model: haiku
  prompt: "Categorize items as: spam, not-spam"
```

#### context-bloat

Passing excessive context that the session doesn't need.

```prose
# Bad: Passing everything
let full_codebase = session "Read entire codebase"
let all_docs = session "Read all documentation"
let history = session "Get full git history"

session "Fix the typo in the README"
  context: [full_codebase, all_docs, history]  # Massive overkill
```

**Why it's bad**: Large contexts slow processing, increase costs, and can confuse the model with irrelevant information.

**Fix**: Pass minimal relevant context:

```prose
# Good: Minimal context
let readme = session "Read the README file"

session "Fix the typo in the README"
  context: readme
```

#### unnecessary-iteration

Looping when a single session would suffice.

```prose
# Bad: Loop for what could be one call
let items = ["apple", "banana", "cherry"]
for item in items:
  session "Describe {item}"
```

**Why it's bad**: Three sessions when one could handle all items. Session overhead multiplied.

**Fix**: Batch when possible:

```prose
# Good: Batch processing
let items = ["apple", "banana", "cherry"]
session "Describe each of these items: {items}"
```

#### redundant-computation

Computing the same thing multiple times.

```prose
# Bad: Redundant research
session "Research AI safety for security review"
session "Research AI safety for ethics review"
session "Research AI safety for compliance review"
```

**Why it's bad**: Same research done three times with slightly different framing.

**Fix**: Compute once, use many times:

```prose
# Good: Compute once
let research = session "Comprehensive research on AI safety"

parallel:
  session "Security review"
    context: research
  session "Ethics review"
    context: research
  session "Compliance review"
    context: research
```

---

## Performance Antipatterns

#### eager-over-computation

Computing everything upfront when only some results might be needed.

```prose
# Bad: Compute all branches even if only one is needed
parallel:
  simple_analysis = session "Simple analysis"
    model: haiku
  detailed_analysis = session "Detailed analysis"
    model: sonnet
  deep_analysis = session "Deep analysis"
    model: opus

# Then only use one based on some criterion
choice **appropriate depth**:
  option "Simple":
    session "Use simple"
      context: simple_analysis
  option "Detailed":
    session "Use detailed"
      context: detailed_analysis
  option "Deep":
    session "Use deep"
      context: deep_analysis
```

**Why it's bad**: All three analyses run even though only one is used.

**Fix**: Compute lazily:

```prose
# Good: Only compute what's needed
let initial = session "Initial assessment"
  model: haiku

choice **appropriate depth based on initial assessment**:
  option "Simple":
    session "Simple analysis"
      model: haiku
  option "Detailed":
    session "Detailed analysis"
      model: sonnet
  option "Deep":
    session "Deep analysis"
      model: opus
```

#### over-parallelization

Parallelizing so aggressively that overhead dominates or resources are exhausted.

```prose
# Bad: 100 parallel sessions
parallel for item in large_collection:  # 100 items
  session "Process {item}"
```

**Why it's bad**: May overwhelm the system. Coordination overhead can exceed parallelism benefits.

**Fix**: Batch or limit concurrency:

```prose
# Good: Process in batches
for batch in batches(large_collection, 10):
  parallel for item in batch:
    session "Process {item}"
```

#### premature-parallelization

Parallelizing tiny tasks where sequential would be simpler and fast enough.

```prose
# Bad: Parallel overkill for simple tasks
parallel:
  a = session "Add 2 + 2"
  b = session "Add 3 + 3"
  c = session "Add 4 + 4"
```

**Why it's bad**: Coordination overhead exceeds task time. Sequential would be simpler and possibly faster.

**Fix**: Keep it simple:

```prose
# Good: Sequential for trivial tasks
session "Add 2+2, 3+3, and 4+4"
```

#### synchronous-fire-and-forget

Waiting for operations whose results you don't need.

```prose
# Bad: Waiting for logging
session "Do important work"
session "Log the result"  # Don't need to wait for this
session "Continue with next important work"
```

**Why it's bad**: Main workflow blocked by non-critical operation.

**Fix**: Use appropriate patterns for fire-and-forget operations, or batch logging:

```prose
# Better: Batch non-critical work
session "Do important work"
session "Continue with next important work"
# ... more important work ...

# Log everything at the end or async
session "Log all operations"
```

---

## Maintainability Antipatterns

#### magic-strings

Hardcoded prompts repeated throughout the program.

```prose
# Bad: Same prompt in multiple places
session "You are a helpful assistant. Analyze this code for bugs."
# ... later ...
session "You are a helpful assistant. Analyze this code for bugs."
# ... even later ...
session "You are a helpful assistent. Analyze this code for bugs."  # Typo!
```

**Why it's bad**: Inconsistency when updating. Typos go unnoticed.

**Fix**: Use agents:

```prose
# Good: Single source of truth
agent code-analyst:
  model: sonnet
  prompt: "You are a helpful assistant. Analyze code for bugs."

session: code-analyst
  prompt: "Analyze the auth module"
session: code-analyst
  prompt: "Analyze the payment module"
```

#### opaque-workflow

No structure or comments indicating what's happening.

```prose
# Bad: What is this doing?
let x = session "A"
let y = session "B"
  context: x
parallel:
  z = session "C"
    context: y
  w = session "D"
session "E"
  context: [z, w]
```

**Why it's bad**: Impossible to understand, debug, or modify.

**Fix**: Use meaningful names and structure:

```prose
# Good: Clear intent
# Phase 1: Research
let research = session "Gather background information"

# Phase 2: Analysis
let analysis = session "Analyze research findings"
  context: research

# Phase 3: Parallel evaluation
parallel:
  technical_eval = session "Technical feasibility assessment"
    context: analysis
  business_eval = session "Business viability assessment"
    context: analysis

# Phase 4: Synthesis
session "Create final recommendation"
  context: { technical_eval, business_eval }
```

#### implicit-dependencies

Relying on conversation history rather than explicit context.

```prose
# Bad: Implicit state
session "Set the project name to Acme"
session "Set the deadline to Friday"
session "Now create a project plan"  # Hopes previous info is remembered
```

**Why it's bad**: Relies on VM implementation details. Fragile across refactoring.

**Fix**: Explicit context:

```prose
# Good: Explicit state
let config = session "Define project: name=Acme, deadline=Friday"

session "Create a project plan"
  context: config
```

#### mixed-concerns-agent

Agents with prompts that cover too many responsibilities.

```prose
# Bad: Jack of all trades
agent super-agent:
  model: opus
  prompt: """
    You are an expert in:
    - Security analysis
    - Performance optimization
    - Code review
    - Documentation
    - Testing
    - DevOps
    - Project management
    - Customer communication
    When asked, perform any of these tasks.
  """
```

**Why it's bad**: No focus means mediocre results across the board. Can't optimize model choice.

**Fix**: Specialized agents:

```prose
# Good: Focused expertise
agent security-expert:
  model: sonnet
  prompt: "You are a security analyst. Focus only on security concerns."

agent performance-expert:
  model: sonnet
  prompt: "You are a performance engineer. Focus only on optimization."

agent technical-writer:
  model: haiku
  prompt: "You write clear technical documentation."
```

---

## Logic Antipatterns

#### infinite-refinement

Loops that can never satisfy their exit condition.

```prose
# Bad: Perfection is impossible
loop until **the code has zero bugs**:
  session "Find and fix bugs"
```

**Why it's bad**: Zero bugs is unachievable. Loop runs until max (if specified) or forever.

**Fix**: Use achievable conditions:

```prose
# Good: Achievable condition
loop until **all known bugs are fixed** (max: 20):
  session "Find and fix the next bug"

# Or: Diminishing returns
loop until **no significant bugs found in last iteration** (max: 10):
  session "Search for bugs"
```

#### assertion-as-action

Using conditions as actions—checking something without acting on the result.

```prose
# Bad: Check but don't use result
session "Check if the system is healthy"
session "Deploy to production"  # Deploys regardless!
```

**Why it's bad**: The health check result isn't used. Deploy happens unconditionally.

**Fix**: Use conditional execution:

```prose
# Good: Act on the check
let health = session "Check if the system is healthy"

if **system is healthy**:
  session "Deploy to production"
else:
  session "Alert on-call and skip deployment"
    context: health
```

#### false-parallelism

Putting sequential-dependent operations in a parallel block.

```prose
# Bad: These aren't independent!
parallel:
  data = session "Fetch data"
  processed = session "Process the data"  # Needs data!
    context: data
  stored = session "Store processed data"  # Needs processed!
    context: processed
```

**Why it's bad**: Despite being in parallel, these must run sequentially due to dependencies.

**Fix**: Be honest about dependencies:

```prose
# Good: Sequential where needed
let data = session "Fetch data"
let processed = session "Process the data"
  context: data
session "Store processed data"
  context: processed
```

#### exception-as-flow-control

Using try/catch for expected conditions rather than exceptional errors.

```prose
# Bad: Exceptions for normal flow
try:
  session "Find the optional config file"
catch:
  session "Use default configuration"
```

**Why it's bad**: Missing config is expected, not exceptional. Obscures actual errors.

**Fix**: Use conditionals for expected cases:

```prose
# Good: Conditional for expected case
let config_exists = session "Check if config file exists"

if **config file exists**:
  session "Load configuration from file"
else:
  session "Use default configuration"
```

#### excessive-user-checkpoints

Prompting the user for decisions that have obvious or predictable answers.

```prose
# Antipattern: Asking the obvious
input "Blocking error detected. Investigate?"  # Always yes
input "Diagnosis complete. Proceed to triage?"  # Always yes
input "Tests pass. Deploy?"  # Almost always yes
```

**Why it's bad**: Each checkpoint is a round-trip waiting for user input. If the answer is predictable 90% of the time, you're adding latency for no value.

**Fix**: Auto-proceed for obvious cases, only prompt when genuinely ambiguous:

```prose
# Good: Auto-proceed with escape hatches for edge cases
if observation.blocking_error:
  # Auto-investigate (don't ask - of course we investigate errors)
  let diagnosis = do investigate(...)

  # Only ask if genuinely ambiguous
  if diagnosis.confidence == "low":
    input "Low confidence diagnosis. Proceed anyway?"

  # Auto-deploy if tests pass (but log for audit)
  if fix.tests_pass:
    do deploy(...)
```

**When checkpoints ARE right**: Irreversible actions (production deployments to critical systems), expensive operations (long-running jobs), or genuine decision points where the user's preference isn't predictable.

#### fixed-observation-window

Waiting for a predetermined duration when the signal arrived early.

```prose
# Antipattern: Fixed window regardless of findings
loop 30 times (wait: 2s each):  # Always 60 seconds
  resume: observer
    prompt: "Keep watching the stream"
# Runs all 30 iterations even if blocking error detected on iteration 1
```

**Why it's bad**: Wastes time when the answer is already known. If the observer detected a fatal error at +5 seconds, why wait another 55 seconds?

**Fix**: Use signal-driven exit conditions:

```prose
# Good: Exit on significant signal
loop until **blocking error OR completion** (max: 30):
  resume: observer
    prompt: "Watch the stream. Signal IMMEDIATELY on blocking errors."
# Exits as soon as something significant happens
```

Or use `early_exit` if your runtime supports it:

```prose
# Good: Explicit early exit
let observation = session: observer
  prompt: "Monitor for errors. Signal immediately if found."
  timeout: 120s
  early_exit: **blocking_error detected**
```

---

## Security Antipatterns

#### unvalidated-input

Passing external input directly to sessions without validation.

```prose
# Bad: Direct injection
let user_input = external_source

session "Execute this command: {user_input}"
```

**Why it's bad**: User could inject malicious prompts or commands.

**Fix**: Validate and sanitize:

```prose
# Good: Validate first
let user_input = external_source
let validated = session "Validate this input is a safe search query"
  context: user_input

if **input is valid and safe**:
  session "Search for: {validated}"
else:
  throw "Invalid input rejected"
```

#### overprivileged-agents

Agents with more permissions than they need.

```prose
# Bad: Full access for simple task
agent file-reader:
  permissions:
    read: ["**/*"]
    write: ["**/*"]
    bash: allow
    network: allow

session: file-reader
  prompt: "Read the README.md file"
```

**Why it's bad**: Task only needs to read one file but has full system access.

**Fix**: Least privilege:

```prose
# Good: Minimal permissions
agent file-reader:
  permissions:
    read: ["README.md"]
    write: []
    bash: deny
    network: deny
```

---

## Summary

Antipatterns emerge from:

1. **Laziness**: Copy-paste instead of abstraction, implicit instead of explicit
2. **Over-engineering**: Parallelizing everything, using opus for all tasks
3. **Under-engineering**: No error handling, unbounded loops, vague conditions
4. **Unclear thinking**: God sessions, mixed concerns, spaghetti context

When reviewing OpenProse programs, ask:

- Can independent work be parallelized?
- Are loops bounded?
- Are errors handled?
- Is context minimal and explicit?
- Are models matched to task complexity?
- Are agents focused and reusable?
- Would a stranger understand this code?

Fix antipatterns early. They compound over time into unmaintainable systems.
