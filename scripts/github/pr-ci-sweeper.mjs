// Re-fires pull_request CI runs that GitHub dropped at PR open. Fresh PRs can
// race merge-ref computation: the open event's CI run either never attaches to
// the head SHA or is created as an un-rerunnable startup_failure. Closing and
// reopening the PR re-fires the event once the merge ref exists. The workflow
// authenticates with a GitHub App token because GITHUB_TOKEN-authored events
// do not trigger new workflow runs.

const CI_WORKFLOW_FILE = "ci.yml";
const LOOKBACK_MS = 24 * 60 * 60 * 1000;
// Give GitHub time to settle merge-ref computation and late run attachment
// before judging a head SHA as dropped.
const MIN_QUIET_MS = 10 * 60 * 1000;
// Two bot closes per PR: a head that still has no CI after two re-fires needs
// a human, not an hourly close/reopen loop.
const MAX_BOT_CLOSES = 2;
const MAX_REFIRES_PER_SWEEP = 10;
// Known sweeper identities for the close budget. The fallback app's login is
// only recognized while it is the active identity, so an auth failover can at
// worst double the budget to four re-fires — still bounded, and the
// newest-close ownership check keeps human closes authoritative regardless.
const KNOWN_SWEEPER_LOGINS = ["openclaw-barnacle[bot]"];
const REOPEN_DELAY_MS = 5_000;

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export function classifyPrForSweep({ pr, ciRuns, botCloseCount, now }) {
  if (pr.draft) {
    return { action: "skip", reason: "draft" };
  }
  if (now - Date.parse(pr.created_at) > LOOKBACK_MS) {
    return { action: "skip", reason: "outside-lookback" };
  }
  if (now - Date.parse(pr.updated_at) < MIN_QUIET_MS) {
    return { action: "skip", reason: "recently-updated" };
  }
  // A conflicted PR legitimately has no merge ref; CI cannot attach until the
  // author resolves, so re-firing would loop forever. Null/unknown mergeability
  // is NOT skipped: live testing showed dropped-CI PRs stay mergeable=null
  // indefinitely (the stuck merge-ref computation IS the pathology), and
  // close/reopen is what un-sticks it. A not-yet-computed conflict costs at
  // most one budgeted re-fire before the recomputed false skips it.
  if (pr.mergeable === false) {
    return { action: "skip", reason: "merge-conflict" };
  }
  // Closing a PR silently cancels enabled auto-merge and reopening does not
  // restore it; leave those PRs (e.g. generated locale refreshes) to a human.
  if (pr.auto_merge) {
    return { action: "skip", reason: "auto-merge-enabled" };
  }
  // Queued and in-progress runs have a null conclusion and count as attached.
  if (ciRuns.some((run) => run.conclusion !== "startup_failure")) {
    return { action: "skip", reason: "ci-attached" };
  }
  if (botCloseCount >= MAX_BOT_CLOSES) {
    return { action: "skip", reason: "refire-budget-exhausted" };
  }
  return {
    action: "refire",
    reason: ciRuns.length === 0 ? "ci-run-missing" : "ci-startup-failure",
  };
}

async function listPullRequestCiRuns({ github, owner, repo, headSha }) {
  // Manual dispatches or other events against the same SHA neither prove nor
  // repair the dropped pull_request run; judge only pull_request-event runs,
  // filtered server-side and paginated so unrelated runs cannot crowd them out.
  // Accepted tradeoff: a SHA shared by two PRs can mask one PR's dropped run
  // behind the other's — a skip-only miss. Matching run.pull_requests instead
  // would misclassify fork PRs, where GitHub leaves that array empty.
  return await github.paginate(github.rest.actions.listWorkflowRuns, {
    owner,
    repo,
    workflow_id: CI_WORKFLOW_FILE,
    head_sha: headSha,
    event: "pull_request",
    per_page: 100,
  });
}

// Our close call succeeded against a verified-open PR, so the sweeper owns the
// transition unless a newer close event by someone else is positively visible
// (a human close in the millisecond race window makes our update an eventless
// no-op). Stale or lagging event reads must therefore default to "ours".
async function someoneElseClosed({
  github,
  owner,
  repo,
  pullNumber,
  sweeperLogins,
  knownCloseIds,
}) {
  const events = await github.paginate(github.rest.issues.listEvents, {
    owner,
    repo,
    issue_number: pullNumber,
    per_page: 100,
  });
  const newClose = events.findLast(
    (event) => event.event === "closed" && !knownCloseIds.has(event.id),
  );
  if (!newClose?.actor) {
    return false;
  }
  return !(newClose.actor.type === "Bot" && sweeperLogins.has(newClose.actor.login));
}

async function reopenWithRetry({ github, core, owner, repo, pullNumber }) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await github.rest.pulls.update({ owner, repo, pull_number: pullNumber, state: "open" });
      return true;
    } catch (error) {
      lastError = error;
      await sleep(REOPEN_DELAY_MS * attempt);
    }
  }
  // Never leave a swept PR closed silently: surface on the PR and fail the run.
  await github.rest.issues
    .createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body: "PR CI Sweeper closed this PR to re-fire a dropped CI run but could not reopen it. Please reopen manually.",
    })
    .catch(() => undefined);
  core.setFailed(`pr-ci-sweeper: failed to reopen #${pullNumber}: ${String(lastError)}`);
  return false;
}

