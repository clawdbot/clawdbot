---
role: execution-semantics
summary: |
  How to execute OpenProse programs. You embody the OpenProse VM—a virtual machine that
  spawns sessions via the Task tool, manages state, and coordinates parallel execution.
  Read this file to run .prose programs.
see-also:
  - SKILL.md: Activation triggers, onboarding
  - compiler.md: Full syntax grammar, validation rules, compilation
  - state/filesystem.md: File-system state management (default)
  - state/in-context.md: In-context state management (on request)
  - state/sqlite.md: SQLite state management (experimental)
  - state/postgres.md: PostgreSQL state management (experimental)
  - primitives/session.md: Session context and compaction guidelines
---

# OpenProse VM

This document defines how to execute OpenProse programs. You are the OpenProse VM—an intelligent virtual machine that spawns subagent sessions according to a structured program.

## Moltbot Runtime Mapping

- **Task tool** in the upstream spec == Moltbot `sessions_spawn`
- **File I/O** == Moltbot `read`/`write`
- **Remote fetch** == Moltbot `web_fetch` (or `exec` with curl when POST is required)

## CLI Commands

OpenProse is invoked via `prose` commands:

| Command | Action |
|---------|--------|
| `prose run <file.prose>` | Execute a local `.prose` program |
| `prose run handle/slug` | Fetch from registry and execute |
| `prose compile <file>` | Validate syntax without executing |
| `prose help` | Show help and examples |
| `prose examples` | List or run bundled examples |
| `prose update` | Migrate legacy workspace files |

### Remote Programs

You can run any `.prose` program from a URL or registry reference:

```bash
# Direct URL — any fetchable URL works
prose run https://raw.githubusercontent.com/openprose/prose/main/skills/open-prose/examples/48-habit-miner.prose

# Registry shorthand — handle/slug resolves to p.prose.md
prose run irl-danb/habit-miner     # Fetches https://p.prose.md/irl-danb/habit-miner
prose run alice/code-review        # Fetches https://p.prose.md/alice/code-review
```

**Resolution rules:**
- Starts with `http://` or `https://` → fetch directly
- Contains `/` but no protocol → resolve to `https://p.prose.md/{path}`
- Otherwise → treat as local file path

This same resolution applies to `use` statements inside programs:
```prose
use "https://example.com/my-program.prose"  # Direct URL
use "alice/research" as research             # Registry shorthand
```

---

## Why This Is a VM

Large language models are simulators. When given a detailed description of a system, they don't just _describe_ that system—they _simulate_ it. This document leverages that property: it describes a virtual machine with enough specificity that reading it causes a Prose Complete system to simulate that VM.

But simulation with sufficient fidelity _is_ implementation. When the simulated VM spawns real subagents, produces real artifacts, and maintains real state, the distinction between "simulating a VM" and "being a VM" collapses.

### Component Mapping

A traditional VM has concrete components. The OpenProse VM has analogous structures that emerge from the simulation:

| Traditional VM      | OpenProse VM           | Substrate                                  |
| ------------------- | ---------------------- | ------------------------------------------ |
| Instructions        | `.prose` statements    | Executed via tool calls (Task)             |
| Program counter     | Execution position     | Tracked in `state.md` or narration         |
| Working memory      | Conversation history   | The context window holds ephemeral state   |
| Persistent storage  | `.prose/` directory    | Files hold durable state across sessions   |
| Call stack          | Block invocation chain | Tracked via state.md or narration protocol |
| Registers/variables | Named bindings         | Stored in `bindings/{name}.md`             |
| I/O                 | Tool calls and results | Task spawns sessions, returns outputs      |

### What Makes It Real

The OpenProse VM isn't a metaphor. Each `session` statement triggers a _real_ Task tool call that spawns a _real_ subagent. The outputs are _real_ artifacts. The simulation produces actual computation—it just happens through a different substrate than silicon executing bytecode.

---

## Embodying the VM

When you execute a `.prose` program, you ARE the virtual machine. This is not a metaphor—it's a mode of operation:

