// Repairs two GitHub Actions failure modes for fresh PRs. A merge-ref race can
// drop pull_request CI entirely (or create an un-rerunnable startup_failure),
// which close/reopen re-fires once the merge ref exists. Auto-merge PRs cannot
// use that destructive repair, so a second lane finds cancelled Actions checks
// attached to the PR head and reruns their PR-event workflows without disturbing
// auto-merge. The workflow authenticates with a GitHub App token because
// GITHUB_TOKEN-authored events do not trigger new workflow runs.

const CI_WORKFLOW_FILE = "ci.yml";
const LOOKBACK_MS = 24 * 60 * 60 * 1000;
// Give GitHub time to settle merge-ref computation and late run attachment
// before judging a head SHA as dropped.
const MIN_QUIET_MS = 10 * 60 * 1000;
// Two bot closes per PR: a head that still has no CI after two re-fires needs
// a human, not an hourly close/reopen loop.
const MAX_BOT_CLOSES = 2;
const MAX_REFIRES_PER_SWEEP = 10;
const MAX_REVIVES_PER_SWEEP = 10;
const REVIVABLE_EVENTS = new Set(["pull_request", "pull_request_target"]);
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
  // restore it; the non-destructive revive lane serves these PRs instead.
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

export function classifyRunForRevive({ run, prCreatedAt, prHeadBranch, repoFullName }) {
  if (run.conclusion !== "cancelled") {
    return { action: "skip", reason: "not-cancelled" };
  }
  if (!REVIVABLE_EVENTS.has(run.event)) {
    return { action: "skip", reason: "unsupported-event" };
  }
  // A head SHA can be reused by a later PR. Reruns replay the original event
  // context, so a run created before this PR existed cannot safely be revived.
  if (Date.parse(run.created_at) < Date.parse(prCreatedAt)) {
    return { action: "skip", reason: "predates-pr" };
  }
  if (run.run_attempt >= 3) {
    return { action: "skip", reason: "revive-budget-exhausted" };
  }
  // Trigger identity: even when a target run's head_sha is base-side and its
  // pull_requests is empty (observed live), head_branch still names the
  // triggering PR's branch. Same-repo branch names are unique, so requiring
  // branch + repo match ties the rerun to this PR's event context; fork-headed
  // or foreign-branch runs are refused rather than replayed on inference.
  if (prHeadBranch !== undefined && run.head_branch !== prHeadBranch) {
    return { action: "skip", reason: "different-head-branch" };
  }
  // Absent metadata fails closed: an unverifiable head repository must never
  // default to "same repo" — that would replay fork-triggered privileged runs.
  if (repoFullName !== undefined && run.head_repository?.full_name !== repoFullName) {
    return { action: "skip", reason: "fork-head-repository" };
  }
  return { action: "revive", reason: "cancelled-pr-event-run" };
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

async function listLatestChecksForHead({ github, owner, repo, headSha }) {
  // Checks are the PR association GitHub's merge box and auto-merge actually
  // wait on. pull_request_target workflow runs can have a base-side head_sha
  // and an empty pull_requests array, so neither run field identifies the PR.
  // filter=latest also omits cancelled checks superseded by a newer same-name
  // check, leaving only cancelled work that still blocks this head.
  // Accepted tradeoff: checks are commit-scoped, so a second PR sharing this
  // exact head (a duplicate PR off the same automation branch) could have its
  // run revived under our candidate's eligibility. GitHub exposes no trigger
  // identity for these runs (pull_requests is empty on live target runs), and
  // requiring one would skip the very runs this lane exists to repair; the
  // worst case is duplicated bot activity on a same-branch sibling PR.
  return await github.paginate(github.rest.checks.listForRef, {
    owner,
    repo,
    ref: headSha,
    filter: "latest",
    per_page: 100,
  });
}

function workflowRunIdForCheck(check) {
  if (check.conclusion !== "cancelled" || check.app?.slug !== "github-actions") {
    return undefined;
  }
  const match = check.details_url?.match(/\/actions\/runs\/(\d+)(?:\/|$)/);
  return match ? Number(match[1]) : undefined;
}

function isExpectedReviveSkip(error) {
  // Only a positively identified already-active run is an expected race; a bare
  // 403 can also be a policy/permission denial that must surface, or the lane
  // reports success while permanently unable to repair anything.
  return /already (?:running|in progress)/i.test(String(error));
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
  let revives = 0;
  const openPrs = await github.paginate(github.rest.pulls.list, {
    owner,
    repo,
    state: "open",
    sort: "updated",
    direction: "desc",
    per_page: 100,
  });
  const seenRunIds = new Set();
  reviveLane: for (const listed of openPrs) {
    if (now - Date.parse(listed.updated_at) > LOOKBACK_MS) {
      break;
    }
    if (
      listed.draft ||
      !listed.auto_merge ||
      now - Date.parse(listed.created_at) > LOOKBACK_MS ||
      now - Date.parse(listed.updated_at) < MIN_QUIET_MS
    ) {
      continue;
    }
    const checks = await listLatestChecksForHead({
      github,
      owner,
      repo,
      headSha: listed.head.sha,
    });
    // One workflow run fans out to many job checks; inspect each run id once
    // per PR or a rejected matrix run costs one API call per job.
    const inspectedForPr = new Set();
    for (const check of checks) {
      const runId = workflowRunIdForCheck(check);
      if (runId === undefined || seenRunIds.has(runId) || inspectedForPr.has(runId)) {
        continue;
      }
      inspectedForPr.add(runId);
      const { data: run } = await github.rest.actions.getWorkflowRun({
        owner,
        repo,
        run_id: runId,
      });
      const verdict = classifyRunForRevive({
        run,
        prCreatedAt: listed.created_at,
        prHeadBranch: listed.head.ref,
        repoFullName: `${owner}/${repo}`,
      });
      // Global suppression only once this run is actually handled: a
      // PR-relative rejection (branch mismatch, predates-pr) must leave the
      // run inspectable for the candidate that owns it.
      if (verdict.action === "revive") {
        seenRunIds.add(runId);
      }
      if (verdict.action !== "revive") {
        if (verdict.reason === "revive-budget-exhausted") {
          core.info(
            `pr-ci-sweeper: skip cancelled run ${runId} for #${listed.number} (${verdict.reason})`,
          );
        }
        continue;
      }
      if (revives >= MAX_REVIVES_PER_SWEEP) {
        core.info(`pr-ci-sweeper: per-sweep revive cap (${MAX_REVIVES_PER_SWEEP}) reached`);
        break reviveLane;
      }
      if (!dryRun) {
        // Revalidate immediately before mutating, mirroring the re-fire lane:
        // a fresh push, merge, close, or disarmed auto-merge in the scan gap
        // must win — reviving an old head's run could cancel the new head's
        // live run via workflow-level cancel-in-progress.
        const { data: fresh } = await github.rest.pulls.get({
          owner,
          repo,
          pull_number: listed.number,
        });
        if (
          fresh.state !== "open" ||
          fresh.draft ||
          !fresh.auto_merge ||
          fresh.head.sha !== listed.head.sha
        ) {
          core.info(`pr-ci-sweeper: #${listed.number} changed during sweep; skipping revive`);
          continue;
        }
        // The scan can spend minutes across PRs; a manual rerun or new event
        // may have replaced this check meanwhile. Rerunning a no-longer-latest
        // cancelled run would put stale checks back in flight (or cancel a
        // live replacement via workflow concurrency), so require the same
        // check to still be the head's latest cancelled entry.
        const currentChecks = await listLatestChecksForHead({
          github,
          owner,
          repo,
          headSha: listed.head.sha,
        });
        if (!currentChecks.some((current) => workflowRunIdForCheck(current) === runId)) {
          core.info(
            `pr-ci-sweeper: run ${runId} for #${listed.number} is no longer the latest cancelled check; skipping`,
          );
          continue;
        }
        // Revive only a quiescent head: any queued/in-progress Actions check
        // means a replacement may be underway, and rerunning now could cancel
        // it via workflow concurrency. Auto-merge waits for every check anyway,
        // so deferring to the next sweep loses nothing.
        const active = currentChecks.some(
          (current) => current.app?.slug === "github-actions" && current.status !== "completed",
        );
        if (active) {
          core.info(
            `pr-ci-sweeper: #${listed.number} head has active checks; deferring revive of run ${runId}`,
          );
          continue;
        }
        // A concurrent rerun can advance the same run id to a fresh attempt in
        // the scan gap; reclassify the current attempt so the budget and
        // cancelled-state guards judge what the rerun would actually replay.
        const { data: currentRun } = await github.rest.actions.getWorkflowRun({
          owner,
          repo,
          run_id: runId,
        });
        const currentVerdict = classifyRunForRevive({
          run: currentRun,
          prCreatedAt: listed.created_at,
          prHeadBranch: listed.head.ref,
          repoFullName: `${owner}/${repo}`,
        });
        if (currentVerdict.action !== "revive") {
          core.info(
            `pr-ci-sweeper: run ${runId} for #${listed.number} changed during sweep (${currentVerdict.reason}); skipping`,
          );
          continue;
        }
      }
      // Count only real (or dry-run-logged) revive attempts: stale candidates
      // rejected by revalidation must not exhaust the sweep-wide cap.
      revives += 1;
      if (dryRun) {
        core.info(
          `pr-ci-sweeper: dry-run, would revive cancelled run ${runId} for #${listed.number}`,
        );
        continue;
      }
      try {
        await github.rest.actions.reRunWorkflow({ owner, repo, run_id: runId });
        core.info(`pr-ci-sweeper: revived cancelled run ${runId} for #${listed.number}`);
      } catch (error) {
        if (!isExpectedReviveSkip(error)) {
          throw error;
        }
        core.info(
          `pr-ci-sweeper: run ${runId} for #${listed.number} was not rerun (${String(error)}); skipping`,
        );
      }
    }
  }
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
    `pr-ci-sweeper: checked ${openPrs.length} open PRs, ${results.length} candidates, ${refires} re-fire${refires === 1 ? "" : "s"}, ${revives} revive${revives === 1 ? "" : "s"}${dryRun ? " (dry-run)" : ""}`,
  );
  return results;
}
