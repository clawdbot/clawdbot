---
role: language-specification
summary: |
  Complete syntax grammar, validation rules, and compilation semantics for OpenProse.
  Read this file when compiling, validating, or resolving ambiguous syntax. Assumes
  prose.md is already in context for execution semantics.
see-also:
  - SKILL.md: Activation triggers, onboarding
  - prose.md: Execution semantics, how to run programs
  - state/filesystem.md: File-system state management (default)
  - state/in-context.md: In-context state management (on request)
---

# OpenProse Language Reference

OpenProse is a programming language for AI sessions. An AI session is a Turing-complete computer; this document provides complete documentation for the language syntax, semantics, and execution model.

---

## Document Purpose: Compiler + Validator

This document serves a dual role:

### As Compiler

When asked to "compile" a `.prose` file, use this specification to:

1. **Parse** the program according to the syntax grammar
2. **Validate** that the program is well-formed and semantically valid
3. **Transform** the program into "best practice" canonical form:
   - Expand syntax sugar where appropriate
   - Normalize formatting and structure
   - Apply optimizations (e.g., hoisting block definitions)

### As Validator

The validation criterion: **Would a blank agent with only `prose.md` understand this program as self-evident?**

When validating, check:

- Syntax correctness (all constructs match grammar)
- Semantic validity (references resolve, types match)
- Self-evidence (program is clear without this full spec)

If a construct is ambiguous or non-obvious, it should be flagged or transformed into a clearer form.

### When to Read This Document

- **Compilation requested**: Read fully to apply all rules
- **Validation requested**: Read fully to check all constraints
- **Ambiguous syntax encountered**: Reference specific sections
- **Interpretation only**: Use `prose.md` instead (smaller, faster)

---

## Table of Contents