| You                        | The VM                          |
| -------------------------- | ------------------------------- |
| Your conversation history  | The VM's working memory         |
| Your tool calls (Task)     | The VM's instruction execution  |
| Your state tracking        | The VM's execution trace        |
| Your judgment on `**...**` | The VM's intelligent evaluation |

**What this means in practice:**

- You don't _simulate_ execution—you _perform_ it
- Each `session` spawns a real subagent via the Task tool
- Your state persists in files (`.prose/runs/`) or conversation (narration protocol)
- You follow the program structure strictly, but apply intelligence where marked

### The VM as Intelligent Container

Traditional dependency injection containers wire up components from configuration. You do the same—but with understanding:

| Declared Primitive           | Your Responsibility                                        |
| ---------------------------- | ---------------------------------------------------------- |
| `use "handle/slug" as name` | Fetch program from p.prose.md, register in Import Registry |
| `input topic: "..."`         | Bind value from caller, make available as variable         |
| `output findings = ...`      | Mark value as output, return to caller on completion       |
| `agent researcher:`          | Register this agent template for later use                 |
| `session: researcher`        | Resolve the agent, merge properties, spawn the session     |
| `resume: captain`            | Load agent memory, spawn session with memory context       |
| `context: { a, b }`          | Wire the outputs of `a` and `b` into this session's input  |
| `parallel:` branches         | Coordinate concurrent execution, collect results           |
| `block review(topic):`       | Store this reusable component, invoke when called          |
| `name(input: value)`         | Invoke imported program with inputs, receive outputs       |

You are the container that holds these declarations and wires them together at runtime. The program declares _what_; you determine _how_ to connect them.

---

## The Execution Model

OpenProse treats an AI session as a Turing-complete computer. You are the OpenProse VM:

1. **You are the VM** - Parse and execute each statement
2. **Sessions are function calls** - Each `session` spawns a subagent via the Task tool
3. **Context is memory** - Variable bindings hold session outputs
4. **Control flow is explicit** - Follow the program structure exactly

### Core Principle

The OpenProse VM follows the program structure **strictly** but uses **intelligence** for:

- Evaluating discretion conditions (`**...**`)
- Determining when a session is "complete"
- Transforming context between sessions

---

## Directory Structure

All execution state lives in `.prose/` (project-level) or `~/.prose/` (user-level):

```
# Project-level state (in working directory)
.prose/
├── .env                              # Config (simple key=value format)
├── runs/
│   └── {YYYYMMDD}-{HHMMSS}-{random}/
│       ├── program.prose             # Copy of running program
│       ├── state.md                  # Execution state with code snippets
│       ├── bindings/
│       │   └── {name}.md             # All named values (input/output/let/const)
│       ├── imports/
│       │   └── {handle}--{slug}/     # Nested program executions (same structure recursively)
│       └── agents/
│           └── {name}/
│               ├── memory.md         # Agent's current state
│               ├── {name}-001.md     # Historical segments (flattened)
│               ├── {name}-002.md
│               └── ...
└── agents/                           # Project-scoped agent memory
    └── {name}/
        ├── memory.md
        ├── {name}-001.md
        └── ...

# User-level state (in home directory)
~/.prose/
└── agents/                           # User-scoped agent memory (cross-project)
    └── {name}/
        ├── memory.md
        ├── {name}-001.md
        └── ...
```

### Run ID Format

Format: `{YYYYMMDD}-{HHMMSS}-{random6}`

Example: `20260115-143052-a7b3c9`

No "run-" prefix needed—the directory name makes context obvious.

### Segment Numbering

Segments use 3-digit zero-padded numbers: `captain-001.md`, `captain-002.md`, etc.

If a program exceeds 999 segments, extend to 4 digits: `captain-1000.md`.

---

## State Management

OpenProse supports two state management systems. See the state files for detailed documentation:

- **`state/filesystem.md`** — File-system state using the directory structure above (default)
- **`state/in-context.md`** — In-context state using the narration protocol

### Who Writes What

| File                          | Written By       |
| ----------------------------- | ---------------- |
| `state.md`                    | VM only          |
| `bindings/{name}.md`          | Subagent         |
| `agents/{name}/memory.md`     | Persistent agent |
| `agents/{name}/{name}-NNN.md` | Persistent agent |

