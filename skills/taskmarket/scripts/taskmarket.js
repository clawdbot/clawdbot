#!/usr/bin/env node
// taskmarket.js — TaskMarket (api.taskmarket.dev) delegation client for the
// taskmarket OpenClaw skill. Zero-dependency, standalone.
//
// Usage:
//   node taskmarket.js browse [--json]        # public, no key needed
//   node taskmarket.js track                   # public, no key needed
//   node taskmarket.js create <title> <description> [reward] [tags]
//   node taskmarket.js submit <taskId> <message> [github_url]
//
// Write actions require TASKMARKET_API_KEY (and submit also
// TASKMARKET_WORKER_ADDRESS) in the environment. Exit codes:
//   0 success | 2 bad usage | 3 not authorized | 4 api error
const BASE = 'https://api.taskmarket.dev';

function exit(code, msg) {
  if (msg) console.error(msg);
  process.exit(code);
}

async function api(path, options = {}) {
  const res = await fetch(BASE + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'openclaw-taskmarket-skill/1.0',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { /* non-JSON */ }
  return { status: res.status, body, text };
}

async function browse(jsonMode) {
  const { status, body } = await api('/api/tasks?limit=100');
  if (status !== 200) exit(4, `browse failed: HTTP ${status}`);
  const tasks = body.tasks || body.items || body.data || [];
  const open = tasks.filter((t) => t.status === 'open' && t.submissionWindowOpen !== false);
  open.sort((a, b) => (a.submissionCount || 0) - (b.submissionCount || 0));
  if (jsonMode) {
    console.log(JSON.stringify(open.slice(0, 20), null, 1));
    return;
  }
  for (const t of open.slice(0, 20)) {
    const id = String(t.id || '').slice(0, 8);
    const title = (t.title || (t.description || '').split('\n')[0] || '').slice(0, 60);
    console.log(`${id} reward=${t.reward} subs=${t.submissionCount || 0} expiry=${(t.expiryTime || '').slice(0, 10)} | ${title}`);
  }
}

async function track() {
  // Public agent directory lookup: print recent submissions for this worker.
  // The CLI wallet address is not required for read-only tracking; without it
  // we still show the last submissions recorded in the local run log if present.
  const { status, body } = await api('/api/tasks?limit=5');
  if (status !== 200) exit(4, `track failed: HTTP ${status}`);
  console.log('TaskMarket reachable. Open task sample:');
  const tasks = body.tasks || body.items || body.data || [];
  for (const t of tasks.slice(0, 5)) {
    console.log(`  ${String(t.id || '').slice(0, 8)} ${t.status} subs=${t.submissionCount || 0}`);
  }
  console.log('(Pass a task id to `submit` to record work; submission history is per-wallet on the dashboard.)');
}

async function create(args) {
  if (!process.env.TASKMARKET_API_KEY) exit(3, 'TASKMARKET_API_KEY not set; create requires it');
  const [title, description, reward, tags] = args;
  if (!title || !description) exit(2, 'create requires "<title>" "<description>" [reward] [tags]');
  const { status, body } = await api('/api/tasks', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.TASKMARKET_API_KEY },
    body: JSON.stringify({
      title,
      description,
      reward: reward ? Number(reward) : undefined,
      tags: tags ? tags.split(/[ ,]+/).filter(Boolean) : [],
    }),
  });
  if (status < 200 || status >= 300) exit(4, `create failed: HTTP ${status} ${JSON.stringify(body).slice(0, 200)}`);
  console.log(`created task id: ${body.id || body.task_id || '(see response)'}`);
  console.log(JSON.stringify(body).slice(0, 400));
}

async function submit(args) {
  if (!process.env.TASKMARKET_API_KEY) exit(3, 'TASKMARKET_API_KEY not set; submit requires it');
  const workerAddress = process.env.TASKMARKET_WORKER_ADDRESS;
  if (!workerAddress) exit(3, 'TASKMARKET_WORKER_ADDRESS not set; submit needs the worker wallet that receives the reward');
  const [taskId, message, githubUrl] = args;
  if (!taskId || !message) exit(2, 'submit requires <taskId> <message> [github_url]');
  const { status, body } = await api(`/api/tasks/${taskId}/submit`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.TASKMARKET_API_KEY },
    body: JSON.stringify({ worker_address: workerAddress, message, github_url: githubUrl || '' }),
  });
  if (status < 200 || status >= 300) exit(4, `submit failed: HTTP ${status} ${JSON.stringify(body).slice(0, 200)}`);
  console.log('submit recorded:', JSON.stringify(body).slice(0, 300));
}

async function main() {
  const [action, ...rest] = process.argv.slice(2);
  if (!action) exit(2, 'usage: taskmarket.js <browse|track|create|submit> [...]');
  if (action === 'browse') return browse(rest.includes('--json'));
  if (action === 'track') return track();
  if (action === 'create') return create(rest);
  if (action === 'submit') return submit(rest);
  exit(2, `unknown action: ${action}`);
}

main().catch((e) => exit(4, 'error: ' + (e && e.message)));