export async function runPrCiSweeper({
  github,
  context,
  core,
  dryRun = false,
  appSlug = "",
  // Injectable clock: fixture-based tests pin a fixed instant so lookback
  // classification cannot rot as wall-clock time passes the fixture dates.
  now = Date.now(),
}) {
  const sweeperLogins = new Set(KNOWN_SWEEPER_LOGINS);
  if (appSlug) {
    sweeperLogins.add(`${appSlug}[bot]`);
  }
  const { owner, repo } = context.repo;
  const results = [];
  let refires = 0;
  const openPrs = await github.paginate(github.rest.pulls.list, {
    owner,
    repo,
    state: "open",
    sort: "updated",
    direction: "desc",
    per_page: 100,
  });
  for (const listed of openPrs) {
    if (now - Date.parse(listed.updated_at) > LOOKBACK_MS) {
      break;
    }
    if (refires >= MAX_REFIRES_PER_SWEEP) {
      core.info(`pr-ci-sweeper: per-sweep re-fire cap (${MAX_REFIRES_PER_SWEEP}) reached`);
      break;
    }
    if (listed.draft) {
      continue;
    }
    const ciRuns = await listPullRequestCiRuns({ github, owner, repo, headSha: listed.head.sha });
    if (ciRuns.some((run) => run.conclusion !== "startup_failure")) {
      continue;
    }
    // Candidate: fetch authoritative state (mergeable, current head) and the
    // close history so a racing push or human action wins over the sweep.
    const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: listed.number });
    if (pr.state !== "open" || pr.head.sha !== listed.head.sha) {
      continue;
    }
    const events = await github.paginate(github.rest.issues.listEvents, {
      owner,
      repo,
      issue_number: pr.number,
      per_page: 100,
    });
    // Budget counts only this sweeper's own closes so unrelated bot
    // automation cannot exhaust a PR's re-fire allowance.
    const botCloseCount = events.filter(
      (event) =>
        event.event === "closed" &&
        event.actor?.type === "Bot" &&
        sweeperLogins.has(event.actor.login),
    ).length;
    const verdict = classifyPrForSweep({ pr, ciRuns, botCloseCount, now });
    results.push({ number: pr.number, sha: pr.head.sha.slice(0, 12), ...verdict });
    if (verdict.action !== "refire") {
      core.info(`pr-ci-sweeper: skip #${pr.number} (${verdict.reason})`);
      continue;
    }
    refires += 1;
    if (dryRun) {
      core.info(`pr-ci-sweeper: dry-run, would re-fire #${pr.number} (${verdict.reason})`);
      continue;
    }
    core.info(`pr-ci-sweeper: re-firing CI for #${pr.number} (${verdict.reason})`);
    // Revalidate immediately before mutating: a human close or a fresh push in
    // the classify gap must win over the sweep.
    const { data: fresh } = await github.rest.pulls.get({ owner, repo, pull_number: pr.number });
    if (
      fresh.state !== "open" ||
      fresh.head.sha !== pr.head.sha ||
      fresh.auto_merge ||
      fresh.mergeable === false
    ) {
      core.info(`pr-ci-sweeper: #${pr.number} changed during sweep; leaving it alone`);
      continue;
    }
    // CI can attach late during the scan's own API calls; closing then would
    // cancel a live run. Re-check the head immediately before mutating.
    const latestRuns = await listPullRequestCiRuns({
      github,
      owner,
      repo,
      headSha: fresh.head.sha,
    });
    if (latestRuns.some((run) => run.conclusion !== "startup_failure")) {
      core.info(`pr-ci-sweeper: #${pr.number} CI attached during sweep; leaving it alone`);
      continue;
    }
    const knownCloseIds = new Set(
      events.filter((event) => event.event === "closed").map((event) => event.id),
    );
    await github.rest.pulls.update({ owner, repo, pull_number: pr.number, state: "closed" });
    await sleep(REOPEN_DELAY_MS);
    // Skip the reopen only on positive evidence that someone else performed a
    // newer close. Verification errors and stale event reads fail toward
    // reopening: stranding our own close is the worse outcome.
    let humanClosed = false;
    try {
      humanClosed = await someoneElseClosed({
        github,
        owner,
        repo,
        pullNumber: pr.number,
        sweeperLogins,
        knownCloseIds,
      });
    } catch (error) {
      core.info(`pr-ci-sweeper: close-ownership check failed (${String(error)}); reopening`);
    }
    if (humanClosed) {
      core.info(`pr-ci-sweeper: #${pr.number} was closed by someone else; not reopening`);
      continue;
    }
    await reopenWithRetry({ github, core, owner, repo, pullNumber: pr.number });
  }
  core.info(
    `pr-ci-sweeper: checked ${openPrs.length} open PRs, ${results.length} candidates, ${refires} re-fire${refires === 1 ? "" : "s"}${dryRun ? " (dry-run)" : ""}`,
  );
  return results;
}
