---
role: experimental
summary: |
  Kafka register for OpenProse—a bureaucratic/absurdist alternative keyword set.
  Clerks, proceedings, petitions, and statutes. For benchmarking against the functional register.
status: draft
requires: prose.md
---

# OpenProse Kafka Register

> **This is a skin layer.** It requires `prose.md` to be loaded first. All execution semantics, state management, and VM behavior are defined there. This file only provides keyword translations.

An alternative register for OpenProse that draws from the works of Franz Kafka—The Trial, The Castle, "In the Penal Colony." Programs become proceedings. Agents become clerks. Everything is a process, and nobody quite knows the rules.

## How to Use

1. Load `prose.md` first (execution semantics)
2. Load this file (keyword translations)
3. When parsing `.prose` files, accept Kafka keywords as aliases for functional keywords
4. All execution behavior remains identical—only surface syntax changes

> **Design constraint:** Still aims to be "structured but self-evident" per the language tenets—just self-evident through a bureaucratic lens. (The irony is intentional.)

---

## Complete Translation Map

### Core Constructs

| Functional | Kafka         | Reference                              |
| ---------- | ------------- | -------------------------------------- |
| `agent`    | `clerk`       | A functionary in the apparatus         |
| `session`  | `proceeding`  | An official action taken               |
| `parallel` | `departments` | Multiple bureaus acting simultaneously |
| `block`    | `regulation`  | A codified procedure                   |

### Composition & Binding

| Functional | Kafka         | Reference                           |
| ---------- | ------------- | ----------------------------------- |
| `use`      | `requisition` | Requesting from the archives        |
| `input`    | `petition`    | What is submitted for consideration |
| `output`   | `verdict`     | What is returned by the apparatus   |
| `let`      | `file`        | Recording in the system             |
| `const`    | `statute`     | Unchangeable law                    |
| `context`  | `dossier`     | The accumulated file on a case      |

### Control Flow

| Functional | Kafka                         | Reference                                  |
| ---------- | ----------------------------- | ------------------------------------------ |
| `repeat N` | `N hearings`                  | Repeated appearances before the court      |
| `for...in` | `for each...in the matter of` | Bureaucratic iteration                     |
| `loop`     | `appeal`                      | Endless re-petition, the process continues |
| `until`    | `until`                       | Unchanged                                  |
| `while`    | `while`                       | Unchanged                                  |
| `choice`   | `tribunal`                    | Where judgment is rendered                 |
| `option`   | `ruling`                      | One possible judgment                      |
| `if`       | `in the event that`           | Bureaucratic conditional                   |
| `elif`     | `or in the event that`        | Continued conditional                      |
| `else`     | `otherwise`                   | Default ruling                             |

### Error Handling

| Functional | Kafka                 | Reference                          |
| ---------- | --------------------- | ---------------------------------- |
| `try`      | `submit`              | Submitting for processing          |
| `catch`    | `should it be denied` | Rejection by the apparatus         |
| `finally`  | `regardless`          | What happens no matter the outcome |
| `throw`    | `reject`              | The system refuses                 |
| `retry`    | `resubmit`            | Try the process again              |

### Session Properties

| Functional | Kafka       | Reference                    |
| ---------- | ----------- | ---------------------------- |
| `prompt`   | `directive` | Official instructions        |
| `model`    | `authority` | Which level of the hierarchy |

### Unchanged

These keywords already work or are too functional to replace sensibly:

- `**...**` discretion markers — the inscrutable judgment of the apparatus
- `until`, `while` — already work
- `map`, `filter`, `reduce`, `pmap` — pipeline operators
- `max` — constraint modifier
- `as` — aliasing
- Model names: `sonnet`, `opus`, `haiku` — retained (or see "authority" above)

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
# Kafka
requisition "@alice/research" as research
petition topic: "What to investigate"

clerk helper:
  authority: sonnet

file findings = proceeding: helper
  directive: "Research {topic}"

verdict summary = proceeding "Summarize"
  dossier: findings
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
# Kafka
departments:
  security = proceeding "Check security"
  perf = proceeding "Check performance"
  style = proceeding "Check style"

proceeding "Synthesize review"
  dossier: { security, perf, style }
```

### Loop with Condition

```prose
# Functional
loop until **the code is bug-free** (max: 5):
  session "Find and fix bugs"
