---
role: in-context-state-management
summary: |
  In-context state management using the narration protocol with text markers.
  This approach tracks execution state within the conversation history itself.
  The OpenProse VM "thinks aloud" to persist state—what you say becomes what you remember.
see-also:
  - ../prose.md: VM execution semantics
  - filesystem.md: File-system state management (alternative approach)
  - sqlite.md: SQLite state management (experimental)
  - postgres.md: PostgreSQL state management (experimental)
  - ../primitives/session.md: Session context and compaction guidelines
---

# In-Context State Management

This document describes how the OpenProse VM tracks execution state using **structured narration** in the conversation history. This is one of two state management approaches (the other being file-based state in `filesystem.md`).

## Overview

In-context state uses text-prefixed markers to persist state within the conversation. The VM "thinks aloud" about execution—what you say becomes what you remember.

**Key principle:** Your conversation history IS the VM's working memory.

---

## When to Use In-Context State

In-context state is appropriate for:

| Factor            | In-Context      | Use File-Based Instead |
| ----------------- | --------------- | ---------------------- |
| Statement count   | < 30 statements | >= 30 statements       |
| Parallel branches | < 5 concurrent  | >= 5 concurrent        |
| Imported programs | 0-2 imports     | >= 3 imports           |
| Nested depth      | <= 2 levels     | > 2 levels             |
| Expected duration | < 5 minutes     | >= 5 minutes           |

Announce your state mode at program start:

```
OpenProse Program Start
   State mode: in-context (program is small, fits in context)
```

---

## The Narration Protocol

Use text-prefixed markers for each state change:

| Marker     | Category       | Usage                                   |
| ---------- | -------------- | --------------------------------------- |
| [Program]  | Program        | Start, end, definition collection       |
| [Position] | Position       | Current statement being executed        |
| [Binding]  | Binding        | Variable assignment or update           |
| [Input]    | Input          | Receiving inputs from caller            |
| [Output]   | Output         | Producing outputs for caller            |
| [Import]   | Import         | Fetching and invoking imported programs |
| [Success]  | Success        | Session or block completion             |
| [Warning]  | Error          | Failures and exceptions                 |
| [Parallel] | Parallel       | Entering, branch status, joining        |
| [Loop]     | Loop           | Iteration, condition evaluation         |
| [Pipeline] | Pipeline       | Stage progress                          |
| [Try]      | Error handling | Try/catch/finally                       |
| [Flow]     | Flow           | Condition evaluation results            |
| [Frame+]   | Call Stack     | Push new frame (block invocation)       |
| [Frame-]   | Call Stack     | Pop frame (block completion)            |

---

## Narration Patterns by Construct

### Session Statements

```
[Position] Executing: session "Research the topic"
   [Task tool call]
[Success] Session complete: "Research found that..."
[Binding] let research = <result>
```

### Parallel Blocks

```
[Parallel] Entering parallel block (3 branches, strategy: all)
   - security: pending
   - perf: pending
   - style: pending
   [Multiple Task calls]
[Parallel] Parallel complete:
   - security = "No vulnerabilities found..."
   - perf = "Performance is acceptable..."
   - style = "Code follows conventions..."
[Binding] security, perf, style bound
```

### Loop Blocks

```
[Loop] Starting loop until **task complete** (max: 5)

[Loop] Iteration 1 of max 5
   [Position] session "Work on task"
   [Success] Session complete
   [Loop] Evaluating: **task complete**
   [Flow] Not satisfied, continuing

[Loop] Iteration 2 of max 5
   [Position] session "Work on task"
   [Success] Session complete
   [Loop] Evaluating: **task complete**
   [Flow] Satisfied!

[Loop] Loop exited: condition satisfied at iteration 2
```

### Error Handling

