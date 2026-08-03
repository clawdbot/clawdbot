---
role: experimental
summary: |
  Homeric register for OpenProse—an epic/heroic alternative keyword set.
  Heroes, trials, fates, and glory. For benchmarking against the functional register.
status: draft
requires: prose.md
---

# OpenProse Homeric Register

> **This is a skin layer.** It requires `prose.md` to be loaded first. All execution semantics, state management, and VM behavior are defined there. This file only provides keyword translations.

An alternative register for OpenProse that draws from Greek epic poetry—the Iliad, the Odyssey, and the heroic tradition. Programs become quests. Agents become heroes. Outputs become glory won.

## How to Use

1. Load `prose.md` first (execution semantics)
2. Load this file (keyword translations)
3. When parsing `.prose` files, accept Homeric keywords as aliases for functional keywords
4. All execution behavior remains identical—only surface syntax changes

> **Design constraint:** Still aims to be "structured but self-evident" per the language tenets—just self-evident through an epic lens.

---

## Complete Translation Map

### Core Constructs

| Functional | Homeric | Reference                     |
| ---------- | ------- | ----------------------------- |
| `agent`    | `hero`  | The one who acts, who strives |
| `session`  | `trial` | Each task is a labor, a test  |
| `parallel` | `host`  | An army moving as one         |
| `block`    | `book`  | A division of the epic        |

### Composition & Binding

| Functional | Homeric   | Reference                              |
| ---------- | --------- | -------------------------------------- |
| `use`      | `invoke`  | "Sing, O Muse..." — calling upon       |
| `input`    | `omen`    | Signs from the gods, the given portent |
| `output`   | `glory`   | Kleos — the glory won, what endures    |
| `let`      | `decree`  | Fate declared, spoken into being       |
| `const`    | `fate`    | Moira — unchangeable destiny           |
| `context`  | `tidings` | News carried by herald or messenger    |

### Control Flow

| Functional | Homeric            | Reference                                |
| ---------- | ------------------ | ---------------------------------------- |
| `repeat N` | `N labors`         | The labors of Heracles                   |
| `for...in` | `for each...among` | Among the host                           |
| `loop`     | `ordeal`           | Repeated trial, suffering that continues |
| `until`    | `until`            | Unchanged                                |
| `while`    | `while`            | Unchanged                                |
| `choice`   | `crossroads`       | Where fates diverge                      |
| `option`   | `path`             | One road of many                         |
| `if`       | `should`           | Epic conditional                         |
| `elif`     | `or should`        | Continued conditional                    |
| `else`     | `otherwise`        | The alternative fate                     |

### Error Handling

| Functional | Homeric            | Reference                    |
| ---------- | ------------------ | ---------------------------- |
| `try`      | `venture`          | Setting forth on the journey |
| `catch`    | `should ruin come` | Até — divine ruin, disaster  |
| `finally`  | `in the end`       | The inevitable conclusion    |
| `throw`    | `lament`           | The hero's cry of anguish    |
| `retry`    | `persist`          | Enduring, trying again       |

### Session Properties

| Functional | Homeric  | Reference           |
| ---------- | -------- | ------------------- |
| `prompt`   | `charge` | The quest given     |
| `model`    | `muse`   | Which muse inspires |

### Shared appendix

Use [shared-appendix.md](./shared-appendix.md) for unchanged keywords and the common comparison pattern.

Recommended Homeric rewrite targets:

- `session` sample -> `trial`
- `parallel` sample -> `host`
- `loop` sample -> `ordeal`
- `try/catch/finally` sample -> `venture` / `should ruin come` / `in the end`
- `choice` sample -> `crossroads` / `path`

```prose
# Homeric
should **has security issues**:
  trial "Fix security"
or should **has performance issues**:
  trial "Optimize"
otherwise:
  trial "Approve"
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
# Homeric
book review(topic):
  trial "Research {topic}"
  trial "Analyze {topic}"

do review("quantum computing")
```

### Fixed Iteration

```prose
# Functional
repeat 12:
  session "Complete task"
```

```prose
# Homeric
12 labors:
  trial "Complete task"
```

### Immutable Binding

```prose
# Functional
const config = { model: "opus", retries: 3 }
```

```prose
# Homeric
fate config = { muse: "opus", persist: 3 }
```

---

## The Case For Homeric

1. **Universal recognition.** Greek epics are foundational to Western literature.
2. **Heroic framing.** Transforms mundane tasks into glorious trials.
3. **Natural fit.** Heroes face trials, receive tidings, win glory—maps cleanly to agent/session/output.
4. **Gravitas.** When you want programs to feel epic and consequential.
5. **Fate vs decree.** `const` as `fate` (unchangeable) vs `let` as `decree` (declared but mutable) is intuitive.

## The Case Against Homeric

1. **Grandiosity mismatch.** "12 labors" for a simple loop may feel overblown.
2. **Western-centric.** Greek epic tradition is culturally specific.
3. **Limited vocabulary.** Fewer distinctive terms than Borges or folk.
4. **Potentially silly.** Heroic language for mundane tasks risks bathos.

---

## Key Homeric Concepts

| Term   | Meaning                             | Used for                           |
| ------ | ----------------------------------- | ---------------------------------- |
| Kleos  | Glory, fame that outlives you       | `output` → `glory`                 |
| Moira  | Fate, one's allotted portion        | `const` → `fate`                   |
| Até    | Divine ruin, blindness sent by gods | `catch` → `should ruin come`       |
| Nostos | The return journey                  | (not used, but could be `finally`) |
| Xenia  | Guest-friendship, hospitality       | (not used)                         |
| Muse   | Divine inspiration                  | `model` → `muse`                   |

---

## Alternatives Considered

### For `hero` (agent)

| Keyword    | Rejected because                       |
| ---------- | -------------------------------------- |
| `champion` | More medieval than Homeric             |
| `warrior`  | Too martial, not all tasks are battles |
| `wanderer` | Too passive                            |

### For `trial` (session)

| Keyword | Rejected because                        |
| ------- | --------------------------------------- |
| `labor` | Good but reserved for `repeat N labors` |
| `quest` | More medieval/RPG                       |
| `task`  | Too plain                               |

### For `host` (parallel)

| Keyword   | Rejected because               |
| --------- | ------------------------------ |
| `army`    | Too specifically martial       |
| `fleet`   | Only works for naval metaphors |
| `phalanx` | Too technical                  |

---

## Verdict

Preserved for benchmarking. The Homeric register offers gravitas and heroic framing. Best suited for:

- Programs that feel like epic undertakings
- Users who enjoy classical references
- Contexts where "glory" as output feels appropriate

May cause unintentional bathos when applied to mundane tasks.
