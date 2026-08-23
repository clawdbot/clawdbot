---
role: experimental
summary: |
  Borges register for OpenProse—a scholarly/metaphysical alternative keyword set.
  Labyrinths, dreamers, forking paths, and infinite libraries. For benchmarking
  against the functional register.
status: draft
requires: prose.md
---

# OpenProse Borges Register

> **This is a skin layer.** It requires `prose.md` to be loaded first. All execution semantics, state management, and VM behavior are defined there. This file only provides keyword translations.

An alternative register for OpenProse that draws from the works of Jorge Luis Borges. Where the functional register is utilitarian and the folk register is whimsical, the Borges register is scholarly and metaphysical—everything feels like a citation from a fictional encyclopedia.

## How to Use

1. Load `prose.md` first (execution semantics)
2. Load this file (keyword translations)
3. When parsing `.prose` files, accept Borges keywords as aliases for functional keywords
4. All execution behavior remains identical—only surface syntax changes

> **Design constraint:** Still aims to be "structured but self-evident" per the language tenets—just self-evident through a Borgesian lens.

---

## Complete Translation Map

### Core Constructs

| Functional | Borges    | Reference                                                       |
| ---------- | --------- | --------------------------------------------------------------- |
| `agent`    | `dreamer` | "The Circular Ruins" — dreamers who dream worlds into existence |
| `session`  | `dream`   | Each execution is a dream within the dreamer                    |
| `parallel` | `forking` | "The Garden of Forking Paths" — branching timelines             |
| `block`    | `chapter` | Books within books, self-referential structure                  |

### Composition & Binding

