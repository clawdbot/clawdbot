---
title: "v2026.8.1: Memory"
description: "An eligible personal Claw can recall relevant context from that agent's other private conversations, with visible workflows to search, inspect, import, and remove memory."
---

[Memory](/concepts/memory) now lets an eligible personal Claw recall relevant context from that agent's other private conversations, including what mattered immediately before a reset, while visible workflows let you search indexed sources, inspect how memory is working, import supported history, and remove attributable derived memory. Recall stays within the same agent's private conversations and respects explicit isolation and access policy.

Built-in Memory owns the core search and recall path, with a supported Doctor migration from QMD. LanceDB, Memory Wiki, external embedding services, `MEMORY.md`, and `USER.md` still have distinct roles, and forgetting derived memory does not erase the original conversation or copies outside OpenClaw.

<AccordionGroup>

<Accordion title="Upgrading to built-in Memory">

[Built-in Memory](/concepts/memory-builtin) now owns the core search and recall path. If you use [QMD](/concepts/memory-builtin#migrating-from-qmd), run `openclaw doctor --fix` to remove retired QMD settings, carry forward supported extra paths and any session indexing you explicitly enabled, preserve compatible rows already in the agent database, and rebuild the index from canonical Markdown.

The migration carries supported data into a different core, so QMD-only reranking, query expansion, and cross-agent transcript search are retired. Malformed structures, incompatible vector dimensions, and data without a safe owner remain stopped for repair.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Retire QMD and use builtin memory exclusively [#120936](https://github.com/openclaw/openclaw/pull/120936)
- Add a pre-cutover check for missing local embedding setup [#123575](https://github.com/openclaw/openclaw/pull/123575)

**Bug fixes**

- Recover gateway startup from legacy Memory Core index conflicts [#108652](https://github.com/openclaw/openclaw/pull/108652)
- Prevent quadratic Memory Core migrations [#109355](https://github.com/openclaw/openclaw/pull/109355)
- Coordinate QMD writers with SQLite leases [#109636](https://github.com/openclaw/openclaw/pull/109636)
- Recover Memory Core from same-file legacy index conflicts [#110216](https://github.com/openclaw/openclaw/pull/110216)
- Restore upgrades for pre-provenance agent databases [#115144](https://github.com/openclaw/openclaw/pull/115144)
- Prevent malformed Active Memory timestamps from blocking migration [#103116](https://github.com/openclaw/openclaw/pull/103116)
- Let Memory Core upgrades preserve compatible canonical cache rows [#107243](https://github.com/openclaw/openclaw/pull/107243)
- Let Doctor repair legacy memory-index schemas [#115154](https://github.com/openclaw/openclaw/pull/115154)
- Recover Memory Core upgrades with divergent legacy journals [#115855](https://github.com/openclaw/openclaw/pull/115855)
- Keep memory databases compatible with rollback [#116003](https://github.com/openclaw/openclaw/pull/116003)
- Keep memory diagnostics usable during degraded upgrades [#116074](https://github.com/openclaw/openclaw/pull/116074)
- fix(memory): preserve session recall when upgrading from QMD [#130016](https://github.com/openclaw/openclaw/pull/130016)
- Repair legacy memory-search settings without losing tuning [#68685](https://github.com/openclaw/openclaw/pull/68685)
- Prevent oversized workspace files from crashing doctor repairs [#101448](https://github.com/openclaw/openclaw/pull/101448)
- Remove false legacy-memory warnings for empty sidecars [#114661](https://github.com/openclaw/openclaw/pull/114661)
- fix(memory): show canonical-session migration recovery instead of provider error [#119061](https://github.com/openclaw/openclaw/pull/119061)

**Documentation**

- Document automatic migration from QMD memory [#121911](https://github.com/openclaw/openclaw/pull/121911)

</details>

</Accordion>

<Accordion title="Finding and recalling past context">

On eligible personal setups, your Claw can recall relevant context from that same agent's other private conversations by default, including what mattered immediately before you reset the session. Recall remains limited to that agent's private conversations; groups, channels, shared aliases, other agents, deleted history, and policy-blocked sources stay out, and an explicit direct-message isolation setting still wins.

[Built-in search](/concepts/memory-search) now understands filenames, full and partial Unicode paths, and configured extra paths, broadens thin strict matches, and keeps keyword results available when an optional embedding provider cannot start. While memory or session content is being rebuilt, each search stays on one stable published index, and later searches use its replacement only after publication instead of waiting behind routine maintenance or mixing generations. Search stays within the configured roots and agent boundaries, while required embedding providers fail closed.

Sessions without a configured reset policy now remain open across days, and durable reset or compaction markers explain visible history changes. SQLite-backed chats on web, macOS, iOS, and Android can rewind to a user message, [fork the conversation](/concepts/session), and switch among preserved branches. Rewinding changes the transcript branch, but it does not undo files, sent messages, or other tool side effects.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Let personal agents remember across private conversations [#100140](https://github.com/openclaw/openclaw/pull/100140)
- Add per-agent Memory Wiki vault isolation [#103349](https://github.com/openclaw/openclaw/pull/103349)
- Start configured local embedding services on demand [#104306](https://github.com/openclaw/openclaw/pull/104306)
- Find memories by filename and path [#104449](https://github.com/openclaw/openclaw/pull/104449)
- Preserve interrupted-turn context and reopen search-hit history [#105831](https://github.com/openclaw/openclaw/pull/105831)
- Default cross-conversation recall on for personal installs [#110597](https://github.com/openclaw/openclaw/pull/110597)
- Rewind or fork a chat from any user message [#110660](https://github.com/openclaw/openclaw/pull/110660)
- Switch between preserved transcript branches from chat [#110857](https://github.com/openclaw/openclaw/pull/110857)
- Add rewind and fork actions to native chat bubbles [#110886](https://github.com/openclaw/openclaw/pull/110886)
- Keep sessions continuous by default [#111140](https://github.com/openclaw/openclaw/pull/111140)
- Add native session branch switching with safe offline queues [#112056](https://github.com/openclaw/openclaw/pull/112056)
- Add Android chat rewind, fork, and branch switching [#112284](https://github.com/openclaw/openclaw/pull/112284)
- Improve conversational memory recall [#121196](https://github.com/openclaw/openclaw/pull/121196)
- Add glob patterns to extra memory paths [#121209](https://github.com/openclaw/openclaw/pull/121209)
- Enable diverse builtin memory results by default [#121224](https://github.com/openclaw/openclaw/pull/121224)
- Show durable reset and compaction boundaries in chat history [#122222](https://github.com/openclaw/openclaw/pull/122222)
- Support embedding-only managed llama.cpp servers [#125383](https://github.com/openclaw/openclaw/pull/125383)
- fix(llama): support embedding-only managed setup [#130883](https://github.com/openclaw/openclaw/pull/130883)
- Add opt-in persistent sessions for webhook hooks [#75918](https://github.com/openclaw/openclaw/pull/75918)
- Show llama.cpp acceleration and runtime diagnostics [#104310](https://github.com/openclaw/openclaw/pull/104310)
- Add recall-specific fast mode for Active Memory [#108043](https://github.com/openclaw/openclaw/pull/108043)
- Avoid duplicate embeddings during filtered memory recall [#125735](https://github.com/openclaw/openclaw/pull/125735)
- Skip unchanged QMD session export rebuilds [#77158](https://github.com/openclaw/openclaw/pull/77158)
- Prepare active-memory recall context once before launch [061ccb1](https://github.com/openclaw/openclaw/commit/061ccb1)

**Bug fixes**

- Harden embedding batch output and error handling [#103472](https://github.com/openclaw/openclaw/pull/103472)
- Isolate LanceDB memories by agent [#103799](https://github.com/openclaw/openclaw/pull/103799)
- Restore Active Memory recall with SQLite sessions [#105255](https://github.com/openclaw/openclaw/pull/105255)
- Route Active Memory recall through subscription-authenticated Claude CLI [#106840](https://github.com/openclaw/openclaw/pull/106840)
- Block cross-agent Memory Wiki reads from sandboxed sub-agents [#111463](https://github.com/openclaw/openclaw/pull/111463)
- fix(memory-core): keep memory search usable during dirty sync [#112214](https://github.com/openclaw/openclaw/pull/112214)
- Prevent broad memory searches from freezing the gateway [#113359](https://github.com/openclaw/openclaw/pull/113359)
- Prevent overlapping memory embedding providers [#113471](https://github.com/openclaw/openclaw/pull/113471)
- Restore prompt images when rewinding or forking chats [#113945](https://github.com/openclaw/openclaw/pull/113945)
- Keep Codex transcript mirroring responsive as history grows [#115070](https://github.com/openclaw/openclaw/pull/115070)
- Fall back to keyword memory search when embeddings cannot start [#115397](https://github.com/openclaw/openclaw/pull/115397)
- Reuse one Active Memory recall per run [#115627](https://github.com/openclaw/openclaw/pull/115627)
- Index active memory from SQLite while preserving searchable archives [#117334](https://github.com/openclaw/openclaw/pull/117334)
- Restore CJK recall intent in Active Memory [#117419](https://github.com/openclaw/openclaw/pull/117419)
- Warn when memory search results may be stale [#117706](https://github.com/openclaw/openclaw/pull/117706)
- Keep Ollama embedding credentials on their selected host [#118753](https://github.com/openclaw/openclaw/pull/118753)
- Isolate memory fallback provider credentials [#118759](https://github.com/openclaw/openclaw/pull/118759)
- Isolate LanceDB embedding credentials per agent [#118767](https://github.com/openclaw/openclaw/pull/118767)
- Keep private root memory out of shared chats [#119198](https://github.com/openclaw/openclaw/pull/119198)
- Recall private conversation context after a session reset [#122051](https://github.com/openclaw/openclaw/pull/122051)
- Prevent silent context loss during resets and memory search [#125534](https://github.com/openclaw/openclaw/pull/125534)
- Bound LanceDB memory prompts and reload embedding credentials [#125567](https://github.com/openclaw/openclaw/pull/125567)
- fix(memory): isolate sqlite-vec KNN from the event loop [#128078](https://github.com/openclaw/openclaw/pull/128078)
- fix: preserve conversation after memory flush exhaustion [#132010](https://github.com/openclaw/openclaw/pull/132010)
- Restore conversation history to Codex prompt hooks [#101752](https://github.com/openclaw/openclaw/pull/101752)
- Stream Gemini embedding batch output to reduce memory use [#102974](https://github.com/openclaw/openclaw/pull/102974)
- Keep memory batch failure accounting accurate [#103117](https://github.com/openclaw/openclaw/pull/103117)
- Preserve Unicode at QMD memory snippet limits [#103996](https://github.com/openclaw/openclaw/pull/103996)
- Preserve memory-search settings in isolated cron runs [#104196](https://github.com/openclaw/openclaw/pull/104196)
- Isolate local embedding services by runtime [#104741](https://github.com/openclaw/openclaw/pull/104741)
- Keep Gemini memory search available after version upgrades [#104759](https://github.com/openclaw/openclaw/pull/104759)
- fix(active-memory): bound timeout circuit breakers [#105316](https://github.com/openclaw/openclaw/pull/105316)
- Make LanceDB memory initialization safe across processes [#105896](https://github.com/openclaw/openclaw/pull/105896)
- Preserve distinct runs in long native chat histories [#107965](https://github.com/openclaw/openclaw/pull/107965)
- Keep Windows QMD cleanup from blocking the Gateway [#109265](https://github.com/openclaw/openclaw/pull/109265)
- Isolate memory SecretRef failures by agent [#109977](https://github.com/openclaw/openclaw/pull/109977)
- Move Memory Wiki compiled state into plugin-owned SQLite storage [#110167](https://github.com/openclaw/openclaw/pull/110167)
- Reject malformed embedding batch UTF-8 [#110502](https://github.com/openclaw/openclaw/pull/110502)
- Reject malformed UTF-8 in memory-host JSON responses [#111279](https://github.com/openclaw/openclaw/pull/111279)
- Keep Gemini embedding batch waits within the configured timeout [#111674](https://github.com/openclaw/openclaw/pull/111674)
- Keep OpenAI embedding batch polling within its timeout [#111675](https://github.com/openclaw/openclaw/pull/111675)
- Stop repeated memory auto-recall stalls during embedding outages [#112927](https://github.com/openclaw/openclaw/pull/112927)
- Preserve QMD memory hits when document IDs are stale [#113515](https://github.com/openclaw/openclaw/pull/113515)
- Avoid full index rebuilds after empty memory searches [#114183](https://github.com/openclaw/openclaw/pull/114183)
- Stop Memory Core retries immediately on cancellation [#114300](https://github.com/openclaw/openclaw/pull/114300)
- Preserve QMD memory hits when command output is noisy [#115023](https://github.com/openclaw/openclaw/pull/115023)
- Keep memory annotations out of recall and search text [#115719](https://github.com/openclaw/openclaw/pull/115719)
- Reconcile stale memory full-text indexes safely [#115775](https://github.com/openclaw/openclaw/pull/115775)
- fix(active-memory): reject assistant chitchat from recall summary (#84034) [#115803](https://github.com/openclaw/openclaw/pull/115803)
- Preserve Windows memory session ownership across path casing [#115851](https://github.com/openclaw/openclaw/pull/115851)
- Recover queued Memory Core sync work after SQLite failures [#115923](https://github.com/openclaw/openclaw/pull/115923)
- Warm Active Memory before the first channel turn [#115936](https://github.com/openclaw/openclaw/pull/115936)
- Reject malformed and empty embedding vectors [#117200](https://github.com/openclaw/openclaw/pull/117200)
- Keep targeted memory indexing on one session snapshot [#117247](https://github.com/openclaw/openclaw/pull/117247)
- Keep CLI compaction on rotated transcripts [#117250](https://github.com/openclaw/openclaw/pull/117250)
- Honor LM Studio embedding JIT and canonical model identity [#117320](https://github.com/openclaw/openclaw/pull/117320)
- Avoid redundant compaction after reset boundaries [#117400](https://github.com/openclaw/openclaw/pull/117400)
- Recover memory freshness after transcript restores [#117548](https://github.com/openclaw/openclaw/pull/117548)
- Keep OpenAI memory embedding caches stable across upgrades [#117557](https://github.com/openclaw/openclaw/pull/117557)
- Accept command-local agent selection for Memory Wiki [#117943](https://github.com/openclaw/openclaw/pull/117943)
- Keep QMD running after filesystem watcher errors [#118171](https://github.com/openclaw/openclaw/pull/118171)
- Honor keyed agent rosters in Memory Core [#118310](https://github.com/openclaw/openclaw/pull/118310)
- Surface memory-wiki backend read failures [#118449](https://github.com/openclaw/openclaw/pull/118449)
- Keep unrelated session transcripts out of Voice Call fast context [#118498](https://github.com/openclaw/openclaw/pull/118498)
- Honor configured memory providers in CLI searches [#119186](https://github.com/openclaw/openclaw/pull/119186)
- Restore delegated context-engine compaction session identity [#120047](https://github.com/openclaw/openclaw/pull/120047)
- Report persisted vector index state in memory status [#120048](https://github.com/openclaw/openclaw/pull/120048)
- fix(active-memory): keep recall errors out of prompt context [#120658](https://github.com/openclaw/openclaw/pull/120658)
- Keep session reconciliation off the memory-search path [#120837](https://github.com/openclaw/openclaw/pull/120837)
- fix(memory): apply temporal decay to dated files in memory subdirectories [#121103](https://github.com/openclaw/openclaw/pull/121103)
- Preserve memory diversity with project relevance [#121608](https://github.com/openclaw/openclaw/pull/121608)
- Keep multimodal memory indexing limited to extra paths [#121627](https://github.com/openclaw/openclaw/pull/121627)
- Remove stale Memory Core session rows safely at startup [#121665](https://github.com/openclaw/openclaw/pull/121665)
- Restore configured context engines for scheduled turns [#122457](https://github.com/openclaw/openclaw/pull/122457)
- fix(memory-wiki): keep default vaults in configured state directory [#122591](https://github.com/openclaw/openclaw/pull/122591)
- Retain transcript updates during active memory sync [#124024](https://github.com/openclaw/openclaw/pull/124024)
- Keep local memory healthy after a cancelled search [#124051](https://github.com/openclaw/openclaw/pull/124051)
- Stop cancelled memory searches before returning results [#124118](https://github.com/openclaw/openclaw/pull/124118)
- Stop timed-out LanceDB recall before returning results [#124143](https://github.com/openclaw/openclaw/pull/124143)
- Preserve complete startup memory after short file reads [#124597](https://github.com/openclaw/openclaw/pull/124597)
- Preserve memory indexes when source scans fail [#125319](https://github.com/openclaw/openclaw/pull/125319)
- Warn when combined memory search omits the memory corpus [#125500](https://github.com/openclaw/openclaw/pull/125500)
- Preserve conversation history when context assembly fails [#125714](https://github.com/openclaw/openclaw/pull/125714)
- Distinguish missing memory files from empty reads [#125979](https://github.com/openclaw/openclaw/pull/125979)
- Codex transcript mirrors survive matching redaction rules [#126245](https://github.com/openclaw/openclaw/pull/126245)
- Preserve partial results and corpus outcomes in memory tools [#126530](https://github.com/openclaw/openclaw/pull/126530)
- Detect offline memory source drift in status [#126535](https://github.com/openclaw/openclaw/pull/126535)
- Keep Memory guidance aligned with configured sources [#126552](https://github.com/openclaw/openclaw/pull/126552)
- Enforce memory embedding deadlines after event-loop stalls [#126667](https://github.com/openclaw/openclaw/pull/126667)
- Bound Memory Wiki model context [#126779](https://github.com/openclaw/openclaw/pull/126779)
- fix: prevent stale transcript projections from publishing [#126947](https://github.com/openclaw/openclaw/pull/126947)
- fix(tui): recover assistant responses after reconnecting to replacement runs [#128221](https://github.com/openclaw/openclaw/pull/128221)
- fix(embeddings): reject empty vectors from compatible providers [#128480](https://github.com/openclaw/openclaw/pull/128480)
- fix(google): support stable Gemini Embedding 2 request contracts [#128716](https://github.com/openclaw/openclaw/pull/128716)
- fix(llama-cpp): preserve managed local embedding batch capacity [#128721](https://github.com/openclaw/openclaw/pull/128721)
- fix(tui): keep foreign session resets from clearing active chats [#128723](https://github.com/openclaw/openclaw/pull/128723)
- fix(google): support all documented Gemini embedding dimensions [#129038](https://github.com/openclaw/openclaw/pull/129038)
- Preserve document order for indexed embedding responses [#129227](https://github.com/openclaw/openclaw/pull/129227)
- fix(tui): prevent stale session actions from mutating replacement conversations [#129681](https://github.com/openclaw/openclaw/pull/129681)
- fix(memory): recover indexing when embedding providers reject oversized batches [#129927](https://github.com/openclaw/openclaw/pull/129927)
- fix(android): restore rewind and fork for attachment-only messages [#129951](https://github.com/openclaw/openclaw/pull/129951)
- fix(tui): preserve run and session ownership across async events [#130147](https://github.com/openclaw/openclaw/pull/130147)
- fix(embeddings): preserve provider endpoint query parameters [#130211](https://github.com/openclaw/openclaw/pull/130211)
- fix(tui): isolate replacement sessions from stale async results [#130227](https://github.com/openclaw/openclaw/pull/130227)
- fix(memory): stop false Copilot index mismatch warnings [#130603](https://github.com/openclaw/openclaw/pull/130603)
- fix(memory): keep indexing after memory folder replacement [#130698](https://github.com/openclaw/openclaw/pull/130698)
- fix(google): preserve gateway queries in embedding batches [#130768](https://github.com/openclaw/openclaw/pull/130768)
- fix(memory): honor mixed-case embedding header overrides [#130774](https://github.com/openclaw/openclaw/pull/130774)
- fix(doctor): preserve local memory diagnosis [#130984](https://github.com/openclaw/openclaw/pull/130984)
- fix(memory): bound the embedding cache with a built-in default [#131121](https://github.com/openclaw/openclaw/pull/131121)
- fix(active-memory): restore interactive recall and preserve completed results [#131302](https://github.com/openclaw/openclaw/pull/131302)
- fix(memory): ignore vector debt for FTS-only indexes [#131469](https://github.com/openclaw/openclaw/pull/131469)
- fix(tui): retain reset confirmation after history refresh [#131557](https://github.com/openclaw/openclaw/pull/131557)
- fix(llama): honor configured embedding model during setup [#132557](https://github.com/openclaw/openclaw/pull/132557)
- fix(memory): preserve wiki corpus in direct agent scopes [#133234](https://github.com/openclaw/openclaw/pull/133234)
- fix(memory): report only failed index refreshes [#133239](https://github.com/openclaw/openclaw/pull/133239)
- fix(memory): honor configured primary search result limits [#133254](https://github.com/openclaw/openclaw/pull/133254)
- Retry memory embeddings when providers reject dimensions [#69707](https://github.com/openclaw/openclaw/pull/69707)
- Preserve relevance for vector-only multimodal memory results [#92196](https://github.com/openclaw/openclaw/pull/92196)
- Restore same-agent access to unmapped live transcripts [#92261](https://github.com/openclaw/openclaw/pull/92261)
- Preserve useful keyword-only memory results without displacing stronger matches [#92524](https://github.com/openclaw/openclaw/pull/92524)
- Let slow QMD memory searches use their configured timeout [#95757](https://github.com/openclaw/openclaw/pull/95757)
- Keep reset and deleted sessions searchable without a restart [#96132](https://github.com/openclaw/openclaw/pull/96132)
- Keep custom Ollama memory indexes tied to the correct endpoint [#97059](https://github.com/openclaw/openclaw/pull/97059)
- Keep local semantic memory working after Homebrew Node upgrades [#99318](https://github.com/openclaw/openclaw/pull/99318)
- Handle missing files correctly in allowed extra paths [2d06d46](https://github.com/openclaw/openclaw/commit/2d06d46)
- fix(github-copilot): add timeout to embedding model discovery (#102886) [ff15856](https://github.com/openclaw/openclaw/commit/ff15856)
- Reject queued local embedding requests during worker shutdown [#102451](https://github.com/openclaw/openclaw/pull/102451)
- Keep truncated QMD errors valid Unicode [#102547](https://github.com/openclaw/openclaw/pull/102547)
- Keep Active Memory log truncation Unicode-safe [#102551](https://github.com/openclaw/openclaw/pull/102551)
- Keep Active Memory search queries UTF-16 safe [#102621](https://github.com/openclaw/openclaw/pull/102621)
- Keep Active Memory emoji truncation UTF-16 safe [#102877](https://github.com/openclaw/openclaw/pull/102877)
- Accept max thinking in Active Memory configuration [#103614](https://github.com/openclaw/openclaw/pull/103614)
- Skip provider setup for blank memory searches [#103728](https://github.com/openclaw/openclaw/pull/103728)
- Keep memory-host redacted token hints Unicode-safe [#103813](https://github.com/openclaw/openclaw/pull/103813)
- Accept leading-zero lengths in Memory Host JSON responses [#105916](https://github.com/openclaw/openclaw/pull/105916)
- Preserve Unicode text in fragmented QMD output [#107263](https://github.com/openclaw/openclaw/pull/107263)
- Treat memory provider none as intentional FTS-only mode [#107778](https://github.com/openclaw/openclaw/pull/107778)
- Stop stalled Obsidian helpers after 10 seconds [#109232](https://github.com/openclaw/openclaw/pull/109232)
- Preserve thinking and verbose preferences across session rollover [#109788](https://github.com/openclaw/openclaw/pull/109788)
- Keep Voyage embedding batch waits within their timeout [#111673](https://github.com/openclaw/openclaw/pull/111673)
- Stop Memory Wiki doctor errors for keyed agents [#112541](https://github.com/openclaw/openclaw/pull/112541)
- Restore global-session search for non-default agents [#113919](https://github.com/openclaw/openclaw/pull/113919)
- Fully disable derived memory full-text indexes [#115685](https://github.com/openclaw/openclaw/pull/115685)
- Reject malformed QMD memory search results [#115705](https://github.com/openclaw/openclaw/pull/115705)
- Stop memory reads from offering phantom continuation pages [#115722](https://github.com/openclaw/openclaw/pull/115722)
- Return cleanly for blank memory searches [#116034](https://github.com/openclaw/openclaw/pull/116034)
- Stop embedding work after client disconnects [#116146](https://github.com/openclaw/openclaw/pull/116146)
- Suggest reindexing for a missing QMD index [#116958](https://github.com/openclaw/openclaw/pull/116958)
- Reject empty embedding requests before provider setup [#117615](https://github.com/openclaw/openclaw/pull/117615)
- Keep Memory Wiki search within protected recall visibility [#118265](https://github.com/openclaw/openclaw/pull/118265)
- fix(memory): score LIKE-fallback keyword hits as 0 instead of 1 [#120603](https://github.com/openclaw/openclaw/pull/120603)
- fix(memory): a memory_search that hits its own deadline reports a broken embedding provider [#121073](https://github.com/openclaw/openclaw/pull/121073)
- Reject invalid extra memory paths and trim test facades [#121696](https://github.com/openclaw/openclaw/pull/121696)
- Accept Windows casing for explicit memory files [#121976](https://github.com/openclaw/openclaw/pull/121976)
- Return a clear wiki_get error for malformed lookup input [#122549](https://github.com/openclaw/openclaw/pull/122549)
- report clear memory indexing outcomes [#123863](https://github.com/openclaw/openclaw/pull/123863)
- Report indexed SQLite sessions truthfully [#124834](https://github.com/openclaw/openclaw/pull/124834)
- Reject unknown memory agent selections with runnable guidance [#126570](https://github.com/openclaw/openclaw/pull/126570)
- fix(sessions): exclude archived trajectory artifacts [#126912](https://github.com/openclaw/openclaw/pull/126912)
- fix(memory): enforce canonical SecretRef resolution [#127699](https://github.com/openclaw/openclaw/pull/127699)
- fix(memory-wiki): ignore structural markers in query text [#128105](https://github.com/openclaw/openclaw/pull/128105)
- fix(doctor): suppress skipped memory warnings for all agents [#128209](https://github.com/openclaw/openclaw/pull/128209)
- fix(memory): search warns about stale index during session catch-up [#128894](https://github.com/openclaw/openclaw/pull/128894)
- fix(lmstudio): preserve embedding index across API key rotation [#129076](https://github.com/openclaw/openclaw/pull/129076)
- fix(openai): preserve embedding index across proxy key rotation [#129177](https://github.com/openclaw/openclaw/pull/129177)
- fix(openai): preserve Azure embedding index across key rotation [#129516](https://github.com/openclaw/openclaw/pull/129516)
- fix(memory): partition Mistral and DeepInfra embedding caches [#129669](https://github.com/openclaw/openclaw/pull/129669)
- fix(ollama): preserve namespaced embedding query instructions [#129706](https://github.com/openclaw/openclaw/pull/129706)
- fix(memory): suppress wiki not-registered warning for corpus=all (#129866) [#130088](https://github.com/openclaw/openclaw/pull/130088)
- fix(doctor): align memory provider guidance [#130756](https://github.com/openclaw/openclaw/pull/130756)
- fix(memory): indexing fails when provider API key uses a SecretRef [#131351](https://github.com/openclaw/openclaw/pull/131351)
- Fix ordered LanceDB queries with narrowed output columns [#133120](https://github.com/openclaw/openclaw/pull/133120)
- fix: honor embedding dimensions when memory search is disabled [#133158](https://github.com/openclaw/openclaw/pull/133158)

**Documentation**

- Explain overlapping memory recall sources [#118299](https://github.com/openclaw/openclaw/pull/118299)

</details>

</Accordion>

<Accordion title="Importing memories and conversation history">

Importing is separate from the QMD-to-built-in upgrade. You can [bring supported memory](/install/migrating) from Codex, Claude Code, or Hermes into an agent workspace through the Control UI, first-run setup, or Ask OpenClaw while leaving the source alone and not sweeping in credentials, settings, skills, or arbitrary provider files. If the destination already contains conflicting content, replacement has to be reviewed explicitly.

Old conversations follow their own preview-first path. The CLI shows what it would stage before it writes, the Control UI reports bounded-batch progress, and material owned by that import can be rolled back and applied again. Large histories use bounded or indexed processing, Memory Wiki preserves human notes through supported imports, and older history without complete ownership tracking may need to be rescanned. Staged material still does not become durable memory until dreaming or an explicit promotion chooses it.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Import Codex and Claude Code memory from the Control UI [#106406](https://github.com/openclaw/openclaw/pull/106406)
- Offer memory imports during onboarding [#108977](https://github.com/openclaw/openclaw/pull/108977)
- Backfill retained session transcripts into memory staging [#115162](https://github.com/openclaw/openclaw/pull/115162)
- Backfill memory from past sessions in Control UI [#115266](https://github.com/openclaw/openclaw/pull/115266)
- Import local agent memories from Ask OpenClaw [#115376](https://github.com/openclaw/openclaw/pull/115376)
- Lower Memory Core startup memory use [#119372](https://github.com/openclaw/openclaw/pull/119372)

**Bug fixes**

- Preserve Memory Wiki notes when imported pages are pruned [#102294](https://github.com/openclaw/openclaw/pull/102294)
- Bound large SQLite session-history reads [#108851](https://github.com/openclaw/openclaw/pull/108851)
- Harden memory migration path resolution and file copying [#109314](https://github.com/openclaw/openclaw/pull/109314)
- Preserve Memory Wiki pages during temporary source outages [#111034](https://github.com/openclaw/openclaw/pull/111034)
- Preserve Memory Wiki edits during ChatGPT import rollback [#116517](https://github.com/openclaw/openclaw/pull/116517)
- Preserve Memory Wiki notes when markers are damaged [#117104](https://github.com/openclaw/openclaw/pull/117104)
- Protect Memory Wiki notes and private recall boundaries [#118375](https://github.com/openclaw/openclaw/pull/118375)
- Keep Gateway RPCs responsive after startup [#119710](https://github.com/openclaw/openclaw/pull/119710)
- Keep large chat histories from blocking startup [#124994](https://github.com/openclaw/openclaw/pull/124994)
- Keep large CLI-bound chat histories responsive [#126201](https://github.com/openclaw/openclaw/pull/126201)
- fix(agents): wait for deferred transcript projection before reopening the session [#130930](https://github.com/openclaw/openclaw/pull/130930)
- Prevent Memory Wiki source ingest from losing content during concurrent writes [#104209](https://github.com/openclaw/openclaw/pull/104209)
- Harden memory migration plan selection and apply safety [#109323](https://github.com/openclaw/openclaw/pull/109323)
- Redact Claude CLI history before Control UI merge [#115597](https://github.com/openclaw/openclaw/pull/115597)
- Make memory session backfill complete and reversible [#115926](https://github.com/openclaw/openclaw/pull/115926)
- Preserve Memory Core transcript-ingestion checkpoints [#117293](https://github.com/openclaw/openclaw/pull/117293)
- Prevent duplicate Claude CLI replies after reload [#125030](https://github.com/openclaw/openclaw/pull/125030)
- fix(memory-wiki): persist ChatGPT import run record before compiling the vault [#126487](https://github.com/openclaw/openclaw/pull/126487)
- Stop duplicate Memory Wiki imports during polling [#91828](https://github.com/openclaw/openclaw/pull/91828)
- Make legacy session backfill rollback re-applicable [#116004](https://github.com/openclaw/openclaw/pull/116004)
- fix(gateway): chat history shows injected skill instructions on claude-cli sessions [#130269](https://github.com/openclaw/openclaw/pull/130269)
- fix(gateway): images sent to Claude CLI sessions show as raw cache-path links in chat history [#130463](https://github.com/openclaw/openclaw/pull/130463)

</details>

</Accordion>

<Accordion title="Reviewing, creating, and forgetting memories">

Settings now has a [Memory destination](/concepts/memory) for live status, Dreams, configuration, indexed-source search and browsing, add-on controls, and embedding readiness, so you can see what your Claw has available and open safe workspace memory files. Memory Wiki overview and Imported Insights dashboards now read published snapshots instead of reparsing the whole vault for every request, keeping large views responsive and showing when a rebuild is running or a manual compile is required. Session and legacy sources remain snippet-only, and add-on changes remain read-only unless the connection has admin authorization.

Eligible observations can be consolidated into `MEMORY.md`, durable directives can live in `USER.md`, standing intents can wait for the right event, and project memories stay scoped to the project that produced them. Automatic memory remains bounded and provenance-gated, so content derived from network or restricted sessions keeps an untrusted origin and stays out of automatic context even though an explicit search can still surface it. This provenance protection applies to newly tracked material, while older untracked files retain their existing classification.

[`openclaw memory forget`](/cli/memory) lets you preview a purge by session, hook source, or participant, then remove attributable derived memory and stop the selected session from being pulled back in by backfill, indexing, or dreaming. An interrupted purge can be retried, and newly attributable consolidation or backfill diary claims are removed with the selected session. The purge follows recorded provenance, so the original transcript, older lineage-free notes, other agents' stores, direct or external writes, exports, and backups may remain. Review the preview before applying it.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Add a dedicated Memory settings page [#114037](https://github.com/openclaw/openclaw/pull/114037)
- Add provenance-gated memory and default-on dreaming [#114819](https://github.com/openclaw/openclaw/pull/114819)
- Give Memory a live overview, Dreams, and Settings [#115383](https://github.com/openclaw/openclaw/pull/115383)
- Add memory search and browsing to Settings [#115419](https://github.com/openclaw/openclaw/pull/115419)
- Isolate curated memory by project [#115438](https://github.com/openclaw/openclaw/pull/115438)
- Add inline controls and readiness checks to Memory settings [#115557](https://github.com/openclaw/openclaw/pull/115557)
- Retain recent project memory scopes within a session [#115731](https://github.com/openclaw/openclaw/pull/115731)
- feat(memory): session provenance, admission policy, and openclaw memory forget [#130151](https://github.com/openclaw/openclaw/pull/130151)
- Add operator-scoped memory search to the gateway [#115346](https://github.com/openclaw/openclaw/pull/115346)
- Rename Memory Palace to Memory Wiki and document it [#115954](https://github.com/openclaw/openclaw/pull/115954)
- Align the Memory page and simplify agent selection [#115884](https://github.com/openclaw/openclaw/pull/115884)

**Bug fixes**

- Protect long-term memory during failed automatic promotions [#108397](https://github.com/openclaw/openclaw/pull/108397)
- Restore per-agent Memory Core dream diaries [#115069](https://github.com/openclaw/openclaw/pull/115069)
- Keep dreaming consolidation within project boundaries [#115721](https://github.com/openclaw/openclaw/pull/115721)
- Quarantine memory writes from network-tainted agent turns [#115818](https://github.com/openclaw/openclaw/pull/115818)
- Preserve user-authored headings during MEMORY.md compaction [#116057](https://github.com/openclaw/openclaw/pull/116057)
- Preserve user notes during MEMORY.md budget compaction [#116180](https://github.com/openclaw/openclaw/pull/116180)
- Mark post-network provider memory writes as untrusted [#118760](https://github.com/openclaw/openclaw/pull/118760)
- Keep synthetic handoffs out of trusted owner memory [#118987](https://github.com/openclaw/openclaw/pull/118987)
- Correct false memory save and forget claims [#120989](https://github.com/openclaw/openclaw/pull/120989)
- Publish Memory Core dreaming reports atomically [#122343](https://github.com/openclaw/openclaw/pull/122343)
- Revoke retained memory tools after memory is disabled [#125393](https://github.com/openclaw/openclaw/pull/125393)
- Enforce turn tool policy during automatic memory recall [#126482](https://github.com/openclaw/openclaw/pull/126482)
- Preserve memory trust across session capture and dreaming [#126489](https://github.com/openclaw/openclaw/pull/126489)
- fix(memory): respect provenance in automatic context [#127469](https://github.com/openclaw/openclaw/pull/127469)
- fix(memory): prevent forgotten session content from returning [#130451](https://github.com/openclaw/openclaw/pull/130451)
- fix(memory): forgotten content survives retries and consolidation [#131179](https://github.com/openclaw/openclaw/pull/131179)
- fix(memory-wiki): publish dashboard snapshots [#132296](https://github.com/openclaw/openclaw/pull/132296)
- Keep emoji intact in startup memory and heartbeat prompts [#102483](https://github.com/openclaw/openclaw/pull/102483)
- Keep compaction and memory snippets Unicode-safe [#102542](https://github.com/openclaw/openclaw/pull/102542)
- Prevent partial Memory Wiki failures during concurrent writes [#103408](https://github.com/openclaw/openclaw/pull/103408)
- fix(memory-core): dreaming narrative subagent receives full generic prompt instead of minimal [#106404](https://github.com/openclaw/openclaw/pull/106404)
- Prevent raw output from breaking Tokenjuice compaction [#107705](https://github.com/openclaw/openclaw/pull/107705)
- Preserve linked MEMORY.md files during automatic promotion [#108921](https://github.com/openclaw/openclaw/pull/108921)
- Keep heartbeat replies out of new Dreaming memories [#109403](https://github.com/openclaw/openclaw/pull/109403)
- Keep invalid recall timestamps out of dreaming rankings [#110537](https://github.com/openclaw/openclaw/pull/110537)
- Preserve provider routing during safeguard compaction [#112416](https://github.com/openclaw/openclaw/pull/112416)
- Bound compaction-planning worker payloads [#112593](https://github.com/openclaw/openclaw/pull/112593)
- Keep memory-maintenance turns out of chat [#112942](https://github.com/openclaw/openclaw/pull/112942)
- Keep media presentation markers out of LanceDB memories [#113145](https://github.com/openclaw/openclaw/pull/113145)
- Correct the Dreaming toggle confirmation [#113960](https://github.com/openclaw/openclaw/pull/113960)
- Remove dangling Memory Core recall records during repair [#114419](https://github.com/openclaw/openclaw/pull/114419)
- Recover memory dreaming Cron after startup failure [#115174](https://github.com/openclaw/openclaw/pull/115174)
- Give Memory settings stable path-based tab URLs [#115515](https://github.com/openclaw/openclaw/pull/115515)
- Promote durable memories at calibrated defaults [#115715](https://github.com/openclaw/openclaw/pull/115715)
- Make Memory engine switching clear and reliable [#115750](https://github.com/openclaw/openclaw/pull/115750)
- Preserve network-content taint across transcript runtimes [#115850](https://github.com/openclaw/openclaw/pull/115850)
- Stabilize memory-core dreaming schedules and cleanup [#115925](https://github.com/openclaw/openclaw/pull/115925)
- Remove duplicate Memory Dreaming jobs after copied installs [#115986](https://github.com/openclaw/openclaw/pull/115986)
- Honor user timezone in session-memory files [#116136](https://github.com/openclaw/openclaw/pull/116136)
- Prevent memory flush from ending the parent session [#116198](https://github.com/openclaw/openclaw/pull/116198)
- fix(memory-core): filter junk topics from REM phase extraction (#111923) [#117248](https://github.com/openclaw/openclaw/pull/117248)
- Prevent stalled Git lookups from hanging agent runs [#117346](https://github.com/openclaw/openclaw/pull/117346)
- Keep Dreams data with the selected agent [#117538](https://github.com/openclaw/openclaw/pull/117538)
- Clean up interrupted Dreaming sessions after restart [#117885](https://github.com/openclaw/openclaw/pull/117885)
- Keep valid memory diagnostics ahead of malformed timestamps [#118749](https://github.com/openclaw/openclaw/pull/118749)
- Keep memory-flush appends from ending in bridge errors [#120404](https://github.com/openclaw/openclaw/pull/120404)
- Keep replies running when memory flush preparation fails [#121157](https://github.com/openclaw/openclaw/pull/121157)
- Preserve the previous Memory Wiki lint report on write failure [#122568](https://github.com/openclaw/openclaw/pull/122568)
- CLI and Gateway agent turns now flush memory [#124964](https://github.com/openclaw/openclaw/pull/124964)
- Keep session-memory filename generation tool-free [#125394](https://github.com/openclaw/openclaw/pull/125394)
- Keep Dream Diary data scoped to the active agent [#125936](https://github.com/openclaw/openclaw/pull/125936)
- fix(memory-core): restore MEMORY.md when the in-place fallback write fails midway [#126486](https://github.com/openclaw/openclaw/pull/126486)
- fix(memory-core): read dreaming narrative from the terminal reply instead of racing the session store (#123360) [#127184](https://github.com/openclaw/openclaw/pull/127184)
- fix(agents): stop cancelled compactions before model requests [#128215](https://github.com/openclaw/openclaw/pull/128215)
- fix(agents): prevent model requests after context processing is cancelled [#128607](https://github.com/openclaw/openclaw/pull/128607)
- fix(compaction): share model-aware memory maintenance budgets [#130072](https://github.com/openclaw/openclaw/pull/130072)
- fix(memory): stop suggesting unavailable scheduling tools [#130128](https://github.com/openclaw/openclaw/pull/130128)
- fix(memory): preserve line endings when forgetting entries [#130943](https://github.com/openclaw/openclaw/pull/130943)
- fix(memory): forgotten facts survive in consolidation history [#131248](https://github.com/openclaw/openclaw/pull/131248)
- fix(memory): forget diary claims after session backfill [#131626](https://github.com/openclaw/openclaw/pull/131626)
- fix(memory): preserve session excerpts across resets [#132757](https://github.com/openclaw/openclaw/pull/132757)
- Save session memory on automatic rollover [#61675](https://github.com/openclaw/openclaw/pull/61675)
- Prevent nested compaction from locking its own transcript [#88919](https://github.com/openclaw/openclaw/pull/88919)
- Honor the configured model for session-memory slugs [#97007](https://github.com/openclaw/openclaw/pull/97007)
- Contain forged role lines in session-memory records [#98574](https://github.com/openclaw/openclaw/pull/98574)
- Preserve valid Unicode in Memory Core dreaming snippets [#101946](https://github.com/openclaw/openclaw/pull/101946)
- Keep Talk memory snippets valid at emoji boundaries [#102477](https://github.com/openclaw/openclaw/pull/102477)
- Keep truncated memory snippets valid around emoji [#102478](https://github.com/openclaw/openclaw/pull/102478)
- Preserve emoji when truncating dream-diary context [#102524](https://github.com/openclaw/openclaw/pull/102524)
- Keep memory-wiki terminal truncation Unicode-safe [#103178](https://github.com/openclaw/openclaw/pull/103178)
- Strictly parse Dreaming integer settings [#107619](https://github.com/openclaw/openclaw/pull/107619)
- Reject invalid agent targets in memory doctor calls [#115365](https://github.com/openclaw/openclaw/pull/115365)
- Preserve complete Unicode characters during memory promotion [#115591](https://github.com/openclaw/openclaw/pull/115591)
- Preserve descriptive session-memory filenames after manual resets [#116094](https://github.com/openclaw/openclaw/pull/116094)
- Keep Dreams diary navigation visible while scrolling [#118054](https://github.com/openclaw/openclaw/pull/118054)
- Let memory-backed CLI commands exit naturally [#118500](https://github.com/openclaw/openclaw/pull/118500)
- Return validation errors for malformed wiki_apply input [#123050](https://github.com/openclaw/openclaw/pull/123050)
- Report failed Memory Core repairs and skipped promotions accurately [#124770](https://github.com/openclaw/openclaw/pull/124770)
- Keep the Memory hub header stable across tabs [#125568](https://github.com/openclaw/openclaw/pull/125568)
- Stop warning for expected non-owner memory-tool gating [#126679](https://github.com/openclaw/openclaw/pull/126679)
- test(agents): bind process registry cleanup to its module instance [#129456](https://github.com/openclaw/openclaw/pull/129456)
- Show total signals in memory promotion audit output [#87590](https://github.com/openclaw/openclaw/pull/87590)

**Documentation**

- docs(memory): add memory provenance and deletion concepts page [#130278](https://github.com/openclaw/openclaw/pull/130278)
- Align proactivity and memory docs with shipped behavior [#112295](https://github.com/openclaw/openclaw/pull/112295)
- docs(memory): document shipped turn-taint propagation for network tool output [#129837](https://github.com/openclaw/openclaw/pull/129837)

</details>

</Accordion>

</AccordionGroup>