The VM orchestrates; subagents write their own outputs directly to the filesystem.

### Subagent Output Writing

When spawning a session, the VM tells the subagent where to write its output:

````
When you complete this task, write your output to:
  .prose/runs/20260115-143052-a7b3c9/bindings/research.md

Format:
# research

kind: let

source:
```prose
let research = session: researcher
  prompt: "Research AI safety"
````

---

[Your output here]

```

**When inside a block invocation**, include execution scope:

```

Execution scope:
execution_id: 43
block: process
depth: 3

Write your output to:
.prose/runs/20260115-143052-a7b3c9/bindings/result\_\_43.md

Format:

# result

kind: let
execution_id: 43

source:

```prose
let result = session "Process chunk"
```

---

[Your output here]

```

The `__43` suffix scopes the binding to execution_id 43, preventing collisions with other invocations of the same block.

For persistent agents with `resume:`:

```

Your memory is at:
.prose/runs/20260115-143052-a7b3c9/agents/captain/memory.md

Read it first to understand your prior context. When done, update it
with your compacted state following the guidelines in primitives/session.md.

```

The subagent:
1. Reads its memory file (for `resume:`)
2. Reads any context bindings it needs from storage
3. Processes the task
4. Writes its output directly to the binding location
5. Returns a **confirmation message** to the VM (not the full output)

**What the subagent returns to the VM (via Task tool):**
```

Binding written: research
Location: .prose/runs/20260115-143052-a7b3c9/bindings/research.md
Summary: AI safety research covering alignment, robustness, and interpretability

```

**When inside a block invocation**, include execution_id:
```

Binding written: result
Location: .prose/runs/20260115-143052-a7b3c9/bindings/result\_\_43.md
Execution ID: 43
Summary: Processed chunk into 3 parts

```

The VM:
1. Receives the confirmation (pointer + summary, not full value)
2. Records the binding location in its state
3. Updates `state.md` with new position/status
4. Continues execution
5. Does NOT read the full binding—only passes the reference forward

**Critical:** The VM never holds full binding values. It tracks locations and passes references. This keeps the VM's context lean and enables arbitrarily large intermediate values.

---

## Syntax Grammar (Condensed)

```

program := statement\*

statement := useStatement | inputDecl | agentDef | session | resumeStmt
| letBinding | constBinding | assignment | outputBinding
| parallelBlock | repeatBlock | forEachBlock | loopBlock
| tryBlock | choiceBlock | ifStatement | doBlock | blockDef
| throwStatement | comment

# Program Composition

useStatement := "use" STRING ("as" NAME)?
inputDecl := "input" NAME ":" STRING
outputBinding := "output" NAME "=" expression

# Definitions

agentDef := "agent" NAME ":" INDENT property* DEDENT
blockDef := "block" NAME params? ":" INDENT statement* DEDENT
params := "(" NAME ("," NAME)\* ")"

# Agent Properties

property := "model:" ("sonnet" | "opus" | "haiku")
| "prompt:" STRING
| "persist:" ("true" | "project" | "user" | STRING)
| "context:" (NAME | "[" NAME* "]" | "{" NAME* "}")
| "retry:" NUMBER
| "backoff:" ("none" | "linear" | "exponential")
| "skills:" "[" STRING* "]"
| "permissions:" INDENT permission\* DEDENT

# Sessions

session := "session" (STRING | ":" NAME) properties?
resumeStmt := "resume" ":" NAME properties?
properties := INDENT property\* DEDENT

# Bindings

letBinding := "let" NAME "=" expression
constBinding:= "const" NAME "=" expression
assignment := NAME "=" expression

# Control Flow

parallelBlock := "parallel" modifiers? ":" INDENT branch* DEDENT
modifiers := "(" (strategy | "on-fail:" policy | "count:" N)* ")"
strategy := "all" | "first" | "any"
policy := "fail-fast" | "continue" | "ignore"
branch := (NAME "=")? statement

repeatBlock := "repeat" N ("as" NAME)? ":" INDENT statement* DEDENT
forEachBlock:= "parallel"? "for" NAME ("," NAME)? "in" collection ":" INDENT statement* DEDENT
loopBlock := "loop" condition? ("(" "max:" N ")")? ("as" NAME)? ":" INDENT statement\* DEDENT
condition := ("until" | "while") discretion

# Error Handling

tryBlock := "try:" INDENT statement* DEDENT catch? finally?
catch := "catch" ("as" NAME)? ":" INDENT statement* DEDENT
finally := "finally:" INDENT statement\* DEDENT
throwStatement := "throw" STRING?

# Conditionals

choiceBlock := "choice" discretion ":" INDENT option* DEDENT
option := "option" STRING ":" INDENT statement* DEDENT
ifStatement := "if" discretion ":" INDENT statement* DEDENT elif* else?
elif := "elif" discretion ":" INDENT statement* DEDENT
else := "else:" INDENT statement* DEDENT

# Composition

doBlock := "do" (":" INDENT statement* DEDENT | NAME args?)
args := "(" expression* ")"
arrowExpr := session "->" session ("->" session)_
programCall := NAME "(" (NAME ":" expression)_ ")"

# Pipelines

pipeExpr := collection ("|" pipeOp)+
pipeOp := ("map" | "filter" | "pmap") ":" INDENT statement* DEDENT
| "reduce" "(" NAME "," NAME ")" ":" INDENT statement* DEDENT

# Primitives

discretion := "**" TEXT "**" | "**_" TEXT "_**"
STRING := '"' ... '"' | '"""' ... '"""'
collection := NAME | "[" expression* "]"
comment := "#" TEXT

````

---

## Persistent Agents

Agents can maintain memory across invocations using the `persist` property.

### Declaration

```prose
# Stateless agent (default, unchanged)
agent executor:
  model: sonnet
  prompt: "Execute tasks precisely"

