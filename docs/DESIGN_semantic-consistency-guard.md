# Semantic Consistency Guard: Integration Design

## Architecture

```
User Message ──► get-reply.ts ──► Agent Runner (LLM) ──► Reply Text ──► prepare-delivery.ts
                                                                              │
                                                                     ┌────────▼────────┐
                                                                     │ Semantic Guard   │
                                                                     │ (pre-delivery)   │
                                                                     └────────┬────────┘
                                                                              │
                                                              ┌───────────────┼───────────────┐
                                                              │ pass through   │ drift detected │
                                                              ▼                ▼                │
                                                         Channel Output    Correction        │
                                                                           Prompt ──► Agent  │
                                                                           re-generates ──────┘
```

## Files Changed

1. **NEW: `src/auto-reply/semantic-consistency-guard.ts`**
   - Core guard logic: pattern detection, definition extraction, consistency checking
   - Pure functions, zero dependencies beyond Node.js stdlib
   - Exported: `checkConsistency()`, `hasContrastStructure()`, types

2. **NEW: `src/auto-reply/semantic-consistency-guard.test.ts`**
   - Vitest unit tests covering: pattern detection, drift detection, pass-through, edge cases, performance

3. **NEW: `src/auto-reply/semantic-consistency-guard.smoke-test.cjs`**
   - Standalone CommonJS smoke test (no vitest needed) for quick validation

4. **MODIFIED: `src/auto-reply/dispatch-from-config.prepare-delivery.ts`**
   - Integrates the guard into the pre-delivery phase
   - Reads `guard.semanticConsistency` from OpenClaw config (default enabled)
   - When drift detected: suppresses the payload and injects a system correction message
   - Max 1 retry per reply to prevent infinite loops
   - Only activates when user message contains contrast structures (99% pass-through)

5. **NEW: `docs/ISSUE_semantic-consistency-guard.md`**
   - Full issue writeup with problem statement, solution design, and implementation plan

## Integration Patch (conceptual)

```typescript
// In dispatch-from-config.prepare-delivery.ts, add after reply text is gathered:
import { checkConsistency, hasContrastStructure } from "./semantic-consistency-guard.js";

// Inside the prepare-for-delivery flow, after agent reply is complete:
if (hasContrastStructure(lastUserMessageText)) {
  const guardResult = checkConsistency(
    agentReplyText,
    lastUserMessageText,
    config.guard?.semanticConsistency,
  );
  if (guardResult.drifted && retryCount < maxRetries) {
    // Inject correction system message, retry agent generation
    injectCorrectionSystemMessage(guardResult.correctionMessage);
    return { status: "retry", correction: guardResult };
  }
}
```

## Configuration (example in OpenClaw config)

```yaml
guard:
  semanticConsistency:
    enabled: true
    threshold: 0.3
    maxRetries: 1
```
