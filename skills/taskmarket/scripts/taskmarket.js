#!/usr/bin/env node
// taskmarket.js — TaskMarket (api.taskmarket.dev) delegation wrapper for the
// taskmarket OpenClaw skill. Wraps the first-party `taskmarket` CLI, which owns
// wallet/signing/payment/idempotency handling. Zero additional dependencies.
//
// Usage:
//   node taskmarket.js browse [--limit N]       # public, no spend
//   node taskmarket.js track                     # public, no spend
//   node taskmarket.js review <taskId>           # public, no spend
//   node taskmarket.js create "<description>" <rewardUsdc> <durationHours> [tags] [--confirm]
//   node taskmarket.js submit <taskId> "<message>" <file>... [--confirm]
//
// Write actions (create/submit) require an explicit --confirm flag; the
// authorization gate is enforced in code, not just prose. Exit codes:
//   0 success | 2 bad usage | 3 not authorized | 4 cli/network error
import { execFileSync } from 'child_process';

function exit(code, msg) {
  if (msg) console.error(msg);
  process.exit(code);
}

function cli(args) {
  try {
    const out = execFileSync('taskmarket', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, out: String(out || '') };
  } catch (e) {
    return { ok: false, out: String(e.stdout || ''), err: String(e.stderr || e.message || '').slice(0, 300) };
  }
}

function parseJson(out) {
  try { return JSON.parse(out); } catch { return null; }
}

async function browse(limit) {
  const n = Number(limit) || 20;
  const r = cli(['task', 'list', '--status', 'open', '--limit', String(n)]);
  if (!r.ok) exit(4, 'taskmarket list failed: ' + r.err);
  const data = parseJson(r.out);
  const tasks = (data && data.ok && data.data && data.data.tasks) || (data && data.data && data.data.tasks) || [];
  if (!tasks.length) { console.log('(no open tasks returned)'); return; }
  tasks.sort((a, b) => (a.submissionCount || 0) - (b.submissionCount || 0));
  for (const t of tasks.slice(0, n)) {
    const id = String(t.id || '').slice(0, 8);
    const title = (t.description || '').split('\n')[0].slice(0, 60);
    const reward = Number(t.reward || 0) / 1e6;
    console.log(`${id} reward=$${reward.toFixed(2)} subs=${t.submissionCount || 0} expiry=${(t.expiryTime || '').slice(0, 10)} | ${title}`);
  }
}

async function track() {
  const r = cli(['inbox']);
  if (!r.ok) exit(4, 'taskmarket inbox failed: ' + r.err);
  const data = parseJson(r.out);
  console.log('--- tasks we created / are working on ---');
  if (data && data.ok && data.data) {
    const d = data.data;
    const req = d.asRequester || [];
    const worker = d.asWorker || [];
    console.log(`asRequester: ${req.length} | asWorker: ${worker.length}`);
    for (const t of req.slice(0, 10)) console.log(`  [requester] ${String(t.taskId || t.id || '').slice(0, 12)} ${t.status || ''}`);
    for (const t of worker.slice(0, 10)) console.log(`  [worker]    ${String(t.taskId || t.id || '').slice(0, 12)} ${t.status || ''}`);
  } else {
    console.log(String(r.out).slice(0, 800));
  }
  const a = cli(['actions']);
  if (a.ok) {
    const ad = parseJson(a.out);
    console.log('--- lifecycle actions awaiting us ---');
    if (ad && ad.ok && ad.data) {
      const items = (ad.data.items || []).concat(ad.data.waiting || []);
      console.log(`actions: ${items.length}`);
      for (const it of items.slice(0, 10)) {
        const taskId = (it.task && it.task.id) || it.id || '';
        console.log(`  ${String(taskId).slice(0, 12)} ${it.reason || it.status || ''}`);
      }
    }
  }
}

async function review(taskId) {
  if (!taskId) exit(2, 'review requires <taskId>');
  // Prefer the submissions listing; fall back to actions.
  const r = cli(['task', 'submissions', taskId]);
  if (r.ok && r.out.trim()) {
    console.log(String(r.out).slice(0, 3000));
    return;
  }
  const a = cli(['actions']);
  if (a.ok) console.log(String(a.out).slice(0, 3000));
  else exit(4, 'no submissions endpoint available: ' + (r.err || a.err));
}

async function create(args) {
  const [description, reward, duration, tags] = args.filter((a) => a !== '--confirm');
  if (!args.includes('--confirm')) {
    exit(3, 'TASKMARKET_NOT_AUTHORIZED: create requires explicit --confirm after showing the operator a preview (description, reward, duration)');
  }
  if (!description || !reward || !duration) exit(2, 'create requires "<description>" <rewardUsdc> <durationHours> [tags] [--confirm]');
  const cliArgs = ['task', 'create', '--description', description, '--reward', String(reward), '--duration', String(duration)];
  if (tags) cliArgs.push('--tags', String(tags));
  const r = cli(cliArgs);
  if (!r.ok) exit(4, 'taskmarket create failed: ' + r.err);
  console.log(String(r.out).slice(0, 1200));
}

async function submit(args) {
  if (!args.includes('--confirm')) {
    exit(3, 'TASKMARKET_NOT_AUTHORIZED: submit requires explicit --confirm after showing the operator a preview (taskId, files)');
  }
  const rest = args.filter((a) => a !== '--confirm');
  const [taskId, ...files] = rest;
  if (!taskId || files.length === 0) exit(2, 'submit requires <taskId> <file...> [--confirm]');
  const cliArgs = ['task', 'submit', taskId, '--role', 'final'];
  for (const f of files) cliArgs.push('--file', f);
  const r = cli(cliArgs);
  if (!r.ok) exit(4, 'taskmarket submit failed: ' + r.err);
  console.log(String(r.out).slice(0, 1200));
}

async function main() {
  const [action, ...rest] = process.argv.slice(2);
  if (!action) exit(2, 'usage: taskmarket.js <browse|track|review|create|submit> [...]');
  if (action === 'browse') return browse(rest.find((a) => /^\d+$/.test(a)));
  if (action === 'track') return track();
  if (action === 'review') return review(rest[0]);
  if (action === 'create') return create(rest);
  if (action === 'submit') return submit(rest);
  exit(2, `unknown action: ${action}`);
}

main().catch((e) => exit(4, 'error: ' + (e && e.message)));
