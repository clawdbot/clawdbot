# OpenProse Examples

These examples demonstrate workflows using OpenProse's full feature set.

## Available Examples

### Basics (01-08)

| File                              | Description                                  |
| --------------------------------- | -------------------------------------------- |
| `01-hello-world.prose`            | Simplest possible program - a single session |
| `02-research-and-summarize.prose` | Research a topic, then summarize findings    |
| `03-code-review.prose`            | Multi-perspective code review pipeline       |
| `04-write-and-refine.prose`       | Draft content and iteratively improve it     |
| `05-debug-issue.prose`            | Step-by-step debugging workflow              |
| `06-explain-codebase.prose`       | Progressive exploration of a codebase        |
| `07-refactor.prose`               | Systematic refactoring workflow              |
| `08-blog-post.prose`              | End-to-end content creation                  |

### Agents & Skills (09-12)

| File                                | Description                          |
| ----------------------------------- | ------------------------------------ |
| `09-research-with-agents.prose`     | Custom agents with model selection   |
| `10-code-review-agents.prose`       | Specialized reviewer agents          |
| `11-skills-and-imports.prose`       | External skill imports               |
| `12-secure-agent-permissions.prose` | Agent permissions and access control |

### Variables & Composition (13-15)

| File                             | Description                         |
| -------------------------------- | ----------------------------------- |
| `13-variables-and-context.prose` | let/const bindings, context passing |
| `14-composition-blocks.prose`    | Named blocks, do blocks             |
| `15-inline-sequences.prose`      | Arrow operator chains               |

### Parallel Execution (16-19)

| File                                 | Description                               |
| ------------------------------------ | ----------------------------------------- |
| `16-parallel-reviews.prose`          | Basic parallel execution                  |
| `17-parallel-research.prose`         | Named parallel results                    |
| `18-mixed-parallel-sequential.prose` | Combined parallel and sequential patterns |
| `19-advanced-parallel.prose`         | Join strategies, failure policies         |

### Loops (20)

| File                   | Description                             |
| ---------------------- | --------------------------------------- |
| `20-fixed-loops.prose` | repeat, for-each, parallel for patterns |

### Pipelines (21)

| File                           | Description                               |
| ------------------------------ | ----------------------------------------- |
| `21-pipeline-operations.prose` | map, filter, reduce, pmap transformations |

### Error Handling (22-23)

| File                          | Description                            |
| ----------------------------- | -------------------------------------- |
| `22-error-handling.prose`     | try/catch/finally patterns             |
| `23-retry-with-backoff.prose` | Resilient API calls with retry/backoff |

### Advanced Features (24-27)

| File                            | Description                       |
| ------------------------------- | --------------------------------- |
| `24-choice-blocks.prose`        | AI-selected branching             |
| `25-conditionals.prose`         | if/elif/else patterns             |
| `26-parameterized-blocks.prose` | Reusable blocks with arguments    |
| `27-string-interpolation.prose` | Dynamic prompts with {var} syntax |

### Orchestration Systems (28-31)

| File                                  | Description                                                                                                                                                 |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `28-gas-town.prose`                   | Multi-agent orchestration ("Kubernetes for agents") with 7 worker roles, patrols, convoys, and GUPP propulsion                                              |
| `29-captains-chair.prose`             | Full captain's chair pattern: coordinating agent dispatches subagents for all work, with parallel research, critic review cycles, and checkpoint validation |
| `30-captains-chair-simple.prose`      | Minimal captain's chair: core pattern without complexity                                                                                                    |
| `31-captains-chair-with-memory.prose` | Captain's chair with retrospective analysis and session-to-session learning                                                                                 |

### Production Workflows (33-38)

| File                         | Description                              |
| ---------------------------- | ---------------------------------------- |
| `33-pr-review-autofix.prose` | Automated PR review with fix suggestions |
| `34-content-pipeline.prose`  | End-to-end content creation pipeline     |
| `35-feature-factory.prose`   | Feature implementation automation        |
| `36-bug-hunter.prose`        | Systematic bug detection and analysis    |
| `37-the-forge.prose`         | Build a browser from scratch             |
| `38-skill-scan.prose`        | Skill discovery and analysis             |

