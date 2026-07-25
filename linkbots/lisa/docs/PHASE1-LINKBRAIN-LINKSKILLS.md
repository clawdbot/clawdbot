## Proposed Phase 1 approach (plain English)

No wiring yet — this is the recommended design based on the three repos + how OpenClaw actually loads skills/memory.

---

### Picture in one sentence

Keep Lisa’s **personal memory and dreaming** inside OpenClaw; give her **LiNKtrend company memory** through LiNKbrain tools; give her **studio how-to skills** from LiNKskills via OpenClaw’s existing skill folders — without ripping out OpenClaw’s own systems. Do the same brain/skills substrate for LiNKdeveloper’s Cursor-agent executor.

---

### What stays OpenClaw-native (do not replace in Phase 1)

| Piece                                | Role                                                   |
| ------------------------------------ | ------------------------------------------------------ |
| Session chat + compaction            | Short-term working context                             |
| Dreaming / local memory plugins      | Lisa’s personal habits, preferences, day-to-day recall |
| Built-in platform skills             | Browser, files, GitHub, etc. (OpenClaw’s own toolkit)  |
| Gateway / channels / instance config | How Lisa runs on this Mac Mini                         |

---

### How Lisa uses LiNKbrain (company memory)

**What LiNKbrain already offers a consumer:** a small library (`@linktrend/lbrain-runtime`) with three jobs:

1. **Search** company knowledge (titles/summaries first)
2. **Load** the full note when she needs it
3. **Append a finding** to the shared scratch pad (`team_memory`) — no approval wait

**How we wire that into Lisa (recommended):** a thin **LiNKbrain bridge** as an OpenClaw **plugin or MCP tool pack** — not a second brain that replaces dreaming.

Lisa gets tools like:

- “Search LiNKtrend knowledge…”
- “Open that knowledge note…”
- “Save this for the company brain…” (writes scratch, tagged `source_agent = lisa`)

**Rules we teach her (doctrine, not code magic):**

- Fleeting / personal → OpenClaw local memory
- “LiNKtrend should remember this” → LiNKbrain scratch
- She never edits canonical company truth directly — the **Librarian** promotes later

**Phase 1 done for brain (per your bar):** she actually searches/reads and appends in real chief-of-staff work for several days on **stage**, and the Librarian has promoted **at least one** of her findings.

**Librarian:** already lives in LiNKplatform; Phase 1 must run it against stage (scheduled or manual) so promotion can happen — this is part of “done,” not optional.

---

### How Lisa uses LiNKskills (studio skills)

**What LiNKskills is:** a git catalog of skills (`SKILL.md` files + `catalog/index.json`). Consumers load from a **local checkout** of the repo — not a live “skills API.”

OpenClaw already supports loading skills from:

- workspace `skills/` folders
- **`skills.load.extraDirs`** (extra directories of `SKILL.md` packs)

**Recommended Phase 1 (minimal fork change):**

1. Keep a pinned checkout of LiNKskills on the Mac Mini.
2. Point Lisa’s OpenClaw config at that catalog via **`extraDirs`** (and/or carefully managed links under her workspace skills).
3. Keep OpenClaw’s **built-in** skills for platform tools.
4. Teach Lisa (and configure allowlists if needed) so **non-platform / studio work prefers LiNKskills**.

This uses OpenClaw’s skill system as-is — we are **not** rewriting it. “Exclusively LiNKskills” stays Phase 2.

**Phase 1 done for skills:** multi-day real use of named LiNKskills skills in her real work (plus an engineering e2e test as a checkpoint, not the finish line).

---

### Same substrate for LiNKdeveloper’s Cursor executor

That executor already injects **vendored** skills into the Cursor agent prompt. Phase 1 should:

1. Resolve studio skills from the **LiNKskills checkout** (same catalog Lisa uses), not only the internal vendored copies.
2. Call the same **LiNKbrain** library: search/load before work; append findings after durable observations.

So Lisa and the Cursor Issue executor share one company brain and one skill catalog — different runtimes, same substrate.

---

### Multi-instance (Lisa → later David)

One `openclaw_prime` codebase; each LiNKbot is a separate instance (own workspace/config/local memory). All share LiNKtrend LiNKbrain + LiNKskills. Cloning Lisa → David = copy instance patterns after Lisa meets the multi-day bar — still local, not VPS.

---

### What we deliberately do **not** do in Phase 1

- Replace dreaming or OpenClaw local memory
- Require exclusive LiNKskills-only
- Build per-bot private LiNKbrain vaults
- Wire external-customer knowledge scopes
- Heavy redesign of OpenClaw’s skill loader

---

### Rough build order (when you approve wiring)

1. **Stage credentials** for LiNKbrain runtime (and Librarian) on this Mac Mini
2. **Brain bridge** for Lisa (plugin/MCP tools) + simple “when to use brain” instructions
3. **Skills path** via LiNKskills checkout + `extraDirs` / workspace skills
4. **Librarian on stage** so promotions can occur
5. **LiNKdeveloper Cursor executor** same brain + LiNKskills load path
6. **Multi-day proof** with Lisa in real CoS/ops work
7. Only then: clone pattern for David

---

### Main risks / gaps to plan for

| Gap                                                           | Why it matters                                                          |
| ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Stage secrets for Lisa’s runtime identity                     | Brain won’t work without them                                           |
| Librarian must actually run on stage                          | Required for your “≥1 promotion” done bar                               |
| LiNKskills “usable” certification still draft for many skills | Load with the consumer flag that allows draft until Librarian certifies |
| Telemetry from Lisa (TS) vs LiNKskills Python runtime         | Nice-to-have in Phase 1; can log simply first                           |
| Choosing which N studio skills Lisa starts with               | Product pick — I recommend you choose 5–10 CoS/ops skills               |

---

### Recommendation in one line

**Adapter, don’t replace:** OpenClaw keeps personal memory + platform tools; LiNKbrain is company read/write via tools; LiNKskills is mounted as another skill directory OpenClaw already knows how to load; LiNKdeveloper’s Cursor executor uses the same two libraries/catalog.

---

If this matches your intent, say so (or note changes). Next step after your approval would be a concrete build plan (which files/config, which skills first, credential checklist) — still no code until you ask to execute.
