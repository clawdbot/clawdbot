# Engineering Execution Spec: groupPolicy Hardening (Telegram Allowlist Parity)

**Date**: 2026-01-05  
**Status**: Complete  
**PR**: #216 (feat/whatsapp-group-policy)

---

## Executive Summary

Follow-up hardening work ensures Telegram allowlists behave consistently across inbound group/DM filtering and outbound send normalization. The focus is on prefix parity (`telegram:` / `tg:`), case-insensitive matching for prefixes, and resilience to accidental whitespace in config entries. Documentation and tests were updated to reflect and lock in this behavior.

---

## Findings Analysis

### [MED] F1: Telegram Allowlist Prefix Handling Is Case-Sensitive and Excludes `tg:`

**Location**: `src/telegram/bot.ts`

**Problem**: Inbound allowlist normalization only stripped a lowercase `telegram:` prefix. This rejected `TG:123` / `Telegram:123` and did not accept the `tg:` shorthand even though outbound send normalization already accepts `tg:` and case-insensitive prefixes.

**Impact**:
- DMs and group allowlists fail when users copy/paste prefixed IDs from logs or existing send format.
- Behavior is inconsistent between inbound filtering and outbound send normalization.

**Fix**: Normalize allowlist entries by trimming whitespace and stripping `telegram:` / `tg:` prefixes case-insensitively at pre-compute time.

---

### [LOW] F2: Allowlist Entries Are Not Trimmed

**Location**: `src/telegram/bot.ts`

**Problem**: Allowlist entries are not trimmed; accidental whitespace causes mismatches.

**Fix**: Trim and drop empty entries while normalizing allowlist inputs.

---

## Implementation Phases

### Phase 1: Normalize Telegram Allowlist Inputs

**File**: `src/telegram/bot.ts`

**Changes**:
1. Trim allowlist entries and drop empty values.
2. Strip `telegram:` / `tg:` prefixes case-insensitively.
3. Simplify DM allowlist check to rely on normalized values.

---

### Phase 2: Add Coverage for Prefix + Whitespace

**File**: `src/telegram/bot.test.ts`

**Add Tests**:
- DM allowlist accepts `TG:` prefix with surrounding whitespace.
- Group allowlist accepts `TG:` prefix case-insensitively.

---

### Phase 3: Documentation Updates

**Files**:
- `docs/groups.md`
- `docs/telegram.md`

**Changes**:
- Document `tg:` alias and case-insensitive prefixes for Telegram allowlists.

---

### Phase 4: Verification

1. Run targeted Telegram tests (`pnpm test -- src/telegram/bot.test.ts`).
2. If time allows, run full suite (`pnpm test`).

---

## Files Modified

| File | Change Type | Description |
|------|-------------|-------------|
| `src/telegram/bot.ts` | Fix | Trim allowlist values; strip `telegram:` / `tg:` prefixes case-insensitively |
| `src/telegram/bot.test.ts` | Test | Add DM + group allowlist coverage for `TG:` prefix + whitespace |
| `docs/groups.md` | Docs | Mention `tg:` alias + case-insensitive prefixes |
| `docs/telegram.md` | Docs | Mention `tg:` alias + case-insensitive prefixes |

---

## Success Criteria

- [x] Telegram allowlist accepts `telegram:` / `tg:` prefixes case-insensitively.
- [x] Telegram allowlist tolerates whitespace in config entries.
- [x] DM and group allowlist tests cover prefixed cases.
- [x] Docs updated to reflect allowlist formats.
- [x] Targeted tests pass.
- [x] Full test suite passes.

---

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Behavior change for malformed entries | Low | Normalization is additive and trims only whitespace |
| Test fragility | Low | Isolated unit tests; no external dependencies |
| Doc drift | Low | Updated docs alongside code |

---

## Estimated Complexity

- **Phase 1**: Low (normalization helpers)
- **Phase 2**: Low (2 new tests)
- **Phase 3**: Low (doc edits)
- **Phase 4**: Low (verification)

**Total**: ~20 minutes
