---
summary: Historical Node + tsx "__name is not a function" crash and its cause
read_when:
  - Investigating a tsx/esbuild loader crash that mentions a missing __name helper
title: "Node + tsx crash"
---

# Node + tsx "\_\_name is not a function" crash

## Status

Resolved. This crash does not reproduce on the current `tsx` version pinned in
`package.json` (`4.22.3`) or on current Node releases. Kept here in case a
future `tsx`/esbuild upgrade reintroduces it.

## Original symptom

Running OpenClaw dev scripts through `tsx` failed at startup with:

```text
[openclaw] Failed to start CLI: TypeError: __name is not a function
    at createSubsystemLogger (src/logging/subsystem.ts)
    at <caller> (src/agents/auth-profiles/constants.ts)
```

Line numbers are omitted; both files have changed since the original crash
and the specific lines no longer match.

This appeared after dev scripts switched from Bun to `tsx` (`2871657e`,
2026-01-06) to make Bun optional. The equivalent Bun-based path did not crash.
It was originally observed on Node v25.3.0 on macOS; other platforms that run
Node 25 were considered likely to be affected too.

## Cause

`tsx` transforms TS/ESM through esbuild with `keepNames: true` hardcoded in
its transform options. That setting makes esbuild wrap named function/class
declarations in a call to a `__name` helper so `fn.name` survives minification
and bundling. The crash means the helper was missing or shadowed at the call
site for that module in the affected `tsx`/Node combination, so `__name(...)`
threw instead of returning the wrapped value.

## Current repro check

```bash
node --version
pnpm install
node --import tsx src/entry.ts status
```

Minimal isolated repro (loads only the module from the original stack trace):

```bash
node --import tsx scripts/repro/tsx-name-repro.ts
```

Both commands currently exit cleanly. If either throws `__name is not a
function` again, capture the exact Node version, `tsx` version
(`node_modules/tsx/package.json`), and full stack trace before filing upstream.

## Workarounds (if the crash returns)

- Run dev scripts with Bun instead of `node --import tsx`.
- Run `pnpm tsgo` for type checking, then run the built output instead of the
  source through `tsx`:

  ```bash
  pnpm tsgo
  node openclaw.mjs status
  ```

- Try a different `tsx` version (`pnpm add -D tsx@<version>` is a dependency
  change and needs approval per repo policy) to bisect whether the esbuild
  version it bundles reintroduced the bug.
- Test on a different Node major/minor to see whether the failure is version
  specific.

## References

- [https://esbuild.github.io/api/#keep-names](https://esbuild.github.io/api/#keep-names)
- [https://github.com/evanw/esbuild/issues/1031](https://github.com/evanw/esbuild/issues/1031)

## Related

- [Node.js install](/install/node)
- [Gateway troubleshooting](/gateway/troubleshooting)
