# UI cleanup observation

This temporary branch observes the original UI CI integration 0249635cbf06cce81e5877f403ca619b5f42847e (base ec46a506639c900156edfb58e4ee4b8458536f7e plus UI head 2425a5ab4beff8f5b8be94e1250df3248c325d3b). It is not a product repair or a replacement CI result.

Run the original first 132-file group once on Ubuntu 24.04 and Node 24.20.0, preserving file order, worker count, assertions and deadlines. The later group was not reached after the original failure and is excluded. Restore the exact recorded pnpm/V8 cache entries if retained; record misses. The original transform cache missed, so start that cache empty with its verified configuration generation. No dependency tree or built product artifact is restored.

Synchronous markers at existing boundaries record full errors, admission, deadline, cleanup, transaction return, source snapshots and handler completion. The original promises and concurrent waits remain. Logging adds CPU and I/O cost and may affect timing; no claim of zero observer effect is made. A committed marker means the transaction helper returned after successful commit and post-commit work; its absence alone does not prove rollback.

A pass without delayed deletion ends this attempt and does not explain the historical failure. Preserve full output. Do not rerun unchanged observations or publish this instrumentation as the marker repair.