```
[Try] Entering try block
[Position] session "Risky operation"
[Warning] Session failed: connection timeout
[Binding] err = {message: "connection timeout"}
[Try] Executing catch block
[Position] session "Handle error" with context: err
[Success] Recovery complete
[Try] Executing finally block
[Position] session "Cleanup"
[Success] Cleanup complete
```

### Variable Bindings

```
[Binding] let research = "AI safety research covers..." (mutable)
[Binding] const config = {model: "opus"} (immutable)
[Binding] research = "Updated research..." (reassignment, was: "AI safety...")
```

### Input/Output Bindings

```
[Input] Inputs received:
   topic = "quantum computing" (from caller)
   depth = "deep" (from caller)

[Output] output findings = "Research shows..." (will return to caller)
[Output] output sources = ["arxiv:2401.1234", ...] (will return to caller)
```

### Block Invocation and Call Stack

Track block invocations with frame markers:

```
[Position] do process(data, 5)
[Frame+] Entering block: process (execution_id: 1, depth: 1)
   Arguments: chunk=data, depth=5

   [Position] session "Split into parts"
      [Task tool call]
   [Success] Session complete
   [Binding] let parts = <result> (execution_id: 1)

   [Position] do process(parts[0], 4)
   [Frame+] Entering block: process (execution_id: 2, depth: 2)
      Arguments: chunk=parts[0], depth=4
      Parent: execution_id 1

      [Position] session "Split into parts"
         [Task tool call]
      [Success] Session complete
      [Binding] let parts = <result> (execution_id: 2)  # Shadows parent's 'parts'

      ... (continues recursively)

   [Frame-] Exiting block: process (execution_id: 2)

   [Position] session "Combine results"
      [Task tool call]
   [Success] Session complete

[Frame-] Exiting block: process (execution_id: 1)
```

**Key points:**

- Each `[Frame+]` must have a matching `[Frame-]`
- `execution_id` uniquely identifies each invocation
- `depth` shows call stack depth (1 = first level)
- Bindings include `(execution_id: N)` to indicate scope
- Nested frames show `Parent: execution_id N` for the scope chain

### Scoped Binding Narration

When inside a block invocation, always include the execution_id:

```
[Binding] let result = "computed value" (execution_id: 43)
```

For variable resolution across scopes:

```
[Binding] Resolving 'config': found in execution_id 41 (parent scope)
```

### Program Imports

```
[Import] Importing: @alice/research
   Fetching from: https://p.prose.md/@alice/research
   Inputs expected: [topic, depth]
   Outputs provided: [findings, sources]
   Registered as: research

[Import] Invoking: research(topic: "quantum computing")
   [Input] Passing inputs:
      topic = "quantum computing"

   [... imported program execution ...]

   [Output] Received outputs:
      findings = "Quantum computing uses..."
      sources = ["arxiv:2401.1234"]

[Import] Import complete: research
[Binding] result = { findings: "...", sources: [...] }
```

---

## Context Serialization

**In-context state passes values, not references.** This is the key difference from file-based and PostgreSQL state. The VM holds binding values directly in conversation history.

When passing context to sessions, format appropriately:

| Context Size    | Strategy                |
| --------------- | ----------------------- |
| < 2000 chars    | Pass verbatim           |
| 2000-8000 chars | Summarize to key points |
| > 8000 chars    | Extract essentials only |

**Format:**

```
Context provided:
---
research: "Key findings about AI safety..."
analysis: "Risk assessment shows..."
---
```

**Limitation:** In-context state cannot support RLM-style "environment as variable" patterns where agents query arbitrarily large bindings. For programs with large intermediate values, use file-based or PostgreSQL state instead.

---

## Complete Execution Trace Example

```prose
agent researcher:
  model: sonnet

let research = session: researcher
  prompt: "Research AI safety"

parallel:
  a = session "Analyze risk A"
  b = session "Analyze risk B"

loop until **analysis complete** (max: 3):
  session "Synthesize"
    context: { a, b, research }
```

**Narration:**

