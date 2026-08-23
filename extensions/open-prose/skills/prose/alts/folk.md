---
role: experimental
summary: |
  Folk register for OpenProse—a literary/folklore alternative keyword set.
  Whimsical, theatrical, rooted in fairy tale and myth. For benchmarking
  against the functional register.
status: draft
requires: prose.md
---

# OpenProse Folk Register

> **This is a skin layer.** It requires `prose.md` to be loaded first. All execution semantics, state management, and VM behavior are defined there. This file only provides keyword translations.

An alternative register for OpenProse that leans into literary, theatrical, and folklore terminology. The functional register prioritizes utility and clarity; the folk register prioritizes whimsy and narrative flow.

## How to Use

1. Load `prose.md` first (execution semantics)
2. Load this file (keyword translations)
3. When parsing `.prose` files, accept folk keywords as aliases for functional keywords
4. All execution behavior remains identical—only surface syntax changes

> **Design constraint:** Still aims to be "structured but self-evident" per the language tenets—just self-evident to a different sensibility.

---

## Complete Translation Map

### Core Constructs

| Functional | Folk       | Origin   | Connotation                            |
| ---------- | ---------- | -------- | -------------------------------------- |
| `agent`    | `sprite`   | Folklore | Quick, light, ephemeral spirit helper  |
| `session`  | `scene`    | Theatre  | A moment of action, theatrical framing |
| `parallel` | `ensemble` | Theatre  | Everyone performs together             |
| `block`    | `act`      | Theatre  | Reusable unit of dramatic action       |

### Composition & Binding

| Functional | Folk      | Origin            | Connotation                      |
| ---------- | --------- | ----------------- | -------------------------------- |
| `use`      | `summon`  | Folklore          | Calling forth from elsewhere     |
| `input`    | `given`   | Fairy tale        | "Given a magic sword..."         |
| `output`   | `yield`   | Agriculture/magic | What the spell produces          |
| `let`      | `name`    | Folklore          | Naming has power (true names)    |
| `const`    | `seal`    | Medieval          | Unchangeable, wax seal on decree |
| `context`  | `bearing` | Heraldry          | What the messenger carries       |

### Control Flow

| Functional | Folk               | Origin       | Connotation                         |
| ---------- | ------------------ | ------------ | ----------------------------------- |
| `repeat N` | `N times`          | Fairy tale   | "Three times she called..."         |
| `for...in` | `for each...among` | Narrative    | Slightly more storytelling          |
| `loop`     | `loop`             | —            | Already poetic, unchanged           |
| `until`    | `until`            | —            | Already works, unchanged            |
| `while`    | `while`            | —            | Already works, unchanged            |
| `choice`   | `crossroads`       | Folklore     | Fateful decisions at the crossroads |
| `option`   | `path`             | Journey      | Which path to take                  |
| `if`       | `when`             | Narrative    | "When the moon rises..."            |
| `elif`     | `or when`          | Narrative    | Continued conditional               |
| `else`     | `otherwise`        | Storytelling | Natural narrative alternative       |

### Error Handling

| Functional | Folk             | Origin     | Connotation                    |
| ---------- | ---------------- | ---------- | ------------------------------ |
| `try`      | `venture`        | Adventure  | Attempting something uncertain |
| `catch`    | `should it fail` | Narrative  | Conditional failure handling   |
| `finally`  | `ever after`     | Fairy tale | "And ever after..."            |
| `throw`    | `cry`            | Drama      | Raising alarm, calling out     |
| `retry`    | `persist`        | Quest      | Keep trying against odds       |

### Session Properties

| Functional | Folk     | Origin   | Connotation            |
| ---------- | -------- | -------- | ---------------------- |
| `prompt`   | `charge` | Chivalry | Giving a quest or duty |
| `model`    | `voice`  | Theatre  | Which voice speaks     |

### Unchanged

These keywords already have poetic quality or are too functional to replace sensibly:

