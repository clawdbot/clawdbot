---
role: experimental
summary: |
  Arabian Nights register for OpenProse—a narrative/nested alternative keyword set.
  Djinns, tales within tales, wishes, and oaths. For benchmarking against the functional register.
status: draft
requires: prose.md
---

# OpenProse Arabian Nights Register

> **This is a skin layer.** It requires `prose.md` to be loaded first. All execution semantics, state management, and VM behavior are defined there. This file only provides keyword translations.

An alternative register for OpenProse that draws from One Thousand and One Nights. Programs become tales told by Scheherazade. Recursion becomes stories within stories. Agents become djinns bound to serve.

## How to Use

1. Load `prose.md` first (execution semantics)
2. Load this file (keyword translations)
3. When parsing `.prose` files, accept Arabian Nights keywords as aliases for functional keywords
4. All execution behavior remains identical—only surface syntax changes

> **Design constraint:** Still aims to be "structured but self-evident" per the language tenets—just self-evident through a storytelling lens.

---

## Complete Translation Map

### Core Constructs

| Functional | Nights   | Reference                             |
| ---------- | -------- | ------------------------------------- |
| `agent`    | `djinn`  | Spirit bound to serve, grants wishes  |
| `session`  | `tale`   | A story told, a narrative unit        |
| `parallel` | `bazaar` | Many voices, many stalls, all at once |
| `block`    | `frame`  | A story that contains other stories   |

### Composition & Binding

| Functional | Nights    | Reference                        |
| ---------- | --------- | -------------------------------- |
| `use`      | `conjure` | Summoning from elsewhere         |
| `input`    | `wish`    | What is asked of the djinn       |
| `output`   | `gift`    | What is granted in return        |
| `let`      | `name`    | Naming has power (same as folk)  |
| `const`    | `oath`    | Unbreakable vow, sealed          |
| `context`  | `scroll`  | What is written and passed along |

### Control Flow

| Functional | Nights             | Reference                            |
| ---------- | ------------------ | ------------------------------------ |
| `repeat N` | `N nights`         | "For a thousand and one nights..."   |
| `for...in` | `for each...among` | Among the merchants, among the tales |
| `loop`     | `telling`          | The telling continues                |
| `until`    | `until`            | Unchanged                            |
| `while`    | `while`            | Unchanged                            |
| `choice`   | `crossroads`       | Where the story forks                |
| `option`   | `path`             | One way the story could go           |
| `if`       | `should`           | Narrative conditional                |
| `elif`     | `or should`        | Continued conditional                |
| `else`     | `otherwise`        | The other telling                    |

### Error Handling

| Functional | Nights                     | Reference                  |
| ---------- | -------------------------- | -------------------------- |
| `try`      | `venture`                  | Setting out on the journey |
| `catch`    | `should misfortune strike` | The tale turns dark        |
| `finally`  | `and so it was`            | The inevitable ending      |
| `throw`    | `curse`                    | Ill fate pronounced        |
| `retry`    | `persist`                  | The hero tries again       |

### Session Properties

| Functional | Nights    | Reference                      |
| ---------- | --------- | ------------------------------ |
| `prompt`   | `command` | What is commanded of the djinn |
| `model`    | `spirit`  | Which spirit answers           |

### Shared appendix

Use [shared-appendix.md](./shared-appendix.md) for unchanged keywords and the common comparison pattern.

Recommended Arabian Nights rewrite targets:

- `session` sample -> `tale`
- `parallel` sample -> `bazaar`
- `loop` sample -> `telling`
- `try/catch/finally` sample -> `venture` / `should misfortune strike` / `and so it was`
- `choice` sample -> `crossroads` / `path`

```prose
# Nights
should **has security issues**:
  tale "Fix security"
or should **has performance issues**:
  tale "Optimize"
otherwise:
  tale "Approve"
```

### Reusable Blocks (Frame Stories)

```prose
# Functional
block review(topic):
  session "Research {topic}"
  session "Analyze {topic}"

do review("quantum computing")
```

```prose
# Nights
frame review(topic):
  tale "Research {topic}"
  tale "Analyze {topic}"

tell review("quantum computing")
```

### Fixed Iteration

```prose
# Functional
repeat 1001:
  session "Tell a story"
```

```prose
# Nights
1001 nights:
  tale "Tell a story"
```

### Immutable Binding

```prose
# Functional
const config = { model: "opus", retries: 3 }
```

```prose
# Nights
oath config = { spirit: "opus", persist: 3 }
```

---

## The Case For Arabian Nights

1. **Frame narrative is recursion.** Stories within stories maps perfectly to nested program calls.
2. **Djinn/wish/gift.** The agent/input/output mapping is extremely clean.
3. **Rich tradition.** One Thousand and One Nights is globally known.
4. **Bazaar for parallel.** Many merchants, many stalls, all active at once—vivid metaphor.
5. **Oath for const.** An unbreakable vow is a perfect metaphor for immutability.
6. **"1001 nights"** as a loop count is delightful.

## The Case Against Arabian Nights

1. **Cultural sensitivity.** Must be handled respectfully, avoiding Orientalist tropes.
2. **"Djinn" pronunciation.** Users unfamiliar may be uncertain (jinn? djinn? genie?).
3. **Some mappings feel forced.** "Bazaar" for parallel is vivid but not obvious.
4. **"Should misfortune strike"** is long for `catch`.

---

## Key Arabian Nights Concepts

| Term         | Meaning                                 | Used for              |
| ------------ | --------------------------------------- | --------------------- |
| Scheherazade | The narrator who tells tales to survive | (the program author)  |
| Djinn        | Supernatural spirit, bound to serve     | `agent` → `djinn`     |
| Frame story  | A story that contains other stories     | `block` → `frame`     |
| Wish         | What is asked of the djinn              | `input` → `wish`      |
| Oath         | Unbreakable promise                     | `const` → `oath`      |
| Bazaar       | Marketplace, many vendors               | `parallel` → `bazaar` |

---

## Alternatives Considered

### For `djinn` (agent)

| Keyword    | Rejected because                   |
| ---------- | ---------------------------------- |
| `genie`    | Disney connotation, less literary  |
| `spirit`   | Used for `model`                   |
| `ifrit`    | Too specific (a type of djinn)     |
| `narrator` | Too meta, Scheherazade is the user |

### For `tale` (session)

| Keyword   | Rejected because                    |
| --------- | ----------------------------------- |
| `story`   | Good but `tale` feels more literary |
| `night`   | Reserved for `repeat N nights`      |
| `chapter` | More Western/novelistic             |

### For `bazaar` (parallel)

| Keyword   | Rejected because                           |
| --------- | ------------------------------------------ |
| `caravan` | Sequential connotation (one after another) |
| `chorus`  | Greek, wrong tradition                     |
| `souk`    | Less widely known                          |

### For `scroll` (context)

| Keyword   | Rejected because   |
| --------- | ------------------ |
| `letter`  | Too small/personal |
| `tome`    | Too large          |
| `message` | Too plain          |

---

## Verdict

Preserved for benchmarking. The Arabian Nights register offers a storytelling frame that maps naturally to recursive, nested programs. The djinn/wish/gift trio is particularly elegant.

Best suited for:

- Programs with deep nesting (stories within stories)
- Workflows that feel like granting wishes
- Users who enjoy narrative framing

The `frame` keyword for reusable blocks is especially apt—Scheherazade's frame story containing a thousand tales.