```

```prose
# Kafka
appeal until **the code is bug-free** (max: 5):
  proceeding "Find and fix bugs"
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
# Kafka
submit:
  proceeding "Risky operation"
should it be denied as err:
  proceeding "Handle error"
    dossier: err
regardless:
  proceeding "Cleanup"
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
# Kafka
tribunal **the severity level**:
  ruling "Critical":
    proceeding "Escalate immediately"
  ruling "Minor":
    proceeding "Log for later"
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
# Kafka
in the event that **has security issues**:
  proceeding "Fix security"
or in the event that **has performance issues**:
  proceeding "Optimize"
otherwise:
  proceeding "Approve"
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
# Kafka
regulation review(topic):
  proceeding "Research {topic}"
  proceeding "Analyze {topic}"

invoke review("quantum computing")
```

### Fixed Iteration

```prose
# Functional
repeat 3:
  session "Attempt connection"
```

```prose
# Kafka
3 hearings:
  proceeding "Attempt connection"
```

### Immutable Binding

```prose
# Functional
const config = { model: "opus", retries: 3 }
```

```prose
# Kafka
statute config = { authority: "opus", resubmit: 3 }
```

---

## The Case For Kafka

1. **Darkly comic.** Programs-as-bureaucracy is funny and relatable.
2. **Surprisingly apt.** Software often _is_ an inscrutable apparatus.
3. **Clean mappings.** Petition/verdict, file/dossier, clerk/proceeding all work well.
4. **Appeal as loop.** The endless appeal process is a perfect metaphor for retry logic.
5. **Cultural resonance.** "Kafkaesque" is a widely understood adjective.
6. **Self-aware.** Using Kafka for a programming language acknowledges the absurdity.

## The Case Against Kafka

1. **Bleak tone.** Not everyone wants their programs to feel like The Trial.
2. **Verbose keywords.** "In the event that" and "should it be denied" are long.
3. **Anxiety-inducing.** May not be fun for users who find bureaucracy stressful.
4. **Irony may not land.** Some users might take it literally and find it off-putting.

---

## Key Kafka Concepts

| Term          | Meaning                            | Used for                 |
| ------------- | ---------------------------------- | ------------------------ |
| The apparatus | The inscrutable system             | The VM itself            |
| K.            | The protagonist, never fully named | The user                 |
| The Trial     | Process without clear rules        | Program execution        |
| The Castle    | Unreachable authority              | Higher-level systems     |
| Clerk         | Functionary who processes          | `agent` → `clerk`        |
| Proceeding    | Official action                    | `session` → `proceeding` |
| Dossier       | Accumulated file                   | `context` → `dossier`    |

---

## Alternatives Considered

### For `clerk` (agent)

| Keyword       | Rejected because     |
| ------------- | -------------------- |
| `official`    | Too generic          |
| `functionary` | Hard to spell        |
| `bureaucrat`  | Too pejorative       |
| `advocate`    | Too positive/helpful |

### For `proceeding` (session)

| Keyword   | Rejected because                 |
| --------- | -------------------------------- |
| `case`    | Overloaded (switch case)         |
| `hearing` | Reserved for `repeat N hearings` |
| `trial`   | Used in Homeric register         |
| `process` | Too technical                    |

### For `departments` (parallel)

| Keyword      | Rejected because                      |
| ------------ | ------------------------------------- |
| `bureaus`    | Good alternative, slightly less clear |
| `offices`    | Too mundane                           |
| `ministries` | More Orwellian than Kafkaesque        |

### For `appeal` (loop)

| Keyword    | Rejected because    |
| ---------- | ------------------- |
| `recourse` | Too legal-technical |
| `petition` | Used for `input`    |
| `process`  | Too generic         |

---

## Verdict

Preserved for benchmarking. The Kafka register offers a darkly comic, self-aware framing that acknowledges the bureaucratic nature of software systems. The irony is the point.

Best suited for:

- Users with a sense of humor about software complexity
- Programs that genuinely feel like navigating bureaucracy
- Contexts where acknowledging absurdity is welcome

Not recommended for:

- Users who find bureaucratic metaphors stressful
- Contexts requiring earnest, positive framing
- Documentation that needs to feel approachable

---

## Closing Note

> "Someone must have slandered Josef K., for one morning, without having done anything wrong, he was arrested."
> — _The Trial_

In the Kafka register, your program is Josef K. The apparatus will process it. Whether it succeeds or fails, no one can say for certain. But the proceedings will continue.