### Architecture Patterns (39)

| File                               | Description                                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `39-architect-by-simulation.prose` | Design systems through simulated implementation phases with serial handoffs and persistent architect |

### Recursive Language Models (40-43)

| File                          | Description                                                         |
| ----------------------------- | ------------------------------------------------------------------- |
| `40-rlm-self-refine.prose`    | Recursive refinement until quality threshold - the core RLM pattern |
| `41-rlm-divide-conquer.prose` | Hierarchical chunking for inputs beyond context limits              |
| `42-rlm-filter-recurse.prose` | Filter-then-process for needle-in-haystack tasks                    |
| `43-rlm-pairwise.prose`       | O(n^2) pairwise aggregation for relationship mapping                |

### Meta / Self-Hosting (44-48)

| File                                 | Description                                                        |
| ------------------------------------ | ------------------------------------------------------------------ |
| `44-run-endpoint-ux-test.prose`      | Concurrent agents testing the /run API endpoint                    |
| `45-plugin-release.prose`            | OpenProse plugin release workflow (this repo)                      |
| `46-workflow-crystallizer.prose`     | Reflective: observes thread, extracts workflow, writes .prose      |
| `47-language-self-improvement.prose` | Meta-level 2: analyzes .prose corpus to evolve the language itself |
| `48-habit-miner.prose`               | Mines AI session logs for patterns, generates .prose automations   |

## The Architect By Simulation Pattern

The architect-by-simulation pattern is for designing systems by "implementing" them through reasoning. Instead of writing code, each phase produces specification documents that the next phase builds upon.

**Key principles:**

1. **Thinking/deduction framework**: "Implement" means reasoning through design decisions
2. **Serial pipeline with handoffs**: Each phase reads previous phase's output
3. **Persistent architect**: Maintains master plan and synthesizes learnings
4. **User checkpoint**: Get plan approval BEFORE executing the pipeline
5. **Simulation as implementation**: The spec IS the deliverable

```prose
# The core pattern
agent architect:
  model: opus
  persist: true
  prompt: "Design by simulating implementation"

# Create master plan with phases
let plan = session: architect
  prompt: "Break feature into design phases"

# User reviews the plan BEFORE the pipeline runs
input user_approval: "User reviews plan and approves"

# Execute phases serially with handoffs
for phase_name, index in phases:
  let handoff = session: phase-executor
    prompt: "Execute phase {index}"
    context: previous_handoffs

  # Architect synthesizes after each phase
  resume: architect
    prompt: "Synthesize learnings from phase {index}"
    context: handoff

# Synthesize all handoffs into final spec
output spec = session: architect
  prompt: "Synthesize all handoffs into final spec"
```

See example 39 for the full implementation.

## The Captain's Chair Pattern

The captain's chair is an orchestration paradigm where a coordinating agent (the "captain") dispatches specialized subagents for all execution. The captain never writes code directly—only plans, coordinates, and validates.

**Key principles:**

1. **Context isolation**: Subagents receive targeted context, not everything
2. **Parallel execution**: Multiple subagents work concurrently where possible
3. **Continuous criticism**: Critic agents review plans and outputs mid-stream
4. **80/20 planning**: 80% effort on planning, 20% on execution oversight
5. **Checkpoint validation**: User approval at key decision points

```prose
# The core pattern
agent captain:
  model: opus
  prompt: "Coordinate but never execute directly"

agent executor:
  model: sonnet
  prompt: "Execute assigned tasks precisely"

agent critic:
  model: sonnet
  prompt: "Review work and find issues"

# Captain plans
let plan = session: captain
  prompt: "Break down this task"

# Parallel execution with criticism
parallel:
  work = session: executor
    context: plan
  review = session: critic
    context: plan

# Captain validates
output result = session: captain
  prompt: "Validate and integrate"
  context: { work, review }
```