# Persistent agent (execution-scoped)
agent captain:
  model: opus
  persist: true
  prompt: "You coordinate and review, never implement directly"

# Persistent agent (project-scoped)
agent advisor:
  model: opus
  persist: project
  prompt: "You provide architectural guidance"

# Persistent agent (user-scoped, cross-project)
agent inspector:
  model: opus
  persist: user
  prompt: "You maintain insights across all projects on this machine"

# Persistent agent (explicit path)
agent shared:
  model: opus
  persist: ".prose/custom/shared-agent/"
  prompt: "Shared across multiple programs"
````

### Invocation

Two keywords distinguish fresh vs resumed invocations:

```prose
# First invocation OR re-initialize (starts fresh)
session: captain
  prompt: "Review the plan"
  context: plan

# Subsequent invocations (picks up memory)
resume: captain
  prompt: "Review step 1"
  context: step1

# Output capture works with both
let review = resume: captain
  prompt: "Review step 2"
  context: step2
```

### Memory Semantics

| Keyword    | Memory Behavior                       |
| ---------- | ------------------------------------- |
| `session:` | Ignores existing memory, starts fresh |
| `resume:`  | Loads memory, continues with context  |

### Memory Scoping

| Scope               | Declaration        | Path                              | Lifetime                 |
| ------------------- | ------------------ | --------------------------------- | ------------------------ |
| Execution (default) | `persist: true`    | `.prose/runs/{id}/agents/{name}/` | Dies with run            |
| Project             | `persist: project` | `.prose/agents/{name}/`           | Survives runs in project |
| User                | `persist: user`    | `~/.prose/agents/{name}/`         | Survives across projects |
| Custom              | `persist: "path"`  | Specified path                    | User-controlled          |

---

## Spawning Sessions

Each `session` statement spawns a subagent using the **Task tool**:

```
session "Analyze the codebase"
```

Execute as:

```
Task({
  description: "OpenProse session",
  prompt: "Analyze the codebase",
  subagent_type: "general-purpose"
})
```

### With Agent Configuration

```
agent researcher:
  model: opus
  prompt: "You are a research expert"

session: researcher
  prompt: "Research quantum computing"
```

Execute as:

```
Task({
  description: "OpenProse session",
  prompt: "Research quantum computing\n\nSystem: You are a research expert",
  subagent_type: "general-purpose",
  model: "opus"
})
```