| Functional | Borges     | Reference                                                |
| ---------- | ---------- | -------------------------------------------------------- |
| `use`      | `retrieve` | "The Library of Babel" — retrieving from infinite stacks |
| `input`    | `axiom`    | The given premise (Borges' scholarly/mathematical tone)  |
| `output`   | `theorem`  | What is derived from the axioms                          |
| `let`      | `inscribe` | Writing something into being                             |
| `const`    | `zahir`    | "The Zahir" — unforgettable, unchangeable, fixed in mind |
| `context`  | `memory`   | "Funes the Memorious" — perfect, total recall            |

### Control Flow

| Functional | Borges              | Reference                              |
| ---------- | ------------------- | -------------------------------------- |
| `repeat N` | `N mirrors`         | Infinite reflections facing each other |
| `for...in` | `for each...within` | Slightly more Borgesian preposition    |
| `loop`     | `labyrinth`         | The maze that folds back on itself     |
| `until`    | `until`             | Unchanged                              |
| `while`    | `while`             | Unchanged                              |
| `choice`   | `bifurcation`       | The forking of paths                   |
| `option`   | `branch`            | One branch of diverging time           |
| `if`       | `should`            | Scholarly conditional                  |
| `elif`     | `or should`         | Continued conditional                  |
| `else`     | `otherwise`         | Natural alternative                    |

### Error Handling

| Functional | Borges       | Reference                              |
| ---------- | ------------ | -------------------------------------- |
| `try`      | `venture`    | Entering the labyrinth                 |
| `catch`    | `lest`       | "Lest it fail..." (archaic, scholarly) |
| `finally`  | `ultimately` | The inevitable conclusion              |
| `throw`    | `shatter`    | Breaking the mirror, ending the dream  |
| `retry`    | `recur`      | Infinite regress, trying again         |

### Session Properties

| Functional | Borges   | Reference                      |
| ---------- | -------- | ------------------------------ |
| `prompt`   | `query`  | Asking the Library             |
| `model`    | `author` | Which author writes this dream |

### Unchanged

These keywords already work or are too functional to replace sensibly:

- `**...**` discretion markers — already "breaking the fourth wall"
- `until`, `while` — already work
- `map`, `filter`, `reduce`, `pmap` — pipeline operators
- `max` — constraint modifier
- `as` — aliasing
- Model names: `sonnet`, `opus`, `haiku` — already literary

---

## Side-by-Side Comparison

### Simple Program

```prose
# Functional
use "@alice/research" as research
input topic: "What to investigate"

agent helper:
  model: sonnet

let findings = session: helper
  prompt: "Research {topic}"

output summary = session "Summarize"
  context: findings
```

```prose
# Borges
retrieve "@alice/research" as research
axiom topic: "What to investigate"

dreamer helper:
  author: sonnet

inscribe findings = dream: helper
  query: "Research {topic}"

theorem summary = dream "Summarize"
  memory: findings
```

### Parallel Execution

```prose
# Functional
parallel:
  security = session "Check security"
  perf = session "Check performance"
  style = session "Check style"

session "Synthesize review"
  context: { security, perf, style }
```

```prose
# Borges
forking:
  security = dream "Check security"
  perf = dream "Check performance"
  style = dream "Check style"

dream "Synthesize review"
  memory: { security, perf, style }
```

### Loop with Condition

```prose
# Functional
loop until **the code is bug-free** (max: 5):
  session "Find and fix bugs"
```

```prose
# Borges
labyrinth until **the code is bug-free** (max: 5):
  dream "Find and fix bugs"
```

### Error Handling

```prose
# Functional
try:
  session "Risky operation"
catch as err:
  session "Handle error"
    context: err
finally:
  session "Cleanup"
```

```prose
# Borges
venture:
  dream "Risky operation"
lest as err:
  dream "Handle error"
    memory: err
ultimately:
  dream "Cleanup"
```

### Choice Block

```prose
# Functional
choice **the severity level**:
  option "Critical":
    session "Escalate immediately"
  option "Minor":
    session "Log for later"
```

```prose
# Borges
bifurcation **the severity level**:
  branch "Critical":
    dream "Escalate immediately"
  branch "Minor":
    dream "Log for later"
```

### Conditionals

```prose
# Functional
if **has security issues**:
  session "Fix security"
elif **has performance issues**:
  session "Optimize"
else:
  session "Approve"
```

```prose
# Borges
should **has security issues**:
  dream "Fix security"
or should **has performance issues**:
  dream "Optimize"
otherwise:
  dream "Approve"
```

### Reusable Blocks

```prose
# Functional
block review(topic):
  session "Research {topic}"
  session "Analyze {topic}"

do review("quantum computing")
```

```prose
# Borges
chapter review(topic):
  dream "Research {topic}"
  dream "Analyze {topic}"

do review("quantum computing")
```

### Fixed Iteration

```prose
# Functional
repeat 3:
  session "Generate idea"
```

```prose
# Borges
3 mirrors:
  dream "Generate idea"
```

### Immutable Binding

```prose
# Functional
const config = { model: "opus", retries: 3 }
```

```prose
# Borges
zahir config = { author: "opus", recur: 3 }
```

---

## The Case For Borges

1. **Metaphysical resonance.** AI sessions dreaming subagents into existence mirrors "The Circular Ruins."
2. **Scholarly tone.** `axiom`/`theorem` frame programs as logical derivations.
3. **Memorable metaphors.** The zahir you cannot change. The labyrinth you cannot escape. The library you retrieve from.
4. **Thematic coherence.** Borges wrote about infinity, recursion, and branching time—all core to computation.
5. **Literary prestige.** Borges is widely read; references land for many users.

## The Case Against Borges

1. **Requires familiarity.** "Zahir" and "Funes" are obscure to those who haven't read Borges.
2. **Potentially pretentious.** May feel like showing off rather than communicating.
3. **Translation overhead.** Users must map `labyrinth` → `loop` mentally.
4. **Cultural specificity.** Less universal than folk/fairy tale tropes.

---

## Key Borges References

For those unfamiliar with the source material:

| Work                          | Concept Used                       | Summary                                                                               |
| ----------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------- |
| "The Circular Ruins"          | `dreamer`, `dream`                 | A man dreams another man into existence, only to discover he himself is being dreamed |
| "The Garden of Forking Paths" | `forking`, `bifurcation`, `branch` | A labyrinth that is a book; time forks perpetually into diverging futures             |
| "The Library of Babel"        | `retrieve`                         | An infinite library containing every possible book                                    |
| "Funes the Memorious"         | `memory`                           | A man with perfect memory who cannot forget anything                                  |
| "The Zahir"                   | `zahir`                            | An object that, once seen, cannot be forgotten or ignored                             |
| "The Aleph"                   | (not used)                         | A point in space containing all other points                                          |
| "Tlön, Uqbar, Orbis Tertius"  | (not used)                         | A fictional world that gradually becomes real                                         |

---

## Alternatives Considered

### For `dreamer` (agent)

| Keyword     | Rejected because          |
| ----------- | ------------------------- |
| `author`    | Used for `model` instead  |
| `scribe`    | Too passive, just records |
| `librarian` | More curator than creator |

### For `labyrinth` (loop)

| Keyword          | Rejected because |
| ---------------- | ---------------- |
| `recursion`      | Too technical    |
| `eternal return` | Too long         |
| `ouroboros`      | Wrong mythology  |

### For `zahir` (const)

| Keyword   | Rejected because                              |
| --------- | --------------------------------------------- |
| `aleph`   | The Aleph is about totality, not immutability |
| `fixed`   | Too plain                                     |
| `eternal` | Overused                                      |

### For `memory` (context)

| Keyword   | Rejected because                  |
| --------- | --------------------------------- |
| `funes`   | Too obscure as standalone keyword |
| `recall`  | Sounds like a function call       |
| `archive` | More Library of Babel than Funes  |

---

## Verdict

Preserved for benchmarking against the functional and folk registers. The Borges register offers a distinctly intellectual/metaphysical flavor that may resonate with users who appreciate literary computing.

Potential benchmarking questions:

1. **Learnability** — Is `labyrinth` intuitive for loops?
2. **Memorability** — Does `zahir` stick better than `const`?
3. **Comprehension** — Do users understand `dreamer`/`dream` immediately?
4. **Preference** — Which register do users find most pleasant?
5. **Error rates** — Does the metaphorical mapping cause mistakes?