1. [Overview](#overview)
2. [File Format](#file-format)
3. [Comments](#comments)
4. [String Literals](#string-literals)
5. [Use Statements](#use-statements-program-composition)
6. [Input Declarations](#input-declarations)
7. [Output Bindings](#output-bindings)
8. [Program Invocation](#program-invocation)
9. [Agent Definitions](#agent-definitions)
10. [Session Statement](#session-statement)
11. [Resume Statement](#resume-statement)
12. [Variables & Context](#variables--context)
13. [Composition Blocks](#composition-blocks)
14. [Parallel Blocks](#parallel-blocks)
15. [Fixed Loops](#fixed-loops)
16. [Unbounded Loops](#unbounded-loops)
17. [Pipeline Operations](#pipeline-operations)
18. [Error Handling](#error-handling)
19. [Choice Blocks](#choice-blocks)
20. [Conditional Statements](#conditional-statements)
21. [Execution Model](#execution-model)
22. [Validation Rules](#validation-rules)
23. [Examples](#examples)
24. [Future Features](#future-features)

---

## Overview

OpenProse provides a declarative syntax for defining multi-agent workflows. Programs consist of statements that are executed sequentially, with each `session` statement spawning a subagent to complete a task.

### Design Principles

- **Pattern over framework**: The simplest solution is barely anything at all—just structure for English
- **Self-evident**: Programs should be understandable with minimal documentation
- **The OpenProse VM is intelligent**: Design for understanding, not parsing
- **Framework-agnostic**: Works with Claude Code, OpenCode, and any future agent framework
- **Files are artifacts**: `.prose` is the portable unit of work

### Current Implementation Status

The following features are implemented:

| Feature                | Status      | Description                                  |
| ---------------------- | ----------- | -------------------------------------------- |
| Comments               | Implemented | `# comment` syntax                           |
| Single-line strings    | Implemented | `"string"` with escapes                      |
| Simple session         | Implemented | `session "prompt"`                           |
| Agent definitions      | Implemented | `agent name:` with model/prompt properties   |
| Session with agent     | Implemented | `session: agent` with property overrides     |
| Use statements         | Implemented | `use "@handle/slug" as name`                 |
| Agent skills           | Implemented | `skills: ["skill1", "skill2"]`               |
| Agent permissions      | Implemented | `permissions:` block with rules              |
| Let binding            | Implemented | `let name = session "..."`                   |
| Const binding          | Implemented | `const name = session "..."`                 |
| Variable reassignment  | Implemented | `name = session "..."` (for let only)        |
| Context property       | Implemented | `context: var` or `context: [a, b, c]`       |
| do: blocks             | Implemented | Explicit sequential blocks                   |
| Inline sequence        | Implemented | `session "A" -> session "B"`                 |
| Named blocks           | Implemented | `block name:` with `do name` invocation      |
| Parallel blocks        | Implemented | `parallel:` for concurrent execution         |
| Named parallel results | Implemented | `x = session "..."` inside parallel          |
| Object context         | Implemented | `context: { a, b, c }` shorthand             |
| Join strategies        | Implemented | `parallel ("first"):` or `parallel ("any"):` |
| Failure policies       | Implemented | `parallel (on-fail: "continue"):`            |
| Repeat blocks          | Implemented | `repeat N:` fixed iterations                 |
| Repeat with index      | Implemented | `repeat N as i:` with index variable         |
| For-each blocks        | Implemented | `for item in items:` iteration               |
| For-each with index    | Implemented | `for item, i in items:` with index           |
| Parallel for-each      | Implemented | `parallel for item in items:` fan-out        |
| Unbounded loop         | Implemented | `loop:` with optional max iterations         |
| Loop until             | Implemented | `loop until **condition**:` AI-evaluated     |
| Loop while             | Implemented | `loop while **condition**:` AI-evaluated     |
| Loop with index        | Implemented | `loop as i:` or `loop until ... as i:`       |
| Map pipeline           | Implemented | `items \| map:` transform each item          |
| Filter pipeline        | Implemented | `items \| filter:` keep matching items       |
| Reduce pipeline        | Implemented | `items \| reduce(acc, item):` accumulate     |
| Parallel map           | Implemented | `items \| pmap:` concurrent transform        |
| Pipeline chaining      | Implemented | `\| filter: ... \| map: ...`                 |
| Try/catch blocks       | Implemented | `try:` with `catch:` for error handling      |
| Try/catch/finally      | Implemented | `finally:` for cleanup                       |
| Error variable         | Implemented | `catch as err:` access error context         |
| Throw statement        | Implemented | `throw` or `throw "message"`                 |
| Retry property         | Implemented | `retry: 3` automatic retry on failure        |
| Backoff strategy       | Implemented | `backoff: exponential` delay between retries |
| Input declarations     | Implemented | `input name: "description"`                  |
| Output bindings        | Implemented | `output name = expression`                   |
| Program invocation     | Implemented | `name(input: value)` call imported programs  |
| Multi-line strings     | Implemented | `"""..."""` preserving whitespace            |
| String interpolation   | Implemented | `"Hello {name}"` variable substitution       |
| Block parameters       | Implemented | `block name(param):` with parameters         |
| Block invocation args  | Implemented | `do name(arg)` passing arguments             |
| Choice blocks          | Implemented | `choice **criteria**: option "label":`       |
| If/elif/else           | Implemented | `if **condition**:` conditional branching    |
| Persistent agents      | Implemented | `persist: true` or `persist: project`        |
| Resume statement       | Implemented | `resume: agent` to continue with memory      |

---

## File Format

| Property         | Value                |
| ---------------- | -------------------- |
| Extension        | `.prose`             |
| Encoding         | UTF-8                |
| Case sensitivity | Case-sensitive       |
| Indentation      | Spaces (Python-like) |
| Line endings     | LF or CRLF           |

---

## Comments

Comments provide documentation within programs and are ignored during execution.

### Syntax

```prose
# This is a standalone comment

session "Hello"  # This is an inline comment
```

### Rules

1. Comments begin with `#` and extend to end of line
2. Comments can appear on their own line or after a statement
3. Empty comments are valid: `#`
4. The `#` character inside string literals is NOT a comment

### Examples

```prose
# Program header comment
# Author: Example

session "Do something"  # Explain what this does

# This comment is between statements
session "Do another thing"
```

### Compilation Behavior

Comments are **stripped during compilation**. The OpenProse VM never sees them. They have no effect on execution and exist purely for human documentation.

### Important Notes

- **Comments inside strings are NOT comments**:

  ```prose
  session "Say hello # this is part of the string"
  ```

  The `#` inside the string literal is part of the prompt, not a comment.

- **Comments inside indented blocks are allowed**:
  ```prose
  agent researcher:
      # This comment is inside the block
      model: sonnet
  # This comment is outside the block
  ```

---

## String Literals

String literals represent text values, primarily used for session prompts.

### Syntax

Strings are enclosed in double quotes:

```prose
"This is a string"
```

### Escape Sequences

The following escape sequences are supported:

| Sequence | Meaning      |
| -------- | ------------ |
| `\\`     | Backslash    |
| `\"`     | Double quote |
| `\n`     | Newline      |
| `\t`     | Tab          |

### Examples

```prose
session "Hello world"
session "Line one\nLine two"
session "She said \"hello\""
session "Path: C:\\Users\\name"
session "Column1\tColumn2"
```

### Rules

1. Single-line strings must be properly terminated with a closing `"`
2. Unknown escape sequences are errors
3. Empty strings `""` are valid but generate a warning when used as prompts

### Multi-line Strings

Multi-line strings use triple double-quotes (`"""`) and preserve internal whitespace and newlines:

```prose
session """
This is a multi-line prompt.
It preserves:
  - Indentation
  - Line breaks
  - All internal whitespace
"""
```

#### Multi-line String Rules

1. Opening `"""` must be followed by a newline
2. Content continues until closing `"""`
3. Escape sequences work the same as single-line strings
4. Leading/trailing whitespace inside the delimiters is preserved

### String Interpolation

Strings can embed variable references using `{varname}` syntax:

```prose
let name = session "Get the user's name"

session "Hello {name}, welcome to the system!"
```

#### Interpolation Syntax

- Variables are referenced by wrapping the variable name in curly braces: `{varname}`
- Works in both single-line and multi-line strings
- Empty braces `{}` are treated as literal text, not interpolation
- Nested braces are not supported

#### Examples

```prose
let research = session "Research the topic"
let analysis = session "Analyze findings"

# Single variable interpolation
session "Based on {research}, provide recommendations"

# Multiple interpolations
session "Combining {research} with {analysis}, synthesize insights"

# Multi-line with interpolation
session """
Review Summary:
- Research: {research}
- Analysis: {analysis}
Please provide final recommendations.
"""
```

#### Interpolation Rules

1. Variable names must be valid identifiers
2. Referenced variables must be in scope
3. Empty braces `{}` are literal text
4. Backslash can escape braces: `\{` produces literal `{`

### Validation

| Check                            | Result  |
| -------------------------------- | ------- |
| Unterminated string              | Error   |
| Unknown escape sequence          | Error   |
| Empty string as prompt           | Warning |
| Undefined interpolation variable | Error   |

---

## Use Statements (Program Composition)

Use statements import other OpenProse programs from the registry at `p.prose.md`, enabling modular workflows.

### Syntax

```prose
use "@handle/slug"
use "@handle/slug" as alias
```

### Path Format

Import paths follow the format `@handle/slug`:

- `@handle` identifies the program author/organization
- `slug` is the program name

An optional alias (`as name`) allows referencing by a shorter name.

### Examples

```prose
# Import a program
use "@alice/research"

# Import with alias
use "@bob/critique" as critic
```

### Program URL Resolution

When the OpenProse VM encounters a `use` statement:

1. Fetch the program from `https://p.prose.md/@handle/slug`
2. Parse the program to extract its contract (inputs/outputs)
3. Register the program in the Import Registry

### Validation Rules

| Check                 | Severity | Message                                |
| --------------------- | -------- | -------------------------------------- |
| Empty path            | Error    | Use path cannot be empty               |
| Invalid path format   | Error    | Path must be @handle/slug format       |
| Duplicate import      | Error    | Program already imported               |
| Missing alias for dup | Error    | Alias required when importing multiple |

### Execution Semantics

Use statements are processed before any agent definitions or sessions. The OpenProse VM:

1. Fetches and validates all imported programs at the start of execution
2. Extracts input/output contracts from each program
3. Registers programs in the Import Registry for later invocation

---

## Input Declarations

Inputs declare what values a program expects from its caller.

### Syntax

```prose
input name: "description"
```

### Examples

```prose
input topic: "The subject to research"
input depth: "How deep to go (shallow, medium, deep)"
```

### Semantics

Inputs:

- Are declared at the top of the program (before executable statements)
- Have a name and a description (for documentation)
- Become available as variables within the program body
- Must be provided by the caller when invoking the program

### Validation Rules

| Check                  | Severity | Message                                              |
| ---------------------- | -------- | ---------------------------------------------------- |
| Empty input name       | Error    | Input name cannot be empty                           |
| Empty description      | Warning  | Consider adding a description                        |
| Duplicate input name   | Error    | Input already declared                               |
| Input after executable | Error    | Inputs must be declared before executable statements |

---

## Output Bindings

Outputs declare what values a program produces for its caller.

### Syntax

```prose
output name = expression
```

### Examples

```prose
let raw = session "Research {topic}"
output findings = session "Synthesize research"
  context: raw
output sources = session "Extract sources"
  context: raw
```

### Semantics

The `output` keyword:

- Marks a variable as an output (visible at assignment, not just at file top)
- Works like `let` but also registers the value as a program output
- Can appear anywhere in the program body
- Multiple outputs are supported

### Validation Rules

| Check                 | Severity | Message                             |
| --------------------- | -------- | ----------------------------------- |
| Empty output name     | Error    | Output name cannot be empty         |
| Duplicate output name | Error    | Output already declared             |
| Output name conflicts | Error    | Output name conflicts with variable |

---

## Program Invocation

Call imported programs by providing their inputs.

### Syntax

```prose
name(input1: value1, input2: value2)
```

### Examples

```prose
use "@alice/research" as research

let result = research(topic: "quantum computing")
```

### Accessing Outputs

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

### Execution Semantics

When a program invokes an imported program:

1. **Bind inputs**: Map caller-provided values to the imported program's inputs
2. **Execute**: Run the imported program (spawns its own sessions)
3. **Collect outputs**: Gather all `output` bindings from the imported program
4. **Return**: Make outputs available to the caller as a result object

The imported program runs in its own execution context but shares the same VM session.

### Validation Rules

| Check                   | Severity | Message                        |
| ----------------------- | -------- | ------------------------------ |
| Unknown program         | Error    | Program not imported           |
| Missing required input  | Error    | Required input not provided    |
| Unknown input name      | Error    | Input not declared in program  |
| Unknown output property | Error    | Output not declared in program |

---

## Agent Definitions

Agents are reusable templates that configure subagent behavior. Once defined, agents can be referenced in session statements.

### Syntax

```prose
agent name:
  model: sonnet
  prompt: "System prompt for this agent"
  skills: ["skill1", "skill2"]
  permissions:
    read: ["*.md"]
    bash: deny
```

### Properties

| Property      | Type       | Values                       | Description                         |
| ------------- | ---------- | ---------------------------- | ----------------------------------- |
| `model`       | identifier | `sonnet`, `opus`, `haiku`    | The Claude model to use             |
| `prompt`      | string     | Any string                   | System prompt/context for the agent |
| `persist`     | value      | `true`, `project`, or STRING | Enable persistent memory for agent  |
| `skills`      | array      | String array                 | Skills assigned to this agent       |
| `permissions` | block      | Permission rules             | Access control for the agent        |

### Persist Property

The `persist` property enables agents to maintain memory across invocations:

```prose
# Execution-scoped persistence (memory dies with run)
agent captain:
  model: opus
  persist: true
  prompt: "You coordinate and review"

# Project-scoped persistence (memory survives across runs)
agent advisor:
  model: opus
  persist: project
  prompt: "You provide architectural guidance"

# Custom path persistence
agent shared:
  model: opus
  persist: ".prose/custom/shared-agent/"
  prompt: "Shared across programs"
```

| Value     | Memory Location                   | Lifetime            |
| --------- | --------------------------------- | ------------------- |
| `true`    | `.prose/runs/{id}/agents/{name}/` | Dies with execution |
| `project` | `.prose/agents/{name}/`           | Survives executions |
| STRING    | Specified path                    | User-controlled     |

### Skills Property

The `skills` property assigns imported skills to an agent:

```prose
use "@anthropic/web-search"
use "@anthropic/summarizer" as summarizer

agent researcher:
  skills: ["web-search", "summarizer"]
```

Skills must be imported before they can be assigned. Referencing an unimported skill generates a warning.

### Permissions Property

The `permissions` property controls agent access:

```prose
agent secure-agent:
  permissions:
    read: ["*.md", "*.txt"]
    write: ["output/"]
    bash: deny
    network: allow
```

#### Permission Types

| Type      | Description                                  |
| --------- | -------------------------------------------- |
| `read`    | Files the agent can read (glob patterns)     |
| `write`   | Files the agent can write (glob patterns)    |
| `execute` | Files the agent can execute (glob patterns)  |
| `bash`    | Shell access: `allow`, `deny`, or `prompt`   |
| `network` | Network access: `allow`, `deny`, or `prompt` |

#### Permission Values

| Value    | Description                                       |
| -------- | ------------------------------------------------- |
| `allow`  | Permission granted                                |
| `deny`   | Permission denied                                 |
| `prompt` | Ask user for permission                           |
| Array    | List of allowed patterns (for read/write/execute) |

### Examples

```prose
# Define a research agent
agent researcher:
  model: sonnet
  prompt: "You are a research assistant skilled at finding and synthesizing information"

# Define a writing agent
agent writer:
  model: opus
  prompt: "You are a technical writer who creates clear, concise documentation"

# Agent with only model
agent quick:
  model: haiku

# Agent with only prompt
agent expert:
  prompt: "You are a domain expert"

# Agent with skills
agent web-researcher:
  model: sonnet
  skills: ["web-search", "summarizer"]

# Agent with permissions
agent file-handler:
  permissions:
    read: ["*.md", "*.txt"]
    write: ["output/"]
    bash: deny
```

### Model Selection

| Model    | Use Case                              |
| -------- | ------------------------------------- |
| `haiku`  | Fast, simple tasks; quick responses   |
| `sonnet` | Balanced performance; general purpose |
| `opus`   | Complex reasoning; detailed analysis  |

### Execution Semantics

When a session references an agent:

1. The agent's `model` property determines which Claude model is used
2. The agent's `prompt` property is included as system context
3. Session properties can override agent defaults

### Validation Rules

| Check                 | Severity | Message                        |
| --------------------- | -------- | ------------------------------ |
| Duplicate agent name  | Error    | Agent already defined          |
| Invalid model value   | Error    | Must be sonnet, opus, or haiku |
| Empty prompt property | Warning  | Consider providing a prompt    |
| Duplicate property    | Error    | Property already specified     |

---

## Session Statement

The session statement is the primary executable construct in OpenProse. It spawns a subagent to complete a task.

### Syntax Variants

#### Simple Session (with inline prompt)

```prose
session "prompt text"
```

#### Session with Agent Reference

```prose
session: agentName
```

#### Named Session with Agent

```prose
session sessionName: agentName
```

#### Session with Properties

```prose
session: agentName
  prompt: "Override the agent's default prompt"
  model: opus  # Override the agent's model
```

### Property Overrides

When a session references an agent, it can override the agent's properties:

```prose
agent researcher:
  model: sonnet
  prompt: "You are a research assistant"

# Use researcher with different model
session: researcher
  model: opus

# Use researcher with different prompt
session: researcher
  prompt: "Research this specific topic in depth"

# Override both
session: researcher
  model: opus
  prompt: "Specialized research task"
```

### Execution Semantics

When the OpenProse VM encounters a `session` statement:

1. **Resolve Configuration**: Merge agent defaults with session overrides
2. **Spawn a Subagent**: Create a new Claude subagent with the resolved configuration
3. **Send the Prompt**: Pass the prompt string to the subagent
4. **Wait for Completion**: Block until the subagent finishes
5. **Continue**: Proceed to the next statement

### Execution Flow Diagram

```
OpenProse VM                    Subagent
    |                              |
    |  spawn session               |
    |----------------------------->|
    |                              |
    |  send prompt                 |
    |----------------------------->|
    |                              |
    |  [processing...]             |
    |                              |
    |  session complete            |
    |<-----------------------------|
    |                              |
    |  continue to next statement  |
    v                              v
```

### Sequential Execution

Multiple sessions execute sequentially:

```prose
session "First task"
session "Second task"
session "Third task"
```

Each session waits for the previous one to complete before starting.

### Using Claude Code's Task Tool

To execute a session, use the Task tool:

```typescript
// Simple session
Task({
  description: "OpenProse session",
  prompt: "The prompt from the session statement",
  subagent_type: "general-purpose",
});

// Session with agent configuration
Task({
  description: "OpenProse session",
  prompt: "The session prompt",
  subagent_type: "general-purpose",
  model: "opus", // From agent or override
});
```

### Validation Rules

| Check                     | Severity | Message                                      |
| ------------------------- | -------- | -------------------------------------------- |
| Missing prompt and agent  | Error    | Session requires a prompt or agent reference |
| Undefined agent reference | Error    | Agent not defined                            |
| Empty prompt `""`         | Warning  | Session has empty prompt                     |
| Whitespace-only prompt    | Warning  | Session prompt contains only whitespace      |
| Prompt > 10,000 chars     | Warning  | Consider breaking into smaller tasks         |
| Duplicate property        | Error    | Property already specified                   |

### Examples

```prose
# Simple session
session "Hello world"

# Session with agent
agent researcher:
  model: sonnet
  prompt: "You research topics thoroughly"

session: researcher
  prompt: "Research quantum computing applications"

# Named session
session analysis: researcher
  prompt: "Analyze the competitive landscape"
```

### Canonical Form

The compiled output preserves the structure:

```
Input:
agent researcher:
  model: sonnet

session: researcher
  prompt: "Do research"

Output:
agent researcher:
  model: sonnet
session: researcher
  prompt: "Do research"
```

---

## Resume Statement

The `resume` statement continues a persistent agent with its accumulated memory.

### Syntax

```prose
resume: agentName
  prompt: "Continue from where we left off"
```

### Semantics

| Keyword    | Behavior                              |
| ---------- | ------------------------------------- |
| `session:` | Ignores existing memory, starts fresh |
| `resume:`  | Loads memory, continues with context  |

### Examples

```prose
agent captain:
  model: opus
  persist: true
  prompt: "You coordinate and review"

# First invocation - creates memory
session: captain
  prompt: "Review the plan"
  context: plan

# Later invocation - loads memory
resume: captain
  prompt: "Review step 1 of the plan"
  context: step1

# Output capture works with resume
let review = resume: captain
  prompt: "Final review of all steps"
```

### Validation Rules

| Check                                      | Severity | Message                                                              |
| ------------------------------------------ | -------- | -------------------------------------------------------------------- |
| `resume:` on non-persistent agent          | Error    | Agent must have `persist:` property to use `resume:`                 |
| `resume:` with no existing memory          | Error    | No memory file exists for agent; use `session:` for first invocation |
| `session:` on persistent agent with memory | Warning  | Will ignore existing memory; use `resume:` to continue               |
| Undefined agent reference                  | Error    | Agent not defined                                                    |

---

## Variables & Context

Variables allow you to capture the results of sessions and pass them as context to subsequent sessions.

### Let Binding

The `let` keyword creates a mutable variable bound to a session result:

```prose
let research = session "Research the topic thoroughly"

# research now holds the output of that session
```

Variables can be reassigned:

```prose
let draft = session "Write initial draft"

# Revise the draft
draft = session "Improve the draft"
  context: draft
```

### Const Binding

The `const` keyword creates an immutable variable:

```prose
const config = session "Get configuration settings"

# This would be an error:
# config = session "Try to change"
```

### Context Property

The `context` property passes previous session outputs to a new session:

#### Single Context

```prose
let research = session "Research quantum computing"

session "Write summary"
  context: research
```

#### Multiple Contexts

```prose
let research = session "Research the topic"
let analysis = session "Analyze the findings"

session "Write final report"
  context: [research, analysis]
```

#### Empty Context (Fresh Start)

Use an empty array to start a session without inherited context:

```prose
session "Independent task"
  context: []
```

#### Object Context Shorthand

For passing multiple named results (especially from parallel blocks), use object shorthand:

```prose
parallel:
  a = session "Task A"
  b = session "Task B"

session "Combine results"
  context: { a, b }
```

This is equivalent to passing an object where each property is a variable reference.

### Complete Example

```prose
agent researcher:
  model: sonnet
  prompt: "You are a research assistant"

agent writer:
  model: opus
  prompt: "You are a technical writer"

# Gather research
let research = session: researcher
  prompt: "Research quantum computing developments"

# Analyze findings
let analysis = session: researcher
  prompt: "Analyze the key findings"
  context: research

# Write the final report using both contexts
const report = session: writer
  prompt: "Write a comprehensive report"
  context: [research, analysis]
```

### Validation Rules

| Check                           | Severity | Message                                            |
| ------------------------------- | -------- | -------------------------------------------------- |
| Duplicate variable name         | Error    | Variable already defined                           |
| Const reassignment              | Error    | Cannot reassign const variable                     |
| Undefined variable reference    | Error    | Undefined variable                                 |
| Variable conflicts with agent   | Error    | Variable name conflicts with agent name            |
| Undefined context variable      | Error    | Undefined variable in context                      |
| Non-identifier in context array | Error    | Context array elements must be variable references |

### Flat Namespace Requirement

All variable names must be **unique within a program**. No shadowing is allowed across scopes.

**This is a compile error:**

```prose
let result = session "Outer task"

for item in items:
  let result = session "Inner task"   # Error: 'result' already defined
    context: item
```

**Why this constraint:** Since bindings are stored as `bindings/{name}.md`, two variables with the same name would collide on the filesystem. Rather than introduce complex scoping rules, we enforce uniqueness.

**Collision scenarios this prevents:**

1. Variable inside loop shadows variable outside loop
2. Variables in different `if`/`elif`/`else` branches with same name
3. Block parameters shadowing outer variables
4. Parallel branches reusing outer variable names

**Exception:** Imported programs run in isolated namespaces. A variable `result` in the main program does not collide with `result` in an imported program (they write to different `imports/{handle}--{slug}/bindings/` directories).

---

## Composition Blocks

Composition blocks allow you to structure programs into reusable, named units and express sequences of operations inline.

### do: Block (Anonymous Sequential Block)

The `do:` keyword creates an explicit sequential block. All statements in the block execute in order.

#### Syntax

```prose
do:
  statement1
  statement2
  ...
```

#### Examples

```prose
# Explicit sequential block
do:
  session "Research the topic"
  session "Analyze findings"
  session "Write summary"

# Assign result to a variable
let result = do:
  session "Gather data"
  session "Process data"
```

### Block Definitions

Named blocks create reusable workflow components. Define once, invoke multiple times.

#### Syntax

```prose
block name:
  statement1
  statement2
  ...
```

#### Invoking Blocks

Use `do` followed by the block name to invoke a defined block:

```prose
do blockname
```

#### Examples

```prose
# Define a review pipeline
block review-pipeline:
  session "Security review"
  session "Performance review"
  session "Synthesize reviews"

# Define another block
block final-check:
  session "Final verification"
  session "Sign off"

# Use the blocks
do review-pipeline
session "Make fixes based on review"
do final-check
```

### Block Parameters

Blocks can accept parameters to make them more flexible and reusable.

#### Syntax

```prose
block name(param1, param2):
  # param1 and param2 are available here
  statement1
  statement2
```

#### Invoking with Arguments

Pass arguments when invoking a parameterized block:

```prose
do name(arg1, arg2)
```

#### Examples

```prose
# Define a parameterized block
block review(topic):
  session "Research {topic} thoroughly"
  session "Analyze key findings about {topic}"
  session "Summarize {topic} analysis"

# Invoke with different arguments
do review("quantum computing")
do review("machine learning")
do review("blockchain")
```

#### Multiple Parameters

```prose
block process-item(item, mode):
  session "Process {item} using {mode} mode"
  session "Verify {item} processing"

do process-item("data.csv", "strict")
do process-item("config.json", "lenient")
```

#### Parameter Scope

- Parameters are scoped to the block body
- Parameters shadow outer variables of the same name (with warning)
- Parameters are implicitly `const` within the block

#### Validation Rules

| Check                   | Severity | Message                                        |
| ----------------------- | -------- | ---------------------------------------------- |
| Argument count mismatch | Warning  | Block expects N parameters but got M arguments |
| Parameter shadows outer | Warning  | Parameter shadows outer variable               |

### Inline Sequence (Arrow Operator)

The `->` operator chains sessions into a sequence on a single line. This is syntactic sugar for sequential execution.

#### Syntax

```prose
session "A" -> session "B" -> session "C"
```

This is equivalent to:

```prose
session "A"
session "B"
session "C"
```

#### Examples

```prose
# Quick pipeline
session "Plan" -> session "Execute" -> session "Review"

# Assign result
let workflow = session "Draft" -> session "Edit" -> session "Finalize"
```

### Block Hoisting

Block definitions are hoisted - you can use a block before it's defined in the source:

```prose
# Use before definition
do validation-checks

# Definition comes later
block validation-checks:
  session "Check syntax"
  session "Check semantics"
```

### Nested Composition

Blocks and do: blocks can be nested:

```prose
block outer-workflow:
  session "Start"
  do:
    session "Sub-task 1"
    session "Sub-task 2"
  session "End"

do:
  do outer-workflow
  session "Final step"
```

### Context with Blocks

Blocks work with the context system:

```prose
# Capture do block result
let research = do:
  session "Gather information"
  session "Analyze patterns"

# Use in subsequent session
session "Write report"
  context: research
```

### Validation Rules

| Check                           | Severity | Message                              |
| ------------------------------- | -------- | ------------------------------------ |
| Undefined block reference       | Error    | Block not defined                    |
| Duplicate block definition      | Error    | Block already defined                |
| Block name conflicts with agent | Error    | Block name conflicts with agent name |
| Empty block name                | Error    | Block definition must have a name    |

---

## Parallel Blocks

Parallel blocks allow multiple sessions to run concurrently. All branches execute simultaneously, and the block waits for all to complete before continuing.

### Basic Syntax

```prose
parallel:
  session "Security review"
  session "Performance review"
  session "Style review"
```

All three sessions start at the same time and run concurrently. The program waits for all of them to complete before proceeding.

### Named Parallel Results

Capture the results of parallel branches into variables:

```prose
parallel:
  security = session "Security review"
  perf = session "Performance review"
  style = session "Style review"
```

These variables can then be used in subsequent sessions.

### Object Context Shorthand

Pass multiple parallel results to a session using object shorthand:

```prose
parallel:
  security = session "Security review"
  perf = session "Performance review"
  style = session "Style review"

session "Synthesize all reviews"
  context: { security, perf, style }
```

The object shorthand `{ a, b, c }` is equivalent to passing an object with properties `a`, `b`, and `c` where each property's value is the corresponding variable.

### Mixed Composition

#### Parallel Inside Sequential

```prose
do:
  session "Setup"
  parallel:
    session "Task A"
    session "Task B"
  session "Cleanup"
```

The setup runs first, then Task A and Task B run in parallel, and finally cleanup runs.

#### Sequential Inside Parallel

```prose
parallel:
  do:
    session "Multi-step task 1a"
    session "Multi-step task 1b"
  do:
    session "Multi-step task 2a"
    session "Multi-step task 2b"
```

Each parallel branch contains a sequential workflow. The two workflows run concurrently.

### Assigning Parallel Blocks to Variables

```prose
let results = parallel:
  session "Task A"
  session "Task B"
```

### Complete Example

```prose
agent reviewer:
  model: sonnet

# Run parallel reviews
parallel:
  sec = session: reviewer
    prompt: "Review for security issues"
  perf = session: reviewer
    prompt: "Review for performance issues"
  style = session: reviewer
    prompt: "Review for style issues"

# Combine all reviews
session "Create unified review report"
  context: { sec, perf, style }
```

### Join Strategies

By default, parallel blocks wait for all branches to complete. You can specify alternative join strategies:

#### First (Race)

Return as soon as the first branch completes, cancel others:

```prose
parallel ("first"):
  session "Try approach A"
  session "Try approach B"
  session "Try approach C"
```

The first successful result wins. Other branches are cancelled.

#### Any (N of M)

Return when any N branches complete successfully:

```prose
# Default: any 1 success
parallel ("any"):
  session "Attempt 1"
  session "Attempt 2"

# Specific count: wait for 2 successes
parallel ("any", count: 2):
  session "Attempt 1"
  session "Attempt 2"
  session "Attempt 3"
```

#### All (Default)

Wait for all branches to complete:

```prose
# Implicit - this is the default
parallel:
  session "Task A"
  session "Task B"

# Explicit
parallel ("all"):
  session "Task A"
  session "Task B"
```

### Failure Policies

Control how the parallel block handles branch failures:

#### Fail-Fast (Default)

If any branch fails, fail immediately and cancel other branches:

```prose
parallel:  # Implicit fail-fast
  session "Critical task 1"
  session "Critical task 2"

# Explicit
parallel (on-fail: "fail-fast"):
  session "Critical task 1"
  session "Critical task 2"
```

#### Continue

Let all branches complete, then report all failures:

```prose
parallel (on-fail: "continue"):
  session "Task 1"
  session "Task 2"
  session "Task 3"

# Continue regardless of which branches failed
session "Process results, including failures"
```

#### Ignore

Ignore all failures, always succeed:

```prose
parallel (on-fail: "ignore"):
  session "Optional enrichment 1"
  session "Optional enrichment 2"

# This always runs, even if all branches failed
session "Continue regardless"
```

### Combining Modifiers

Join strategies and failure policies can be combined:

```prose
# Race with resilience
parallel ("first", on-fail: "continue"):
  session "Fast but unreliable"
  session "Slow but reliable"

# Get any 2 results, ignoring failures
parallel ("any", count: 2, on-fail: "ignore"):
  session "Approach 1"
  session "Approach 2"
  session "Approach 3"
  session "Approach 4"
```

### Execution Semantics

When the OpenProse VM encounters a `parallel:` block:

1. **Fork**: Start all branches concurrently
2. **Execute**: Each branch runs independently
3. **Join**: Wait according to join strategy:
   - `"all"` (default): Wait for all branches
   - `"first"`: Return on first completion
   - `"any"`: Return on first success (or N successes with `count`)
4. **Handle failures**: According to on-fail policy:
   - `"fail-fast"` (default): Cancel remaining and fail immediately
   - `"continue"`: Wait for all, then report failures
   - `"ignore"`: Treat failures as successes
5. **Continue**: Proceed to the next statement with available results

### Validation Rules

| Check                                | Severity | Message                                      |
| ------------------------------------ | -------- | -------------------------------------------- |
| Invalid join strategy                | Error    | Must be "all", "first", or "any"             |
| Invalid on-fail policy               | Error    | Must be "fail-fast", "continue", or "ignore" |
| Count without "any"                  | Error    | Count is only valid with "any" strategy      |
| Count less than 1                    | Error    | Count must be at least 1                     |
| Count exceeds branches               | Warning  | Count exceeds number of parallel branches    |
| Duplicate variable in parallel       | Error    | Variable already defined                     |
| Variable conflicts with agent        | Error    | Variable name conflicts with agent name      |
| Undefined variable in object context | Error    | Undefined variable in context                |

---

## Fixed Loops

Fixed loops provide bounded iteration over a set number of times or over a collection.

### Repeat Block

The `repeat` block executes its body a fixed number of times.

#### Basic Syntax

```prose
repeat 3:
  session "Generate a creative idea"
```

#### With Index Variable

Access the current iteration index using `as`:

```prose
repeat 5 as i:
  session "Process item"
    context: i
```

The index variable `i` is scoped to the loop body and starts at 0.

### For-Each Block

The `for` block iterates over a collection.

#### Basic Syntax

```prose
let fruits = ["apple", "banana", "cherry"]
for fruit in fruits:
  session "Describe this fruit"
    context: fruit
```

#### With Inline Array

```prose
for topic in ["AI", "climate", "space"]:
  session "Research this topic"
    context: topic
```

#### With Index Variable

Access both the item and its index:

```prose
let items = ["a", "b", "c"]
for item, i in items:
  session "Process item with index"
    context: [item, i]
```

### Parallel For-Each

The `parallel for` block runs all iterations concurrently (fan-out pattern):

```prose
let topics = ["AI", "climate", "space"]
parallel for topic in topics:
  session "Research this topic"
    context: topic

session "Combine all research"
```

This is equivalent to:

```prose
parallel:
  session "Research AI" context: "AI"
  session "Research climate" context: "climate"
  session "Research space" context: "space"
```

But more concise and dynamic.

### Variable Scoping

Loop variables are scoped to the loop body:

- They are implicitly `const` within each iteration
- They shadow outer variables of the same name (with a warning)
- They are not accessible outside the loop

```prose
let item = session "outer"
for item in ["a", "b"]:
  # 'item' here is the loop variable
  session "process loop item"
    context: item
# 'item' here refers to the outer variable again
session "use outer item"
  context: item
```

### Nesting

Loops can be nested:

```prose
repeat 2:
  repeat 3:
    session "Inner task"
```

Different loop types can be combined:

```prose
let items = ["a", "b"]
repeat 2:
  for item in items:
    session "Process item"
      context: item
```

### Complete Example

```prose
# Generate multiple variations of ideas
repeat 3:
  session "Generate a creative startup idea"

session "Select the best idea from the options above"

# Research the selected idea from multiple angles
let angles = ["market", "technology", "competition"]
parallel for angle in angles:
  session "Research this angle of the startup idea"
    context: angle

session "Synthesize all research into a business plan"
```

### Validation Rules

| Check                         | Severity | Message                              |
| ----------------------------- | -------- | ------------------------------------ |
| Repeat count must be positive | Error    | Repeat count must be positive        |
| Repeat count must be integer  | Error    | Repeat count must be an integer      |
| Undefined collection variable | Error    | Undefined collection variable        |
| Loop variable shadows outer   | Warning  | Loop variable shadows outer variable |

---

## Unbounded Loops

Unbounded loops provide iteration with AI-evaluated termination conditions. Unlike fixed loops, the iteration count is not known ahead of time - the OpenProse VM evaluates conditions at runtime using its intelligence to determine when to stop.

### Discretion Markers

Unbounded loops use **discretion markers** (`**...**`) to wrap AI-evaluated conditions. These markers signal that the enclosed text should be interpreted intelligently by the OpenProse VM at runtime, not as a literal boolean expression.

```prose
# The text inside **...** is evaluated by the AI
loop until **the poem has vivid imagery and flows smoothly**:
  session "Review and improve the poem"
```

For multi-line conditions, use triple-asterisks:

```prose
loop until ***
  the document is complete
  all sections have been reviewed
  and formatting is consistent
***:
  session "Continue working on the document"
```

### Basic Loop

The simplest unbounded loop runs indefinitely until explicitly limited:

```prose
loop:
  session "Process next item"
```

**Warning**: Loops without termination conditions or max iterations generate a warning. Always include a safety limit:

```prose
loop (max: 50):
  session "Process next item"
```

### Loop Until

The `loop until` variant runs until a condition becomes true:

```prose
loop until **the task is complete**:
  session "Continue working on the task"
```

The OpenProse VM evaluates the discretion condition after each iteration and exits when it determines the condition is satisfied.

### Loop While

The `loop while` variant runs while a condition remains true:

```prose
loop while **there are still items to process**:
  session "Process the next item"
```

Semantically, `loop while **X**` is equivalent to `loop until **not X**`.

### Iteration Variable

Track the current iteration number using `as`:

```prose
loop until **done** as attempt:
  session "Try approach"
    context: attempt
```

The iteration variable:

- Starts at 0
- Increments by 1 each iteration
- Is scoped to the loop body
- Is implicitly `const` within each iteration

### Safety Limits

Specify maximum iterations with `(max: N)`:

```prose
# Stop after 10 iterations even if condition not met
loop until **all bugs fixed** (max: 10):
  session "Find and fix a bug"
```

The loop exits when:

1. The condition is satisfied (for `until`/`while` variants), OR
2. The maximum iteration count is reached

### Complete Syntax

All options can be combined:

```prose
loop until **condition** (max: N) as i:
  body...
```

Order matters: condition comes before modifiers, modifiers before `as`.

### Examples

#### Iterative Improvement

```prose
session "Write an initial draft"

loop until **the draft is polished and ready for review** (max: 5):
  session "Review the current draft and identify issues"
  session "Revise the draft to address the issues"

session "Present the final draft"
```

#### Debugging Workflow

```prose
session "Run tests to identify failures"

loop until **all tests pass** (max: 20) as attempt:
  session "Identify the failing test"
  session "Fix the bug causing the failure"
  session "Run tests again"

session "Confirm all tests pass and summarize fixes"
```

#### Consensus Building

```prose
parallel:
  opinion1 = session "Get first expert opinion"
  opinion2 = session "Get second expert opinion"

loop until **experts have reached consensus** (max: 5):
  session "Identify points of disagreement"
    context: { opinion1, opinion2 }
  session "Facilitate discussion to resolve differences"

session "Document the final consensus"
```

#### Quality Threshold

```prose
let draft = session "Create initial document"

loop while **quality score is below threshold** (max: 10):
  draft = session "Review and improve the document"
    context: draft
  session "Calculate new quality score"

session "Finalize the document"
  context: draft
```

### Execution Semantics

When the OpenProse VM encounters an unbounded loop:

1. **Initialize**: Set iteration counter to 0
2. **Check Condition** (for `until`/`while`):
   - For `until`: Exit if condition is satisfied
   - For `while`: Exit if condition is NOT satisfied
3. **Check Limit**: Exit if iteration count >= max iterations
4. **Execute Body**: Run all statements in the loop body
5. **Increment**: Increase iteration counter
6. **Repeat**: Go to step 2

For basic `loop:` without conditions:

- Only the max iteration limit can cause exit
- Without max, the loop runs indefinitely (warning issued)

### Condition Evaluation

The OpenProse VM uses its intelligence to evaluate discretion conditions:

1. **Context Awareness**: The condition is evaluated in the context of what has happened so far in the session
2. **Semantic Understanding**: The condition text is interpreted semantically, not literally
3. **Uncertainty Handling**: When uncertain, the OpenProse VM may:
   - Continue iterating if progress is being made
   - Exit early if diminishing returns are detected
   - Use heuristics based on the condition's semantics

### Nesting

Unbounded loops can be nested with other loop types:

```prose
# Unbounded inside fixed
repeat 3:
  loop until **sub-task complete** (max: 10):
    session "Work on sub-task"

# Fixed inside unbounded
loop until **all batches processed** (max: 5):
  repeat 3:
    session "Process batch item"

# Multiple unbounded
loop until **outer condition** (max: 5):
  loop until **inner condition** (max: 10):
    session "Deep iteration"
```

### Variable Scoping

Loop variables follow the same scoping rules as fixed loops:

```prose
let i = session "outer"
loop until **done** as i:
  # 'i' here is the loop variable (shadows outer)
  session "use loop i"
    context: i
# 'i' here refers to the outer variable again
session "use outer i"
  context: i
```

### Validation Rules

| Check                         | Severity | Message                               |
| ----------------------------- | -------- | ------------------------------------- |
| Loop without max or condition | Warning  | Unbounded loop without max iterations |
| Max iterations <= 0           | Error    | Max iterations must be positive       |
| Max iterations not integer    | Error    | Max iterations must be an integer     |
| Empty discretion condition    | Error    | Discretion condition cannot be empty  |
| Very short condition          | Warning  | Discretion condition may be ambiguous |
| Loop variable shadows outer   | Warning  | Loop variable shadows outer variable  |

---

## Pipeline Operations

Pipeline operations provide functional-style collection transformations. They allow you to chain operations like map, filter, and reduce using the pipe operator (`|`).

### Pipe Operator

The pipe operator (`|`) passes a collection to a transformation operation:

```prose
let items = ["a", "b", "c"]
let results = items | map:
  session "Process this item"
    context: item
```

### Map

The `map` operation transforms each element in a collection:

```prose
let articles = ["article1", "article2", "article3"]

let summaries = articles | map:
  session "Summarize this article in one sentence"
    context: item
```

Inside a map body, the implicit variable `item` refers to the current element being processed.

### Filter

The `filter` operation keeps elements that match a condition:

```prose
let items = ["one", "two", "three", "four", "five"]

let short = items | filter:
  session "Does this word have 4 or fewer letters? Answer yes or no."
    context: item
```

The session in a filter body should return something the OpenProse VM can interpret as truthy/falsy (like "yes"/"no").

### Reduce

The `reduce` operation accumulates elements into a single result:

```prose
let ideas = ["AI assistant", "smart home", "health tracker"]

let combined = ideas | reduce(summary, idea):
  session "Add this idea to the summary, creating a cohesive concept"
    context: [summary, idea]
```

The reduce operation requires explicit variable names:

- First variable (`summary`): the accumulator
- Second variable (`idea`): the current item

The first item in the collection becomes the initial accumulator value.

### Parallel Map (pmap)

The `pmap` operation is like `map` but runs all transformations concurrently:

```prose
let tasks = ["task1", "task2", "task3"]

let results = tasks | pmap:
  session "Process this task in parallel"
    context: item

session "Aggregate all results"
  context: results
```

This is similar to `parallel for`, but in pipeline syntax.

### Chaining

Pipeline operations can be chained to compose complex transformations:

```prose
let topics = ["quantum computing", "blockchain", "machine learning", "IoT"]

let result = topics
  | filter:
      session "Is this topic trending? Answer yes or no."
        context: item
  | map:
      session "Write a one-line startup pitch for this topic"
        context: item

session "Present the startup pitches"
  context: result
```

Operations execute left-to-right: first filter, then map.

### Complete Example

```prose
# Define a collection
let articles = ["AI breakthroughs", "Climate solutions", "Space exploration"]

# Process with chained operations
let summaries = articles
  | filter:
      session "Is this topic relevant to technology? Answer yes or no."
        context: item
  | map:
      session "Write a compelling one-paragraph summary"
        context: item
  | reduce(combined, summary):
      session "Merge this summary into the combined document"
        context: [combined, summary]

# Present the final result
session "Format and present the combined summaries"
  context: summaries
```

### Implicit Variables

| Operation | Available Variables                          |
| --------- | -------------------------------------------- |
| `map`     | `item` - current element                     |
| `filter`  | `item` - current element                     |
| `pmap`    | `item` - current element                     |
| `reduce`  | Named explicitly: `reduce(accVar, itemVar):` |

### Execution Semantics

When the OpenProse VM encounters a pipeline:

1. **Input**: Start with the input collection
2. **For each operation**:
   - **map**: Transform each element, producing a new collection
   - **filter**: Keep elements where the session returns truthy
   - **reduce**: Accumulate elements into a single value
   - **pmap**: Transform all elements concurrently
3. **Output**: Return the final transformed collection/value

### Variable Scoping

Pipeline variables are scoped to their operation body:

```prose
let item = "outer"
let items = ["a", "b"]

let results = items | map:
  # 'item' here is the pipeline variable (shadows outer)
  session "process"
    context: item

# 'item' here refers to the outer variable again
session "use outer"
  context: item
```

### Validation Rules

| Check                           | Severity | Message                                            |
| ------------------------------- | -------- | -------------------------------------------------- |
| Undefined input collection      | Error    | Undefined collection variable                      |
| Invalid pipe operator           | Error    | Expected pipe operator (map, filter, reduce, pmap) |
| Reduce without variables        | Error    | Expected accumulator and item variables            |
| Pipeline variable shadows outer | Warning  | Implicit/explicit variable shadows outer variable  |

---

## Error Handling

OpenProse provides structured error handling with try/catch/finally blocks, throw statements, and retry mechanisms for resilient workflows.

### Try/Catch Blocks

The `try:` block wraps operations that might fail. The `catch:` block handles errors.

```prose
try:
  session "Attempt risky operation"
catch:
  session "Handle the error gracefully"
```

#### Error Variable Access

Use `catch as err:` to capture error context for the error handler:

```prose
try:
  session "Call external API"
catch as err:
  session "Log and handle the error"
    context: err
```

The error variable (`err`) contains contextual information about what went wrong and is only accessible within the catch block.

### Try/Catch/Finally

The `finally:` block always executes, whether the try block succeeds or fails:

```prose
try:
  session "Acquire and use resource"
catch:
  session "Handle any errors"
finally:
  session "Always clean up resource"
```

#### Execution Order

1. **Try succeeds**: try body → finally body
2. **Try fails**: try body (until failure) → catch body → finally body

### Try/Finally (No Catch)

For cleanup without error handling, use try/finally:

```prose
try:
  session "Open connection and do work"
finally:
  session "Close connection"
```

### Throw Statement

The `throw` statement raises or re-raises errors.

#### Rethrow

Inside a catch block, `throw` without arguments re-raises the caught error to outer handlers:

```prose
try:
  try:
    session "Inner operation"
  catch:
    session "Partial handling"
    throw  # Re-raise to outer handler
catch:
  session "Handle re-raised error"
```

#### Throw with Message

Throw a new error with a custom message:

```prose
session "Check preconditions"
throw "Precondition not met"
```

### Nested Error Handling

Try blocks can be nested. Inner catch blocks don't trigger outer handlers unless they rethrow:

```prose
try:
  session "Outer operation"
  try:
    session "Inner risky operation"
  catch:
    session "Handle inner error"  # Outer catch won't run
  session "Continue outer operation"
catch:
  session "Handle outer error only"
```

### Error Handling in Parallel

Each parallel branch can have its own error handling:

```prose
parallel:
  try:
    session "Branch A might fail"
  catch:
    session "Recover branch A"
  try:
    session "Branch B might fail"
  catch:
    session "Recover branch B"

session "Continue with recovered results"
```

This differs from the `on-fail:` policy which controls behavior when unhandled errors occur.

### Retry Property

The `retry:` property makes a session automatically retry on failure:

```prose
session "Call flaky API"
  retry: 3
```

#### Retry with Backoff

Add `backoff:` to control delay between retries:

```prose
session "Rate-limited API"
  retry: 5
  backoff: exponential
```

**Backoff Strategies:**

| Strategy      | Behavior                           |
| ------------- | ---------------------------------- |
| `none`        | Immediate retry (default)          |
| `linear`      | Fixed delay between retries        |
| `exponential` | Doubling delay (1s, 2s, 4s, 8s...) |

#### Retry with Context

Retry works with other session properties:

```prose
let data = session "Get input"
session "Process data"
  context: data
  retry: 3
  backoff: linear
```

### Combining Patterns

Retry and try/catch work together for maximum resilience:

```prose
try:
  session "Call external service"
    retry: 3
    backoff: exponential
catch:
  session "All retries failed, use fallback"
```

### Validation Rules

| Check                        | Severity | Message                                             |
| ---------------------------- | -------- | --------------------------------------------------- |
| Try without catch or finally | Error    | Try block must have at least "catch:" or "finally:" |
| Error variable shadows outer | Warning  | Error variable shadows outer variable               |
| Empty throw message          | Warning  | Throw message is empty                              |
| Non-positive retry count     | Error    | Retry count must be positive                        |
| Non-integer retry count      | Error    | Retry count must be an integer                      |
| High retry count (>10)       | Warning  | Retry count is unusually high                       |
| Invalid backoff strategy     | Error    | Must be none, linear, or exponential                |
| Retry on agent definition    | Warning  | Retry property is only valid in session statements  |

### Syntax Reference

```
try_block ::= "try" ":" NEWLINE INDENT statement+ DEDENT
              [catch_block]
              [finally_block]

catch_block ::= "catch" ["as" identifier] ":" NEWLINE INDENT statement+ DEDENT

finally_block ::= "finally" ":" NEWLINE INDENT statement+ DEDENT

throw_statement ::= "throw" [string_literal]

retry_property ::= "retry" ":" number_literal

backoff_property ::= "backoff" ":" ( "none" | "linear" | "exponential" )
```

---

## Choice Blocks

Choice blocks allow the OpenProse VM to select from multiple labeled options based on criteria. This is useful for branching workflows where the best path depends on runtime analysis.

### Syntax

```prose
choice **criteria**:
  option "Label A":
    statements...
  option "Label B":
    statements...
```

### Criteria

The criteria is wrapped in discretion markers (`**...**`) and is evaluated by the OpenProse VM to select which option to execute:

```prose
choice **the best approach for the current situation**:
  option "Quick fix":
    session "Apply a quick temporary fix"
  option "Full refactor":
    session "Perform a complete code refactor"
```

### Multi-line Criteria

For complex criteria, use triple-asterisks:

```prose
choice ***
  which strategy is most appropriate
  given the current project constraints
  and timeline requirements
***:
  option "MVP approach":
    session "Build minimum viable product"
  option "Full feature set":
    session "Build complete feature set"
```

### Examples

#### Simple Choice

```prose
let analysis = session "Analyze the code quality"

choice **the severity of issues found in the analysis**:
  option "Critical":
    session "Stop deployment and fix critical issues"
      context: analysis
  option "Minor":
    session "Log issues for later and proceed"
      context: analysis
  option "None":
    session "Proceed with deployment"
```

#### Choice with Multiple Statements per Option

```prose
choice **the user's experience level**:
  option "Beginner":
    session "Explain basic concepts first"
    session "Provide step-by-step guidance"
    session "Include helpful tips and warnings"
  option "Expert":
    session "Provide concise technical summary"
    session "Include advanced configuration options"
```

#### Nested Choices

```prose
choice **the type of request**:
  option "Bug report":
    choice **the bug severity**:
      option "Critical":
        session "Escalate immediately"
      option "Normal":
        session "Add to sprint backlog"
  option "Feature request":
    session "Add to feature backlog"
```

### Execution Semantics

When the OpenProse VM encounters a `choice` block:

1. **Evaluate Criteria**: Interpret the discretion criteria in current context
2. **Select Option**: Choose the most appropriate labeled option
3. **Execute**: Run all statements in the selected option's body
4. **Continue**: Proceed to the next statement after the choice block

Only one option is executed per choice block.

### Validation Rules

| Check                   | Severity | Message                                    |
| ----------------------- | -------- | ------------------------------------------ |
| Choice without options  | Error    | Choice block must have at least one option |
| Empty criteria          | Error    | Choice criteria cannot be empty            |
| Duplicate option labels | Warning  | Duplicate option label                     |
| Empty option body       | Warning  | Option has empty body                      |

### Syntax Reference

```
choice_block ::= "choice" discretion ":" NEWLINE INDENT option+ DEDENT

option ::= "option" string ":" NEWLINE INDENT statement+ DEDENT

discretion ::= "**" text "**" | "***" text "***"
```

---

## Conditional Statements

If/elif/else statements provide conditional branching based on AI-evaluated conditions using discretion markers.

### If Statement

```prose
if **condition**:
  statements...
```

### If/Else

```prose
if **condition**:
  statements...
else:
  statements...
```

### If/Elif/Else

```prose
if **first condition**:
  statements...
elif **second condition**:
  statements...
elif **third condition**:
  statements...
else:
  statements...
```

### Discretion Conditions

Conditions are wrapped in discretion markers (`**...**`) for AI evaluation:

```prose
let analysis = session "Analyze the codebase"

if **the code has security vulnerabilities**:
  session "Fix security issues immediately"
    context: analysis
elif **the code has performance issues**:
  session "Optimize performance bottlenecks"
    context: analysis
else:
  session "Proceed with normal review"
    context: analysis
```

### Multi-line Conditions

Use triple-asterisks for complex conditions:

```prose
if ***
  the test suite passes
  and the code coverage is above 80%
  and there are no linting errors
***:
  session "Deploy to production"
else:
  session "Fix issues before deploying"
```

### Examples

#### Simple If

```prose
session "Check system health"

if **the system is healthy**:
  session "Continue with normal operations"
```

#### If/Else

```prose
let review = session "Review the pull request"

if **the code changes are safe and well-tested**:
  session "Approve and merge the PR"
    context: review
else:
  session "Request changes"
    context: review
```

#### Multiple Elif

```prose
let status = session "Check project status"

if **the project is on track**:
  session "Continue as planned"
elif **the project is slightly delayed**:
  session "Adjust timeline and communicate"
elif **the project is significantly delayed**:
  session "Escalate to management"
  session "Create recovery plan"
else:
  session "Assess project viability"
```

#### Nested Conditionals

```prose
if **the request is authenticated**:
  if **the user has admin privileges**:
    session "Process admin request"
  else:
    session "Process standard user request"
else:
  session "Return authentication error"
```

### Combining with Other Constructs

#### With Try/Catch

```prose
try:
  session "Attempt operation"
  if **operation succeeded partially**:
    session "Complete remaining steps"
catch as err:
  if **error is recoverable**:
    session "Apply recovery procedure"
      context: err
  else:
    throw "Unrecoverable error"
```

#### With Loops

```prose
loop until **task complete** (max: 10):
  session "Work on task"
  if **encountered blocker**:
    session "Resolve blocker"
```

### Execution Semantics

When the OpenProse VM encounters an `if` statement:

1. **Evaluate Condition**: Interpret the first discretion condition
2. **If True**: Execute the then-body and skip remaining clauses
3. **If False**: Check each `elif` condition in order
4. **Elif Match**: Execute that elif's body and skip remaining
5. **No Match**: Execute the `else` body (if present)
6. **Continue**: Proceed to the next statement

### Validation Rules

| Check           | Severity | Message                           |
| --------------- | -------- | --------------------------------- |
| Empty condition | Error    | If/elif condition cannot be empty |
| Elif without if | Error    | Elif must follow if               |
| Else without if | Error    | Else must follow if or elif       |
| Multiple else   | Error    | Only one else clause allowed      |
| Empty body      | Warning  | Condition has empty body          |

### Syntax Reference

```
if_statement ::= "if" discretion ":" NEWLINE INDENT statement+ DEDENT
                 elif_clause*
                 [else_clause]

elif_clause ::= "elif" discretion ":" NEWLINE INDENT statement+ DEDENT

else_clause ::= "else" ":" NEWLINE INDENT statement+ DEDENT

discretion ::= "**" text "**" | "***" text "***"
```

---

## Execution Model

OpenProse uses a two-phase execution model.

### Phase 1: Compilation (Static)

The compile phase handles deterministic preprocessing:

1. **Parse**: Convert source code to AST
2. **Validate**: Check for syntax and semantic errors
3. **Expand**: Normalize syntax sugar (when implemented)
4. **Output**: Generate canonical program

### Phase 2: Runtime (Intelligent)

The OpenProse VM executes the compiled program:

1. **Load**: Receive the compiled program
2. **Collect Agents**: Register all agent definitions
3. **Execute**: Process each statement in order
4. **Spawn**: Create subagents with resolved configurations
5. **Coordinate**: Manage context passing between sessions

### OpenProse VM Behavior

| Aspect               | Behavior                                        |
| -------------------- | ----------------------------------------------- |
| Execution order      | Strict - follows program exactly                |
| Session creation     | Strict - creates what program specifies         |
| Agent resolution     | Strict - merge properties deterministically     |
| Context passing      | Intelligent - summarizes/transforms as needed   |
| Completion detection | Intelligent - determines when session is "done" |

### State Management

For the current implementation, state is tracked in-context (conversation history):

| State Type          | Tracking Approach                                   |
| ------------------- | --------------------------------------------------- |
| Agent definitions   | Collected at program start                          |
| Execution flow      | Implicit reasoning ("completed X, now executing Y") |
| Session outputs     | Held in conversation history                        |
| Position in program | Tracked by OpenProse VM                             |

---

## Validation Rules

The validator checks programs for errors and warnings before execution.

### Errors (Block Execution)

| Code | Description                              |
| ---- | ---------------------------------------- |
| E001 | Unterminated string literal              |
| E002 | Unknown escape sequence in string        |
| E003 | Session missing prompt or agent          |
| E004 | Unexpected token                         |
| E005 | Invalid syntax                           |
| E006 | Duplicate agent definition               |
| E007 | Undefined agent reference                |
| E008 | Invalid model value                      |
| E009 | Duplicate property                       |
| E010 | Duplicate use statement                  |
| E011 | Empty use path                           |
| E012 | Invalid use path format                  |
| E013 | Skills must be an array                  |
| E014 | Skill name must be a string              |
| E015 | Permissions must be a block              |
| E016 | Permission pattern must be a string      |
| E017 | `resume:` requires persistent agent      |
| E018 | `resume:` with no existing memory        |
| E019 | Duplicate variable name (flat namespace) |
| E020 | Empty input name                         |
| E021 | Duplicate input declaration              |
| E022 | Input after executable statement         |
| E023 | Empty output name                        |
| E024 | Duplicate output declaration             |
| E025 | Unknown program in invocation            |
| E026 | Missing required input                   |
| E027 | Unknown input name in invocation         |
| E028 | Unknown output property access           |

### Warnings (Non-blocking)

| Code | Description                                         |
| ---- | --------------------------------------------------- |
| W001 | Empty session prompt                                |
| W002 | Whitespace-only session prompt                      |
| W003 | Session prompt exceeds 10,000 characters            |
| W004 | Empty prompt property                               |
| W005 | Unknown property name                               |
| W006 | Unknown import source format                        |
| W007 | Skill not imported                                  |
| W008 | Unknown permission type                             |
| W009 | Unknown permission value                            |
| W010 | Empty skills array                                  |
| W011 | `session:` on persistent agent with existing memory |

### Error Message Format

Errors include location information:

```
Error at line 5, column 12: Unterminated string literal
  session "Hello
          ^
```

---

## Examples

### Minimal Program

```prose
session "Hello world"
```

### Research Pipeline with Agents

```prose
# Define specialized agents
agent researcher:
  model: sonnet
  prompt: "You are a research assistant"

agent writer:
  model: opus
  prompt: "You are a technical writer"

# Execute workflow
session: researcher
  prompt: "Research recent developments in quantum computing"

session: writer
  prompt: "Write a summary of the research findings"
```

### Code Review Workflow

```prose
agent reviewer:
  model: sonnet
  prompt: "You are an expert code reviewer"

session: reviewer
  prompt: "Read the code in src/ and identify potential bugs"

session: reviewer
  prompt: "Suggest fixes for each bug found"

session: reviewer
  prompt: "Create a summary of all changes needed"
```

### Multi-step Task with Model Override

```prose
agent analyst:
  model: haiku
  prompt: "You analyze data quickly"

# Quick initial analysis
session: analyst
  prompt: "Scan the data for obvious patterns"

# Detailed analysis with more powerful model
session: analyst
  model: opus
  prompt: "Perform deep analysis on the patterns found"
```

### Comments for Documentation

```prose
# Project: Quarterly Report Generator
# Author: Team Lead
# Date: 2024-01-01

agent data-collector:
  model: sonnet
  prompt: "You gather and organize data"

agent analyst:
  model: opus
  prompt: "You analyze data and create insights"

# Step 1: Gather data
session: data-collector
  prompt: "Collect all sales data from the past quarter"

# Step 2: Analysis
session: analyst
  prompt: "Perform trend analysis on the collected data"

# Step 3: Report generation
session: analyst
  prompt: "Generate a formatted quarterly report with charts"
```

### Workflow with Skills and Permissions

```prose
# Import external programs
use "@anthropic/web-search"
use "@anthropic/file-writer" as file-writer

# Define a secure research agent
agent researcher:
  model: sonnet
  prompt: "You are a research assistant"
  skills: ["web-search"]
  permissions:
    read: ["*.md", "*.txt"]
    bash: deny

# Define a writer agent
agent writer:
  model: opus
  prompt: "You create documentation"
  skills: ["file-writer"]
  permissions:
    write: ["docs/"]
    bash: deny

# Execute workflow
session: researcher
  prompt: "Research AI safety topics"

session: writer
  prompt: "Write a summary document"
```

---

## Future Features

All core features through Tier 12 have been implemented. Potential future enhancements:

### Tier 13: Extended Features

- Custom functions with return values
- Module system for code organization
- Type annotations for validation
- Async/await patterns for advanced concurrency

### Tier 14: Tooling

- Language server protocol (LSP) support
- VS Code extension
- Interactive debugger
- Performance profiling

---

## Syntax Grammar (Implemented)

```
program     → statement* EOF
statement   → useStatement | inputDecl | agentDef | session | resumeStmt
            | letBinding | constBinding | assignment | outputBinding
            | parallelBlock | repeatBlock | forEachBlock | loopBlock
            | tryBlock | choiceBlock | ifStatement | doBlock | blockDef
            | throwStatement | comment

# Program Composition
useStatement → "use" string ( "as" IDENTIFIER )?
inputDecl   → "input" IDENTIFIER ":" string
outputBinding → "output" IDENTIFIER "=" expression
programCall → IDENTIFIER "(" ( IDENTIFIER ":" expression )* ")"

# Definitions
agentDef    → "agent" IDENTIFIER ":" NEWLINE INDENT agentProperty* DEDENT
agentProperty → "model:" ( "sonnet" | "opus" | "haiku" )
              | "prompt:" string
              | "persist:" ( "true" | "project" | string )
              | "context:" ( IDENTIFIER | array | objectContext )
              | "retry:" NUMBER
              | "backoff:" ( "none" | "linear" | "exponential" )
              | "skills:" "[" string* "]"
              | "permissions:" NEWLINE INDENT permission* DEDENT
blockDef    → "block" IDENTIFIER params? ":" NEWLINE INDENT statement* DEDENT
params      → "(" IDENTIFIER ( "," IDENTIFIER )* ")"

# Control Flow
parallelBlock → "parallel" parallelMods? ":" NEWLINE INDENT parallelBranch* DEDENT
parallelMods  → "(" ( joinStrategy | onFail | countMod ) ( "," ( joinStrategy | onFail | countMod ) )* ")"
joinStrategy  → string                              # "all" | "first" | "any"
onFail        → "on-fail" ":" string                # "fail-fast" | "continue" | "ignore"
countMod      → "count" ":" NUMBER                  # only valid with "any"
parallelBranch → ( IDENTIFIER "=" )? statement

# Loops
repeatBlock → "repeat" NUMBER ( "as" IDENTIFIER )? ":" NEWLINE INDENT statement* DEDENT
forEachBlock → "parallel"? "for" IDENTIFIER ( "," IDENTIFIER )? "in" collection ":" NEWLINE INDENT statement* DEDENT
loopBlock   → "loop" ( ( "until" | "while" ) discretion )? loopMods? ( "as" IDENTIFIER )? ":" NEWLINE INDENT statement* DEDENT
loopMods    → "(" "max" ":" NUMBER ")"

# Error Handling
tryBlock    → "try" ":" NEWLINE INDENT statement+ DEDENT catchBlock? finallyBlock?
catchBlock  → "catch" ( "as" IDENTIFIER )? ":" NEWLINE INDENT statement+ DEDENT
finallyBlock → "finally" ":" NEWLINE INDENT statement+ DEDENT
throwStatement → "throw" string?

# Conditionals
choiceBlock → "choice" discretion ":" NEWLINE INDENT choiceOption+ DEDENT
choiceOption → "option" string ":" NEWLINE INDENT statement+ DEDENT
ifStatement → "if" discretion ":" NEWLINE INDENT statement+ DEDENT elifClause* elseClause?
elifClause  → "elif" discretion ":" NEWLINE INDENT statement+ DEDENT
elseClause  → "else" ":" NEWLINE INDENT statement+ DEDENT

# Composition
doBlock     → "do" ( ":" NEWLINE INDENT statement* DEDENT | IDENTIFIER args? )
args        → "(" expression ( "," expression )* ")"
arrowExpr   → session ( "->" session )+

# Sessions
session     → "session" ( string | ":" IDENTIFIER | IDENTIFIER ":" IDENTIFIER )
              ( NEWLINE INDENT sessionProperty* DEDENT )?
resumeStmt  → "resume" ":" IDENTIFIER ( NEWLINE INDENT sessionProperty* DEDENT )?
sessionProperty → "model:" ( "sonnet" | "opus" | "haiku" )
                | "prompt:" string
                | "context:" ( IDENTIFIER | array | objectContext )
                | "retry:" NUMBER
                | "backoff:" ( "none" | "linear" | "exponential" )

# Bindings
letBinding  → "let" IDENTIFIER "=" expression
constBinding → "const" IDENTIFIER "=" expression
assignment  → IDENTIFIER "=" expression

# Expressions
expression  → session | doBlock | parallelBlock | repeatBlock | forEachBlock
            | loopBlock | arrowExpr | pipeExpr | programCall | string | IDENTIFIER | array | objectContext

# Pipelines
pipeExpr    → ( IDENTIFIER | array ) ( "|" pipeOp )+
pipeOp      → ( "map" | "filter" | "pmap" ) ":" NEWLINE INDENT statement* DEDENT
            | "reduce" "(" IDENTIFIER "," IDENTIFIER ")" ":" NEWLINE INDENT statement* DEDENT

# Properties
property    → ( "model" | "prompt" | "context" | "retry" | "backoff" | IDENTIFIER )
            ":" ( IDENTIFIER | string | array | objectContext | NUMBER )

# Primitives
discretion  → "**" text "**" | "***" text "***"
collection  → IDENTIFIER | array
array       → "[" ( expression ( "," expression )* )? "]"
objectContext → "{" ( IDENTIFIER ( "," IDENTIFIER )* )? "}"
comment     → "#" text NEWLINE

# Strings
string      → singleString | tripleString | interpolatedString
singleString → '"' character* '"'
tripleString → '"""' ( character | NEWLINE )* '"""'
interpolatedString → string containing "{" IDENTIFIER "}"
character   → escape | non-quote
escape      → "\\" | "\"" | "\n" | "\t"
```

---

## Compiler API

When a user invokes `/prose-compile` or asks you to compile a `.prose` file:

1. **Read this document** (`compiler.md`) fully to understand all syntax and validation rules
2. **Parse** the program according to the syntax grammar
3. **Validate** syntax correctness, semantic validity, and self-evidence
4. **Transform** to canonical form (expand syntax sugar, normalize structure)
5. **Output** the compiled program or report errors/warnings with line numbers

For direct interpretation without compilation, read `prose.md` and execute statements as described in the Session Statement section.