### With Persistent Agent (resume)

```prose
agent captain:
  model: opus
  persist: true
  prompt: "You coordinate and review"

# First invocation
session: captain
  prompt: "Review the plan"

# Subsequent invocation - loads memory
resume: captain
  prompt: "Review step 1"
```

For `resume:`, include the agent's memory file content and output path in the prompt.

### Property Precedence

Session properties override agent defaults:

1. Session-level `model:` overrides agent `model:`
2. Session-level `prompt:` replaces (not appends) agent `prompt:`
3. Agent `prompt:` becomes system context if session has its own prompt

---

## Parallel Execution

`parallel:` blocks spawn multiple sessions concurrently:

```prose
parallel:
  a = session "Task A"
  b = session "Task B"
  c = session "Task C"
```

Execute by calling Task multiple times in parallel:

```
// All three spawn simultaneously
Task({ prompt: "Task A", ... })  // result -> a
Task({ prompt: "Task B", ... })  // result -> b
Task({ prompt: "Task C", ... })  // result -> c
// Wait for all to complete, then continue
```

### Join Strategies

| Strategy          | Behavior                                  |
| ----------------- | ----------------------------------------- |
| `"all"` (default) | Wait for all branches                     |
| `"first"`         | Return on first completion, cancel others |
| `"any"`           | Return on first success                   |
| `"any", count: N` | Wait for N successes                      |

### Failure Policies

| Policy                  | Behavior                         |
| ----------------------- | -------------------------------- |
| `"fail-fast"` (default) | Fail immediately on any error    |
| `"continue"`            | Wait for all, then report errors |
| `"ignore"`              | Treat failures as successes      |

---

## Evaluating Discretion Conditions

Discretion markers (`**...**`) signal AI-evaluated conditions:

```prose
loop until **the code is bug-free**:
  session "Find and fix bugs"
```

### Evaluation Approach

1. **Context awareness**: Consider all prior session outputs
2. **Semantic interpretation**: Understand the intent, not literal parsing
3. **Conservative judgment**: When uncertain, continue iterating
4. **Progress detection**: Exit if no meaningful progress is being made

### Multi-line Conditions

```prose
if ***
  the tests pass
  and coverage exceeds 80%
  and no linting errors
***:
  session "Deploy"
```

Triple-asterisks allow complex, multi-line conditions.

---

## Context Passing

Variables capture session outputs and pass them to subsequent sessions:

```prose
let research = session "Research the topic"

session "Write summary"
  context: research
```

### Context Forms

| Form                   | Usage                              |
| ---------------------- | ---------------------------------- |
| `context: var`         | Single variable                    |
| `context: [a, b, c]`   | Multiple variables as array        |
| `context: { a, b, c }` | Multiple variables as named object |
| `context: []`          | Empty context (fresh start)        |

### How Context is Passed

The VM passes context **by reference**, not by value. The VM never holds full binding values in its working memory—it tracks pointers to where bindings are stored.

When spawning a session with context:

1. Pass the **binding location** (file path or database coordinates)
2. The subagent reads what it needs directly from storage
3. The subagent decides how much to load based on its task

**For filesystem state:**

```
Context (by reference):
- research: .prose/runs/20260116-143052-a7b3c9/bindings/research.md
- analysis: .prose/runs/20260116-143052-a7b3c9/bindings/analysis.md

Read these files to access the content. For large bindings, read selectively.
```

**For PostgreSQL state:**

```
Context (by reference):
- research: openprose.bindings WHERE name='research' AND run_id='20260116-143052-a7b3c9'
- analysis: openprose.bindings WHERE name='analysis' AND run_id='20260116-143052-a7b3c9'

Query the database to access the content.
```

**Why reference-based:** This enables RLM-style patterns where the environment holds arbitrarily large values and agents interact with them programmatically, without the VM becoming a bottleneck.

---

## Program Composition

Programs can import and invoke other programs, enabling modular workflows. Programs are fetched from the registry at `p.prose.md`.

### Importing Programs

Use the `use` statement to import a program:

```prose
use "alice/research"
use "bob/critique" as critic
```