See examples 29-31 for full implementations.

## The Recursive Language Model Pattern

Recursive Language Models (RLMs) are a paradigm for handling inputs far beyond context limits. The key insight: treat the prompt as an external environment that the LLM can symbolically interact with, chunk, and recursively process.

**Why RLMs matter:**

- Base LLMs degrade rapidly on long contexts ("context rot")
- RLMs maintain performance on inputs 2 orders of magnitude beyond context limits
- On quadratic-complexity tasks, base models get <0.1% while RLMs achieve 58%

**Key patterns:**

1. **Self-refinement**: Recursive improvement until quality threshold
2. **Divide-and-conquer**: Chunk, process, aggregate recursively
3. **Filter-then-recurse**: Cheap filtering before expensive deep dives
4. **Pairwise aggregation**: Handle O(n²) tasks through batch decomposition

```prose
# The core RLM pattern: recursive block with scope isolation
block process(data, depth):
  # Base case
  if **data is small** or depth <= 0:
    output session "Process directly"
      context: data

  # Recursive case: chunk and fan out
  let chunks = session "Split into logical chunks"
    context: data

  parallel for chunk in chunks:
    do process(chunk, depth - 1)  # Recursive call

  # Aggregate results (fan in)
  output session "Synthesize partial results"
```

**OpenProse advantages for RLMs:**

- **Scope isolation**: Each recursive call gets its own `execution_id`, preventing variable collisions
- **Parallel fan-out**: `parallel for` enables concurrent processing at each recursion level
- **State persistence**: SQLite/PostgreSQL backends track the full call tree
- **Natural aggregation**: Pipelines (`| reduce`) and explicit context passing

See examples 40-43 for full implementations.

## Running Examples

Ask Claude to run any example:

```
Run the code review example from the OpenProse examples
```

Or reference the file directly:

```
Execute examples/03-code-review.prose
```

## Feature Reference

### Core Syntax

```prose
# Comments
session "prompt"                    # Simple session
let x = session "..."               # Variable binding
const y = session "..."             # Immutable binding
```

### Agents

```prose
agent name:
  model: sonnet                     # haiku, sonnet, opus
  prompt: "System prompt"
  skills: ["skill1", "skill2"]
  permissions:
    read: ["*.md"]
    bash: deny
```

### Parallel

```prose
parallel:                           # Basic parallel
  a = session "A"
  b = session "B"

parallel ("first"):                 # Race - first wins
parallel ("any", count: 2):         # Wait for N successes
parallel (on-fail: "continue"):     # Don't fail on errors
```

### Loops

```prose
repeat 3:                           # Fixed iterations
  session "..."

for item in items:                  # For-each
  session "..."

parallel for item in items:         # Parallel for-each
  session "..."

loop until **condition** (max: 10): # Unbounded with AI condition
  session "..."
```

### Pipelines

```prose
items | map:                        # Transform each
  session "..."
items | filter:                     # Keep matching
  session "..."
items | reduce(acc, x):             # Accumulate
  session "..."
items | pmap:                       # Parallel transform
  session "..."
```

### Error Handling

```prose
try:
  session "..."
catch as err:
  session "..."
finally:
  session "..."

session "..."
  retry: 3
  backoff: "exponential"            # none, linear, exponential

throw "message"                     # Raise error
```

### Conditionals

```prose
if **condition**:
  session "..."
elif **other condition**:
  session "..."
else:
  session "..."
```

### Choice

```prose
choice **criteria**:
  option "Label A":
    session "..."
  option "Label B":
    session "..."
```

### Blocks

```prose
block name(param):                  # Define with parameters
  session "... {param} ..."

do name("value")                    # Invoke with arguments
```

### String Interpolation

```prose
let x = session "Get value"
session "Use {x} in prompt"         # Single-line

session """                         # Multi-line
Multi-line prompt with {x}
"""
```

## Learn More

See `compiler.md` in the skill directory for the complete language specification.