```
[Program] Program Start
   Collecting definitions...
   - Agent: researcher (model: sonnet)

[Position] Statement 1: let research = session: researcher
   Spawning with prompt: "Research AI safety"
   Model: sonnet
   [Task tool call]
[Success] Session complete: "AI safety research covers alignment..."
[Binding] let research = <result>

[Position] Statement 2: parallel block
[Parallel] Entering parallel (2 branches, strategy: all)
   [Task: "Analyze risk A"] [Task: "Analyze risk B"]
[Parallel] Parallel complete:
   - a = "Risk A: potential misalignment..."
   - b = "Risk B: robustness concerns..."
[Binding] a, b bound

[Position] Statement 3: loop until **analysis complete** (max: 3)
[Loop] Starting loop

[Loop] Iteration 1 of max 3
   [Position] session "Synthesize" with context: {a, b, research}
   [Task with serialized context]
   [Success] Result: "Initial synthesis shows..."
   [Loop] Evaluating: **analysis complete**
   [Flow] Not satisfied (synthesis is preliminary)

[Loop] Iteration 2 of max 3
   [Position] session "Synthesize" with context: {a, b, research}
   [Task with serialized context]
   [Success] Result: "Comprehensive analysis complete..."
   [Loop] Evaluating: **analysis complete**
   [Flow] Satisfied!

[Loop] Loop exited: condition satisfied at iteration 2

[Program] Program Complete
```

---

## State Categories

The VM must track these state categories in narration:

| Category                | What to Track                             | Example                                      |
| ----------------------- | ----------------------------------------- | -------------------------------------------- |
| **Import Registry**     | Imported programs and aliases             | `research: @alice/research`                  |
| **Agent Registry**      | All agent definitions                     | `researcher: {model: sonnet, prompt: "..."}` |
| **Block Registry**      | All block definitions (hoisted)           | `review: {params: [topic], body: [...]}`     |
| **Input Bindings**      | Inputs received from caller               | `topic = "quantum computing"`                |
| **Output Bindings**     | Outputs to return to caller               | `findings = "Research shows..."`             |
| **Variable Bindings**   | Name -> value mapping (with execution_id) | `result = "..." (execution_id: 3)`           |
| **Variable Mutability** | Which are `let` vs `const` vs `output`    | `research: let, findings: output`            |
| **Execution Position**  | Current statement index                   | Statement 3 of 7                             |
| **Loop State**          | Counter, max, condition                   | Iteration 2 of max 5                         |
| **Parallel State**      | Branches, results, strategy               | `{a: complete, b: pending}`                  |
| **Error State**         | Exception, retry count                    | Retry 2 of 3, error: "timeout"               |
| **Call Stack**          | Stack of execution frames                 | See below                                    |

### Call Stack State

For block invocations, track the full call stack:

```
[CallStack] Current stack (depth: 3):
   execution_id: 5 | block: process | depth: 3 | status: executing
   execution_id: 3 | block: process | depth: 2 | status: waiting
   execution_id: 1 | block: process | depth: 1 | status: waiting
```

Each frame tracks:

- `execution_id`: Unique ID for this invocation
- `block`: Name of the block
- `depth`: Position in call stack
- `status`: executing, waiting, or completed

---

## Independence from File-Based State

In-context state and file-based state (`filesystem.md`) are **independent approaches**. You choose one or the other based on program complexity.

- **In-context**: State lives in conversation history
- **File-based**: State lives in `.prose/runs/{id}/`

They are not designed to be complementary—pick the appropriate mode at program start.

---

## Summary

In-context state management:

1. Uses **text-prefixed markers** to track state changes
2. Persists state in **conversation history**
3. Is appropriate for **smaller, simpler programs**
4. Requires **consistent narration** throughout execution
5. Makes state **visible** in the conversation itself

The narration protocol ensures that the VM can recover its execution state by reading its own prior messages. What you say becomes what you remember.