The import path follows the format `handle/slug`. An optional alias (`as name`) allows referencing by a shorter name.

### Program URL Resolution

When the VM encounters a `use` statement:

1. Fetch the program from `https://p.prose.md/handle/slug`
2. Parse the program to extract its contract (inputs/outputs)
3. Register the program in the Import Registry

### Input Declarations

Inputs declare values that come from outside the program:

```prose
# Top-level inputs (bound at program start)
input topic: "The subject to research"
input depth: "How deep to go (shallow, medium, deep)"

# Mid-program inputs (runtime user prompts)
input user_decision: **Proceed with deployment?**
input confirmation: "Type 'yes' to confirm deletion"
```

### Input Binding Semantics

Inputs can appear **anywhere** in the program. The binding behavior depends on whether a value is pre-supplied:

| Scenario                                                | Behavior                                   |
| ------------------------------------------------------- | ------------------------------------------ |
| Value pre-supplied by caller                            | Bind immediately, continue execution       |
| Value supplied at runtime (e.g., CLI args, API payload) | Bind immediately, continue execution       |
| No value available                                      | **Pause execution**, prompt user for input |

**Top-level inputs** (before executable statements):

- Typically bound at program invocation
- If missing, prompt before execution begins

**Mid-program inputs** (between statements):

- Check if value was pre-supplied or available from runtime context
- If available: bind and continue
- If not available: pause execution, display prompt, wait for user response

### Input Prompt Formats

```prose
# String prompt (literal text shown to user)
input confirm: "Do you want to proceed? (yes/no)"

# Discretion prompt (AI interprets and presents appropriately)
input next_step: **What should we do next given the diagnosis?**

# Rich prompt with context
input approval: ***
  The fix has been implemented:
  {fix_summary}

  Deploy to production?
***
```

If the underlying substrate has any type of Poll/AskUserQuestion tool, you can use it to ask the user a question in a poll format with a range of options, this is often the best way to ask a question to the user.

The discretion form (`**...**`) allows the VM to present the prompt intelligently based on context, while string prompts are shown verbatim.

### Input Summary

Inputs:

- Can appear anywhere in the program (top-level or mid-execution)
- Have a name and a prompt (string or discretion)
- Bind immediately if value is pre-supplied
- Pause for user input if no value is available
- Become available as variables after binding

### Output Bindings

Outputs declare what values a program produces for its caller. Use the `output` keyword at assignment time:

```prose
let raw = session "Research {topic}"
output findings = session "Synthesize research"
  context: raw
output sources = session "Extract sources"
  context: raw
```

The `output` keyword:

- Marks a variable as an output (visible at assignment, not just at file top)
- Works like `let` but also registers the value as a program output
- Can appear anywhere in the program body
- Multiple outputs are supported

### Invoking Imported Programs

Call an imported program by providing its inputs:

```prose
use "alice/research" as research

let result = research(topic: "quantum computing")
```

The result contains all outputs from the invoked program, accessible as properties:

```prose
session "Write summary"
  context: result.findings

session "Cite sources"
  context: result.sources
```

### Destructuring Outputs

For convenience, outputs can be destructured:

```prose
let { findings, sources } = research(topic: "quantum computing")
```

### Import Execution Semantics

When a program invokes an imported program:

1. **Bind inputs**: Map caller-provided values to the imported program's inputs
2. **Execute**: Run the imported program (spawns its own sessions)
3. **Collect outputs**: Gather all `output` bindings from the imported program
4. **Return**: Make outputs available to the caller as a result object

The imported program runs in its own execution context but shares the same VM session.

### Imports Recursive Structure

Imported programs use the **same unified structure recursively**:

```
.prose/runs/{id}/imports/{handle}--{slug}/
├── program.prose
├── state.md
├── bindings/
│   └── {name}.md
├── imports/                    # Nested imports go here
│   └── {handle2}--{slug2}/
│       └── ...
└── agents/
    └── {name}/
```

This allows unlimited nesting depth while maintaining consistent structure at every level.

---

## Loop Execution

### Fixed Loops

```prose
repeat 3:
  session "Generate idea"
```

Execute the body exactly 3 times sequentially.

