# Continuation tools infographics

Three SVG reviewer aids for the continuation feature. Each one keeps the tool story visual and low-text, with a Mermaid fallback underneath for quick diff review.

## `continue_work()` — same-session successor turn

![continue_work infographic](../assets/continuation-tools/continue-work.svg)

```mermaid
flowchart LR
    A["Current OpenClaw turn<br/>model + tools + task state"] --> B{"Agent elects<br/>continue_work?"}
    B -- no --> Z["DONE<br/>ordinary turn end"]
    B -- yes --> C["Tool call<br/>continue_work(delaySeconds?, reason?)"]
    C --> D["Current turn finishes normally"]
    D --> E["TaskFlow row<br/>continuation_work<br/>sessionKey + dueAt + hop + budget + reason"]
    E --> F{Due time matures}
    F -- session idle --> G["Same session gets<br/>continuation:wake"]
    F -- session active --> H["Trusted<br/>system:continuation-note<br/>folded into active turn"]
    G --> I["Successor re-evaluates<br/>before acting"]
    H --> I

    Guard["Guards:<br/>continuation.enabled<br/>maxChainLength<br/>costCapTokens<br/>min/max delay<br/>human interrupt/reset"]
    Guard -. bounds .-> C
    Guard -. bounds .-> E
```

**Read as:** “I am not done yet; wake this same session later.” It is one elected successor turn, not an in-turn loop.

## `continue_delegate()` — child worker shard and return routing

![continue_delegate infographic](../assets/continuation-tools/continue-delegate.svg)

```mermaid
flowchart LR
    P["Parent session<br/>sees work + cost + context"] --> C{"One or many<br/>continue_delegate calls"}
    C --> Q["TaskFlow pending delegate queue<br/>task + delay + mode + model? + return target"]
    Q --> A["Fresh child session A"]
    Q --> B["Fresh child session B"]
    Q --> D["Fresh child session C"]

    A --> R["Completion envelope"]
    B --> R
    D --> R

    R --> M{"Return mode"}
    M -- normal --> N["Visible announce<br/>+ wake parent"]
    M -- silent --> S["Silent system-event enrichment<br/>no immediate wake"]
    M -- silent-wake --> W["Silent enrichment<br/>+ delegate-return wake"]
    M -- post-compaction --> X["Stage until compaction<br/>release into successor"]

    R --> T{"Return target"}
    T -- default --> TP["Dispatching session"]
    T -- targetSessionKey --> TS["One named same-host session"]
    T -- targetSessionKeys --> TM["Multiple named sessions"]
    T -- fanout tree --> TT["Ancestors in chain"]
    T -- fanout all --> TA["All known host sessions"]

    G["Guards:<br/>maxDelegatesPerTurn<br/>maxChainLength<br/>costCapTokens<br/>leaf-subagent deny<br/>crossSessionTargeting default-deny"] -. bounds .-> C
    G -. gates .-> T
```

**Read as:** “Spin out this shard to a fresh child worker; route the result as normal chatter, silent enrichment, silent-wake, or post-compaction recovery.” The task goes to the child; the completion envelope is what is routed.

## `request_compaction()` — elective compaction seam

![request_compaction infographic](../assets/continuation-tools/request-compaction.svg)

```mermaid
flowchart LR
    A["Context pressure rises<br/>advisory system event"] --> B["Agent prepares state<br/>notes · files · recovery plan"]
    B --> C["Optionally stage<br/>post-compaction delegates"]
    C --> D{"Agent calls<br/>request_compaction()"}
    D --> E["Tool enqueues compaction<br/>and returns immediately"]
    E --> F["Current turn finishes normally"]
    F --> G["Platform compacts<br/>current session only"]
    G --> H["Successor turn rehydrates<br/>boot files + staged returns + chosen working state"]

    N1["No response-token fallback"] -. tool-only .-> D
    N2["Child compacts itself,<br/>not its parent"] -. isolation .-> G
    N3["Async: not immediate<br/>inside active turn"] -. boundary .-> F
```

**Read as:** “Let me choose the seam before overflow.” The session stages what future-it should inherit, then asks the platform to compact between turns.

## One-screen comparison

| Tool                   | Elective choice          | Work goes to              | Return / successor shape                                            | Main guardrails                                   |
| ---------------------- | ------------------------ | ------------------------- | ------------------------------------------------------------------- | ------------------------------------------------- |
| `continue_work()`      | Continue this task later | Same session              | `[continuation:wake]` or active-turn continuation note              | opt-in, chain cap, cost cap, delay bounds         |
| `continue_delegate()`  | Shard this work outward  | Fresh child session(s)    | normal, silent, silent-wake, or post-compaction completion envelope | width cap, chain cap, cost cap, targeting gate    |
| `request_compaction()` | Compact at a chosen seam | Current session lifecycle | successor session receives prepared context after compaction        | tool-only, current-session-only, async after turn |