- `**...**` discretion markers — already "breaking the fourth wall"
- `loop`, `until`, `while` — already work narratively
- `map`, `filter`, `reduce`, `pmap` — pipeline operators, functional is fine
- `max` — constraint modifier
- `as` — aliasing
- Model names: `sonnet`, `opus`, `haiku` — already poetic

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
# Folk
summon "@alice/research" as research
given topic: "What to investigate"

sprite helper:
  voice: sonnet

name findings = scene: helper
  charge: "Research {topic}"

yield summary = scene "Summarize"
  bearing: findings
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
# Folk
ensemble:
  security = scene "Check security"
  perf = scene "Check performance"
  style = scene "Check style"

scene "Synthesize review"
  bearing: { security, perf, style }
```

### Loop with Condition

```prose
# Functional
loop until **the code is bug-free** (max: 5):
  session "Find and fix bugs"
```

```prose
# Folk
loop until **the code is bug-free** (max: 5):
  scene "Find and fix bugs"
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
# Folk
venture:
  scene "Risky operation"
should it fail as err:
  scene "Handle error"
    bearing: err
ever after:
  scene "Cleanup"
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
# Folk
crossroads **the severity level**:
  path "Critical":
    scene "Escalate immediately"
  path "Minor":
    scene "Log for later"
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
# Folk
when **has security issues**:
  scene "Fix security"
or when **has performance issues**:
  scene "Optimize"
otherwise:
  scene "Approve"
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
# Folk
act review(topic):
  scene "Research {topic}"
  scene "Analyze {topic}"

perform review("quantum computing")
```

---

## The Case For Folk

1. **"OpenProse" is literary.** Prose is a literary form—why not lean in?
2. **Fourth wall is theatrical.** `**...**` already uses theatre terminology.
3. **Signals difference.** Literary terms say "this is not your typical DSL."
4. **Internally consistent.** Everything draws from folklore/theatre/narrative.
5. **Memorable.** `sprite`, `scene`, `crossroads` stick in the mind.
6. **Model names already fit.** `sonnet`, `opus`, `haiku` are poetic forms.

## The Case Against Folk

1. **Cultural knowledge required.** Not everyone knows folklore tropes.
2. **Harder to Google.** "OpenProse summon" vs "OpenProse import."
3. **May feel precious.** Some users want utilitarian tools.
4. **Translation overhead.** Mental mapping to familiar concepts.

---

## Alternatives Considered

### For `sprite` (ephemeral agent)

| Keyword   | Origin  | Rejected because                          |
| --------- | ------- | ----------------------------------------- |
| `spark`   | English | Good but less folklore                    |
| `wisp`    | English | Too insubstantial                         |
| `herald`  | English | More messenger than worker                |
| `courier` | French  | Good functional alternative, not literary |
| `envoy`   | French  | Formal, diplomatic                        |

### For `shade` (persistent agent, if implemented)

| Keyword   | Origin     | Rejected because                  |
| --------- | ---------- | --------------------------------- |
| `daemon`  | Greek/Unix | Unix "always running" connotation |
| `oracle`  | Greek      | Too "read-only" feeling           |
| `spirit`  | Latin      | Too close to `sprite`             |
| `specter` | Latin      | Negative/spooky connotation       |
| `genius`  | Roman      | Overloaded (smart person)         |

### For `ensemble` (parallel)

| Keyword   | Origin  | Rejected because                          |
| --------- | ------- | ----------------------------------------- |
| `chorus`  | Greek   | Everyone speaks same thing, not different |
| `troupe`  | French  | Good alternative, slightly less clear     |
| `company` | Theatre | Overloaded (business)                     |

### For `crossroads` (choice)

| Keyword      | Origin | Rejected because         |
| ------------ | ------ | ------------------------ |
| `fork`       | Path   | Too technical (git fork) |
| `branch`     | Tree   | Also too technical       |
| `divergence` | Latin  | Too abstract             |

---

## Verdict

Preserved for benchmarking against the functional register. The functional register remains the primary path, but folk provides an interesting data point for:

1. **Learnability** — Which is easier for newcomers?
2. **Memorability** — Which sticks better?
3. **Error rates** — Which leads to fewer mistakes?
4. **Preference** — Which do users actually prefer?

A future experiment could present both registers and measure outcomes.