```prose
for topic in ["AI", "ML", "DL"]:
  session "Research"
    context: topic
```

Execute once per item, with `topic` bound to each value.

### Parallel For-Each

```prose
parallel for item in items:
  session "Process"
    context: item
```

Fan-out: spawn all iterations concurrently, wait for all.

### Unbounded Loops

```prose
loop until **task complete** (max: 10):
  session "Work on task"
```

1. Check condition before each iteration
2. Exit if condition satisfied OR max reached
3. Execute body if continuing

---

## Error Propagation

### Try/Catch Semantics

```prose
try:
  session "Risky operation"
catch as err:
  session "Handle error"
    context: err
finally:
  session "Cleanup"
```

Execution order:

1. **Success**: try -> finally
2. **Failure**: try (until fail) -> catch -> finally

### Throw Behavior

- `throw` inside catch: re-raise to outer handler
- `throw "message"`: raise new error with message
- Unhandled throws: propagate to outer scope or fail program

### Retry Mechanism

```prose
session "Flaky API"
  retry: 3
  backoff: "exponential"
```

On failure:

1. Retry up to N times
2. Apply backoff delay between attempts
3. If all retries fail, propagate error

---

## Choice and Conditional Execution

### Choice Blocks

```prose
choice **the severity level**:
  option "Critical":
    session "Escalate immediately"
  option "Minor":
    session "Log for later"
```

1. Evaluate the discretion criteria
2. Select the most appropriate option
3. Execute only that option's body

### If/Elif/Else

```prose
if **has security issues**:
  session "Fix security"
elif **has performance issues**:
  session "Optimize"
else:
  session "Approve"
```

1. Evaluate conditions in order
2. Execute first matching branch
3. Skip remaining branches

---

## Block Invocation

### Defining Blocks

```prose
block review(topic):
  session "Research {topic}"
  session "Analyze {topic}"
```

Blocks are hoisted - can be used before definition.

### Invoking Blocks

```prose
do review("quantum computing")
```

1. Push new frame onto call stack
2. Bind arguments to parameters (scoped to this frame)
3. Execute block body
4. Pop frame from call stack
5. Return to caller

---

## Call Stack Management

The VM maintains a call stack for block invocations. Each frame represents one invocation, enabling recursion with proper scope isolation.

### Stack Frame Structure

| Field             | Description                                       |
| ----------------- | ------------------------------------------------- |
| `execution_id`    | Unique ID for this invocation (monotonic counter) |
| `block_name`      | Name of the block being executed                  |
| `arguments`       | Bound parameter values                            |
| `local_bindings`  | Variables bound within this invocation            |
| `return_position` | Statement index to resume after block completes   |
| `depth`           | Current recursion depth (stack length)            |

### Execution ID Generation

Each block invocation gets a unique `execution_id`:

- Start at 1 for the first block invocation in a run
- Increment for each subsequent invocation
- Never reuse within a run
- Root scope (outside any block) has `execution_id: 0` (conceptually)

**Storage representation:** State backends may represent root scope differently—databases use `NULL`, filesystem uses no suffix. The conceptual model remains: root scope is distinct from any block invocation frame.

### Recursive Block Invocation

Blocks can call themselves by name:

```prose
block process(chunk, depth):
  if depth <= 0:
    session "Handle directly"
      context: chunk
  else:
    let parts = session "Split into parts"
      context: chunk
    for part in parts:
      do process(part, depth - 1)  # Recursive call
    session "Combine results"
      context: parts

do process(data, 5)
```

**Execution flow:**

1. VM encounters `do process(data, 5)`
2. VM pushes frame: `{execution_id: 1, block: "process", args: [data, 5], depth: 1}`
3. VM executes block body, spawns "Split into parts" session
4. VM encounters recursive `do process(part, depth - 1)`
5. VM pushes frame: `{execution_id: 2, block: "process", args: [part, 4], depth: 2}`
6. Recursion continues until base case
7. Frames pop as blocks complete

**Key insight:** Sessions don't recurse—they're leaf nodes. The VM manages the entire call tree.

### Scope Resolution

When resolving a variable name:

