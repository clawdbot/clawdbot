---
role: experimental
summary: |
  Borges-inspired alternative keywords for OpenProse. A "what if" exploration drawing
  from The Library of Babel, Garden of Forking Paths, Circular Ruins, and other works.
  Not for implementation—just capturing ideas.
status: draft
---

# OpenProse Borges Alternative

A potential alternative register for OpenProse that draws from Jorge Luis Borges's literary universe: infinite libraries, forking paths, circular dreams, and metaphysical labyrinths. Preserved for future benchmarking against the functional language.

## Keyword Translations

### Agents & Persistence

| Functional | Borges      | Connotation                                                                      |
| ---------- | ----------- | -------------------------------------------------------------------------------- |
| `agent`    | `dreamer`   | Ephemeral, created for a purpose (Circular Ruins: dreamed into existence)        |
| `keeper`   | `librarian` | Persistent, remembers, catalogs (Library of Babel: keeper of infinite knowledge) |

```prose
# Functional
agent executor:
  model: sonnet

keeper captain:
  model: opus

# Borges
dreamer executor:
  model: sonnet

librarian captain:
  model: opus
```

### Other Potential Translations

| Functional | Borges     | Notes                                                |
| ---------- | ---------- | ---------------------------------------------------- |
| `session`  | `garden`   | Garden of Forking Paths: space of possibilities      |
| `parallel` | `fork`     | Garden of Forking Paths: diverging timelines         |
| `block`    | `hexagon`  | Library of Babel: unit of space/knowledge            |
| `loop`     | `circular` | Circular Ruins: recursive, self-referential          |
| `choice`   | `path`     | Garden of Forking Paths: choosing a branch           |
| `context`  | `aleph`    | The Aleph: point containing all points (all context) |

### Invocation Patterns

```prose
# Functional
session: executor
  prompt: "Do task"

captain "Review this"
  context: work

# Borges
garden: dreamer executor
  prompt: "Do task"

captain "Review this"    # librarian invocation (same pattern)
  aleph: work
```

## Alternative Persistent Keywords Considered

| Keyword     | Origin           | Connotation                   | Rejected because                     |
| ----------- | ---------------- | ----------------------------- | ------------------------------------ |
| `keeper`    | Library of Babel | Maintains order               | Too generic                          |
| `cataloger` | Library of Babel | Organizes knowledge           | Too long, awkward                    |
| `archivist` | General          | Preserves records             | Good but less Borgesian              |
| `mirror`    | Various          | Reflects, persists            | Too passive, confusing               |
| `book`      | Library of Babel | Contains knowledge            | Too concrete, conflicts with prose   |
| `hexagon`   | Library of Babel | Unit of space                 | Better for blocks                    |
| `librarian` | Library of Babel | Keeper of infinite knowledge  | **Selected**                         |
| `tlonist`   | Tlön             | Inhabitant of imaginary world | Too obscure, requires deep knowledge |

## Alternative Ephemeral Keywords Considered

| Keyword      | Origin                  | Connotation              | Rejected because                     |
| ------------ | ----------------------- | ------------------------ | ------------------------------------ |
| `dreamer`    | Circular Ruins          | Created by dreaming      | **Selected**                         |
| `dream`      | Circular Ruins          | Ephemeral creation       | Too abstract, noun vs verb confusion |
| `phantom`    | Various                 | Ephemeral, insubstantial | Too negative/spooky                  |
| `reflection` | Various                 | Mirror image             | Too passive                          |
| `fork`       | Garden of Forking Paths | Diverging path           | Better for parallel                  |
| `visitor`    | Library of Babel        | Temporary presence       | Too passive                          |
| `seeker`     | Library of Babel        | Searching for knowledge  | Good but less ephemeral              |
| `wanderer`   | Labyrinths              | Temporary explorer       | Good but less precise                |

## The Case For Borges

1. **Infinite recursion**: Borges's themes align with computational recursion (`circular`, `fork`)
2. **Metaphysical precision**: Concepts like `aleph` (all context) are philosophically rich
3. **Library metaphor**: `librarian` perfectly captures persistent knowledge
4. **Forking paths**: `fork` / `path` naturally express parallel execution and choice
5. **Dream logic**: `dreamer` suggests creation and ephemerality
6. **Literary coherence**: All terms come from a unified literary universe
7. **Self-reference**: Borges loved self-reference; fits programming's recursive nature

## The Case Against Borges

1. **Cultural barrier**: Requires deep familiarity with Borges's works
2. **Abstractness**: `aleph`, `hexagon` may be too abstract for practical use
3. **Overload**: `fork` could confuse (Unix fork vs. path fork)
4. **Register mismatch**: Rest of language is functional (`session`, `parallel`, `loop`)
5. **Accessibility**: Violates "self-evident" tenet for most users
6. **Noun confusion**: `garden` as a verb-like construct might be awkward
7. **Translation burden**: Non-English speakers may not know Borges

## Borgesian Concepts Not Used (But Considered)

| Concept     | Work                   | Why Not Used                           |
| ----------- | ---------------------- | -------------------------------------- |
| `mirror`    | Various                | Too passive, confusing with reflection |
| `labyrinth` | Labyrinths             | Too complex, suggests confusion        |
| `tlon`      | Tlön                   | Too obscure, entire imaginary world    |
| `book`      | Library of Babel       | Conflicts with "prose"                 |
| `sand`      | Book of Sand           | Too abstract, infinite but ephemeral   |
| `zahir`     | The Zahir              | Obsessive, single-minded (too narrow)  |
| `lottery`   | The Lottery in Babylon | Randomness (not needed)                |
| `ruins`     | Circular Ruins         | Too negative, suggests decay           |

## Verdict

Preserved for benchmarking. The functional language (`agent` / `keeper`) is the primary path for now. Borges offers rich metaphors but at the cost of accessibility and self-evidence.

## Notes on Borges's Influence

Borges's work anticipates many computational concepts:

- **Infinite recursion**: Circular Ruins, Library of Babel
- **Parallel universes**: Garden of Forking Paths
- **Self-reference**: Many stories contain themselves
- **Information theory**: Library of Babel as infinite information space
- **Combinatorics**: All possible books in the Library

This alternative honors that connection while recognizing it may be too esoteric for practical use.
