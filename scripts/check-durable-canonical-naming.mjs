#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const roots = [
  "src/durable",
  "packages/gateway-protocol/src/schema/durable.ts",
  "src/state",
  "src/commands/durable.ts",
  "src/gateway/server-methods/durable.ts",
];
const forbidden = [
  /ParentWake/g,
  /DurableRuntimeParentWake/g,
  /WakeDeliveryAttempt/g,
  /SideEffectUncertaintyFact/g,
  /parent_wake/g,
  /durable_runtime_parent_wakes/g,
  /durable_runtime_wake_obligations/g,
  /durable_runtime_delivery_attempt_evidence/g,
  /durable_runtime_uncertainty_facts/g,
  /\bdurable_runs\b/g,
  /\bdurable_events\b/g,
  /\bdurable_steps\b/g,
  /\bdurable_refs\b/g,
  /\bdurable_links\b/g,
  /\bdurable_timers\b/g,
  /\bdurable_signals\b/g,
  /\bsource_type\b/g,
  /\bsourceType\b/g,
  /\bcontinuation_cleanup\b/g,
  /\bdedupe_ledger\b/g,
  /\brequires_parent_decision\b/g,
  /\bresult_mailbox\b/g,
];
const files = [];
function walk(p) {
  const st = statSync(p);
  if (st.isDirectory()) {
    for (const e of readdirSync(p)) {
      walk(join(p, e));
    }
  } else if (/\.(ts|tsx|js|mjs|sql|md)$/.test(p)) {
    files.push(p);
  }
}
for (const r of roots) {
  if (existsSync(r)) {
    walk(r);
  }
}
const leaks = [];
for (const f of files) {
  const s = readFileSync(f, "utf8");
  for (const rx of forbidden) {
    let m;
    while ((m = rx.exec(s))) {
      leaks.push(`${f}:${s.slice(0, m.index).split("\n").length}: ${m[0]}`);
    }
  }
}
if (leaks.length) {
  console.error("Forbidden legacy durable naming leaks found:\n" + leaks.join("\n"));
  process.exit(1);
}
console.log(`durable canonical naming guard passed (${files.length} files)`);
