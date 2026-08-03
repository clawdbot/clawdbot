# OpenProse Help

Load this file when a user invokes `prose help` or asks about OpenProse.

---

## Welcome

OpenProse is a programming language for AI sessions. You write structured programs that orchestrate AI agents, and the VM (this session) executes them by spawning real subagents.

**A long-running AI session is a Turing-complete computer. OpenProse is a programming language for it.**

---

## What Do You Want to Automate?

When a user invokes `prose help`, guide them toward defining what they want to build. Use the AskUserQuestion tool:

```
Question: "What would you like to automate with OpenProse?"
Header: "Goal"
Options:
  1. "Run a workflow" - "I have a .prose file to execute"
  2. "Build something new" - "Help me create a program for a specific task"
  3. "Learn the syntax" - "Show me examples and explain how it works"
  4. "Explore possibilities" - "What can OpenProse do?"
```

**After the user responds:**

- **Run a workflow**: Ask for the file path, then load `prose.md` and execute
- **Build something new**: Ask them to describe their task, then help write a .prose program (load `guidance/patterns.md`)
- **Learn the syntax**: Show examples from `examples/`, explain the VM model
- **Explore possibilities**: Walk through key examples like `37-the-forge.prose` or `28-gas-town.prose`

---

## Available Commands

| Command                | What it does                            |
| ---------------------- | --------------------------------------- |
| `prose help`           | This help - guides you to what you need |
| `prose run <file>`     | Execute a .prose program                |
| `prose compile <file>` | Validate syntax without running         |
| `prose update`         | Migrate legacy workspace files          |
| `prose examples`       | Browse and run example programs         |

---

## Quick Start

**Run an example:**

```
prose run examples/01-hello-world.prose
```

**Create your first program:**

```
prose help
→ Select "Build something new"
→ Describe what you want to automate
```

---

## FAQs

### What AI assistants are supported?

Claude Code, OpenCode, and Amp. Any harness that runs a sufficiently intelligent model and supports primitives like subagents are considered "Prose Complete".

### How is this a VM?

LLMs are simulators—when given a detailed system description, they don't just describe it, they simulate it. The `prose.md` spec describes a VM with enough fidelity that reading it induces simulation. But simulation with sufficient fidelity is implementation: each session spawns a real subagent, outputs are real artifacts, state persists in conversation history or files. The simulation is the execution.

### What's "intelligent IoC"?

Traditional IoC containers (Spring, Guice) wire up dependencies from configuration files. OpenProse's container is an AI session that wires up agents using understanding. It doesn't just match names—it understands context, intent, and can make intelligent decisions about execution.

### This looks like Python.

The syntax is intentionally familiar—Python's indentation-based structure is readable and self-evident. But the semantics are entirely different. OpenProse has no functions, no classes, no general-purpose computation. It has agents, sessions, and control flow. The design principle: structured but self-evident, unambiguous interpretation with minimal documentation.

### Why not English?

English is already an agent framework—we're not replacing it, we're structuring it. Plain English doesn't distinguish sequential from parallel, doesn't specify retry counts, doesn't scope variables. OpenProse uses English exactly where ambiguity is a feature (inside `**...**`), and structure everywhere else. The fourth wall syntax lets you lean on AI judgment precisely when you want to.

### Why not YAML?

We started with YAML. The problem: loops, conditionals, and variable declarations aren't self-evident in YAML—and when you try to make them self-evident, it gets verbose and ugly. More fundamentally, YAML optimizes for machine parseability. OpenProse optimizes for intelligent machine legibility. It doesn't need to be parsed—it needs to be understood. That's a different design target entirely.

### Why not LangChain/CrewAI/AutoGen?

Those are orchestration libraries—they coordinate agents from outside. OpenProse runs inside the agent session—the session itself is the IoC container. This means zero external dependencies and portability across any AI assistant. Switch from Claude Code to Codex? Your .prose files still work.

---

## Syntax at a Glance

```prose
session "prompt"              # Spawn subagent
agent name:                   # Define agent template
let x = session "..."         # Capture result
parallel:                     # Concurrent execution
repeat N:                     # Fixed loop
for x in items:               # Iteration
loop until **condition**:     # AI-evaluated loop
try: ... catch: ...           # Error handling
if **condition**: ...         # Conditional
choice **criteria**: option   # AI-selected branch
block name(params):           # Reusable block
do blockname(args)            # Invoke block
items | map: ...              # Pipeline
```

For complete syntax and validation rules, see `compiler.md`.

---

## Examples

The `examples/` directory contains 37 example programs:

| Range | Category                                                                          |
| ----- | --------------------------------------------------------------------------------- |
| 01-08 | Basics (hello world, research, code review, debugging)                            |
| 09-12 | Agents and skills                                                                 |
| 13-15 | Variables and composition                                                         |
| 16-19 | Parallel execution                                                                |
| 20-21 | Loops and pipelines                                                               |
| 22-23 | Error handling                                                                    |
| 24-27 | Advanced (choice, conditionals, blocks, interpolation)                            |
| 28    | Gas Town (multi-agent orchestration)                                              |
| 29-31 | Captain's chair pattern (persistent orchestrator)                                 |
| 33-36 | Production workflows (PR auto-fix, content pipeline, feature factory, bug hunter) |
| 37    | The Forge (build a browser from scratch)                                          |

**Recommended starting points:**

- `01-hello-world.prose` - Simplest possible program
- `16-parallel-reviews.prose` - See parallel execution
- `37-the-forge.prose` - Watch AI build a web browser