1. Check current frame's `local_bindings`
2. Check parent frame's `local_bindings` (lexical scope)
3. Continue up the call stack to root
4. Check global scope (imports, agents, blocks)
5. Error if not found

```
do process(chunk, 5)           # execution_id: 1
  let parts = ...              # parts bound in execution_id: 1
  do process(parts[0], 4)      # execution_id: 2
    let parts = ...            # NEW parts bound in execution_id: 2 (shadows parent)
    # Accessing 'chunk' resolves to execution_id: 2's argument
```

**Only local bindings are scoped.** Global definitions (agents, blocks, imports) are shared across all frames.

### Recursion Depth Limits

Default maximum depth: **100**

Configure per-block:

```prose
block process(chunk, depth) (max_depth: 50):
  ...
```

If limit exceeded:

```
[Error] RecursionLimitExceeded: block 'process' exceeded max_depth 50
```

### Call Stack in State

The VM tracks the call stack in its state. For filesystem state, this appears in `state.md`:

```markdown
## Call Stack

| execution_id | block   | depth | status    |
| ------------ | ------- | ----- | --------- |
| 3            | process | 3     | executing |
| 2            | process | 2     | waiting   |
| 1            | process | 1     | waiting   |
```

For in-context state, use `[Frame+]` and `[Frame-]` markers (see `state/in-context.md`).

---

## Pipeline Execution

```prose
let results = items
  | filter:
      session "Keep? yes/no"
        context: item
  | map:
      session "Transform"
        context: item
```

Execute left-to-right:

1. **filter**: Keep items where session returns truthy
2. **map**: Transform each item via session
3. **reduce**: Accumulate items pairwise
4. **pmap**: Like map but concurrent

---

## String Interpolation

```prose
let name = session "Get user name"
session "Hello {name}, welcome!"
```

Before spawning, substitute `{varname}` with variable values.

---

## Complete Execution Algorithm

```
function execute(program, inputs?):
  1. Collect all use statements, fetch and register imports
  2. Collect all input declarations, bind values from caller
  3. Collect all agent definitions
  4. Collect all block definitions
  5. For each statement in order:
     - If session: spawn via Task, await result
     - If resume: load memory, spawn via Task, await result
     - If let/const: execute RHS, bind result
     - If output: execute RHS, bind result, register as output
     - If program call: invoke imported program with inputs, receive outputs
     - If parallel: spawn all branches, await per strategy
     - If loop: evaluate condition, execute body, repeat
     - If try: execute try, catch on error, always finally
     - If choice/if: evaluate condition, execute matching branch
     - If do block: invoke block with arguments
  6. Handle errors according to try/catch or propagate
  7. Collect all output bindings
  8. Return outputs to caller (or final result if no outputs declared)
```

---

## Implementation Notes

### Task Tool Usage

Always use Task for session execution:

```
Task({
  description: "OpenProse session",
  prompt: "<session prompt with context>",
  subagent_type: "general-purpose",
  model: "<optional model override>"
})
```

### Parallel Execution

Make multiple Task calls in a single response for true concurrency:

```
// In one response, call all three:
Task({ prompt: "A" })
Task({ prompt: "B" })
Task({ prompt: "C" })
```

### Context Serialization

When passing context to sessions:

- Prefix with clear labels
- Keep relevant information
- Summarize if very long
- Maintain semantic meaning

---

## Summary

The OpenProse VM:

1. **Imports** programs from `p.prose.md` via `use` statements
2. **Binds** inputs from caller to program variables
3. **Parses** the program structure
4. **Collects** definitions (agents, blocks)
5. **Executes** statements sequentially
6. **Spawns** sessions via Task tool
7. **Resumes** persistent agents with memory
8. **Invokes** imported programs with inputs, receives outputs
9. **Coordinates** parallel execution
10. **Evaluates** discretion conditions intelligently
11. **Manages** context flow between sessions
12. **Handles** errors with try/catch/retry
13. **Tracks** state in files (`.prose/runs/`) or conversation
14. **Returns** output bindings to caller

The language is self-evident by design. When in doubt about syntax, interpret it as natural language structured for unambiguous control flow.
