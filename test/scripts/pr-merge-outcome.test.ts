import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const scripts = join(process.cwd(), "scripts");
const outcomeRef = "refs/openclaw/pr-merge-outcomes/123";
const lockRef = "refs/openclaw/pr-operation-locks/123";
const describePosix = process.platform === "win32" ? describe.skip : describe;

function fixture(sourceMessage?: string, sourceVersions: Array<[string, string?]> = [["after\n"]]) {
  const root = realpathSync(temps.make("pr-merge-outcome-"));
  const remote = join(root, "remote.git");
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (args: string[], input?: string, cwd = repo) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
      cwd,
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Merge Fixture"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  git(["init", "-q", "--bare", remote]);
  git(["remote", "add", "origin", remote]);
  // Production URLs still use the real Git transport, redirected only in this disposable repo.
  git(["config", `url.${remote}.insteadOf`, "https://github.com/fixture/repo"]);
  git(["config", "--add", `url.${remote}.insteadOf`, "https://github.com/fixture/repo.git"]);
  const tree = (owner: string, sibling = "stable\n") => {
    const a = git(["hash-object", "-w", "--stdin"], owner);
    const b = git(["hash-object", "-w", "--stdin"], sibling);
    return git(["mktree"], `100644 blob ${a}\towner.txt\n100644 blob ${b}\tsibling.txt\n`);
  };
  const commit = (contents: string, parents: string[], message = "Fixture commit\n") =>
    git(["commit-tree", contents, ...parents.flatMap((parent) => ["-p", parent])], message);
  const base = commit(tree("before\n"), []);
  const sourceCommits: string[] = [];
  let head = base;
  for (const [owner, sibling] of sourceVersions) {
    head = commit(tree(owner, sibling), [head], sourceMessage);
    sourceCommits.push(head);
  }
  git(["update-ref", "refs/heads/main", base]);
  git(["update-ref", "refs/heads/topic", head]);
  git(["push", "-q", "origin", "main", "topic:refs/pull/123/head", "topic"]);
  const worktree = join(repo, ".worktrees/pr-123");
  git(["worktree", "add", "-q", "-b", "pr-123-prep", worktree, head]);
  mkdirSync(join(worktree, ".local"));
  writeFileSync(
    join(worktree, ".local/prep.env"),
    `PREP_HEAD_SHA=${head}\nLOCAL_PREP_HEAD_SHA=${head}\nPREP_MAINLINE_BASE_SHA=${base}\n`,
  );
  for (const name of ["review.md", "review.json", "pr-meta.env", "pr-meta.json", "prep.md"]) {
    writeFileSync(join(worktree, ".local", name), "fixture\n");
  }
  const initial = {
    repo: {
      id: "fixture-repo",
      url: "https://github.com/fixture/repo",
      nameWithOwner: "fixture/repo",
    },
    pr: {
      id: "fixture-pr",
      number: 123,
      url: "https://github.com/fixture/repo/pull/123",
      state: "OPEN",
      headRefOid: head,
      baseRefName: "main",
      isDraft: false,
      mergeCommit: null as { oid: string } | null,
      autoMergeRequest: null as { mergeMethod: string } | null,
      isInMergeQueue: false,
      isMergeQueueEnabled: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "BEHIND",
    },
    mode: "success",
    landing: "requested",
    reads: 0,
    calls: [] as string[][],
    mutations: 0,
    mergeBody: null as string | null,
    comments: [] as { body: string; html_url: string }[],
    posts: 0,
    invalid: false,
    unavailable: false,
    stale: false,
    drift: false,
    crash: "",
    comment: "success",
    admin: false,
    audit: false,
    gates: "pass",
    review: true,
    ready: true,
    cleanup: "",
    cleanupHead: "",
  };
  const statePath = join(root, "server.json");
  const save = (state: typeof initial) => writeFileSync(statePath, JSON.stringify(state));
  const state = (): typeof initial => JSON.parse(readFileSync(statePath, "utf8"));
  save(initial);
  const gh = join(root, "gh.mjs");
  writeFileSync(
    gh,
    `
import fs from "node:fs";
import { execFileSync } from "node:child_process";
const [route,...args]=process.argv.slice(2);
const file=process.env.FIXTURE_STATE;
const s=JSON.parse(fs.readFileSync(file,"utf8"));
const git=(args,input)=>execFileSync("git",["-c","commit.gpgsign=false","-c","core.hooksPath=/dev/null",...args],{cwd:process.env.FIXTURE_REPO,input,encoding:"utf8"}).trim();
const save=()=>fs.writeFileSync(file,JSON.stringify(s));
const out=(value)=>console.log(typeof value==="string"?value:JSON.stringify(value));
const fail=(text)=>{save();console.error(text);process.exit(1)};
s.calls.push([route,...args]);save();
const main=()=>git(["--git-dir="+process.env.FIXTURE_REMOTE,"rev-parse","refs/heads/main"]);
if(args[0]==="repo") out(args.includes("--jq")?s.repo.nameWithOwner:s.repo);
else if(args[0]==="pr"&&args[1]==="checks") {out([{name:"CI",bucket:s.gates,state:s.gates==="pass"?"SUCCESS":"FAILURE"}]);}
else if(args[0]==="pr"&&args[1]==="view") {
  const pr={...s.pr,changedFiles:0,files:[],headRefName:"topic",headRepository:{name:"repo"},headRepositoryOwner:{login:"fixture"}};
  if(route==="path"&&s.stale) {pr.state="OPEN";pr.mergeCommit=null;}
  if(args.includes("--jq")) {const q=args[args.indexOf("--jq")+1];out(q===".state"?pr.state:q===".mergeCommit.oid"?pr.mergeCommit?.oid??"null":pr.url);}
  else out(pr);
} else if(args[0]==="pr"&&args[1]==="merge") {
  s.mutations++;
  if(args.includes("--body-file")) s.mergeBody=fs.readFileSync(args[args.indexOf("--body-file")+1],"utf8");
  if(args.includes("--disable-auto")) fail("unexpected cancellation");
  if(s.mode==="pending"||s.mode==="pending-error") {
    s.pr.autoMergeRequest={mergeMethod:"SQUASH"};s.pr.isInMergeQueue=s.pr.isMergeQueueEnabled;save();
    if(s.mode==="pending-error") fail("502 after enablement");
  } else {
    if(s.mode!=="unapplied") {
      let parent=main();
      if(s.mode==="advance-at-dispatch") {
        const sibling=git(["hash-object","-w","--stdin"],"advanced\\n");
        const owner=git(["rev-parse",parent+":owner.txt"]);
        const nextTree=git(["mktree"],"100644 blob "+owner+"\\towner.txt\\n100644 blob "+sibling+"\\tsibling.txt\\n");
        parent=git(["commit-tree",nextTree,"-p",parent],"Unrelated advance\\n");
      }
      let landed;
      if(args.includes("--rebase")||s.landing==="rebase") {
        const rebaseDir=process.env.FIXTURE_REPO+"/server-rebase";
        const sourceBase=git(["merge-base",parent,s.pr.headRefOid]);
        git(["worktree","add","-q","--detach",rebaseDir,s.pr.headRefOid]);
        git(["-C",rebaseDir,"rebase","--onto",parent,sourceBase]);
        landed=git(["-C",rebaseDir,"rev-parse","HEAD"]);
        git(["worktree","remove",rebaseDir]);
      } else {
        const tree=git(["merge-tree","--write-tree",parent,s.pr.headRefOid]);
        const parents=args.includes("--merge")?["-p",parent,"-p",s.pr.headRefOid]:["-p",parent];
        landed=git(["commit-tree",tree,...parents],"Landed\\n");
      }
      if(s.landing==="mismatch") landed=git(["commit-tree",git(["rev-parse",parent+"^{tree}"]),"-p",parent,...(args.includes("--merge")?["-p",s.pr.headRefOid]:[])],"Mismatched receipt\\n");
      git(["push","-q","origin",landed+":refs/heads/main"]);
      s.landed=landed;
      if(s.mode!=="applied-open"||s.mutations>1) {s.pr.state="MERGED";s.pr.mergeCommit={oid:landed};}
      save();
    }
    if(s.crash==="dispatch") {save();process.kill(Number(process.env.FIXTURE_LEADER),"SIGKILL");process.exit(1);}
    if(s.mutations===1&&["applied-open","applied-merged","unapplied"].includes(s.mode)) fail("non-200 OK status code: 502 Bad Gateway");
  }
} else if(args.includes("graphql")) {
  s.reads++;save();
  if(s.unavailable) fail("metadata unavailable");
  if(s.invalid) {out({data:{repository:{}}});process.exit(0);}
  if(args.some(x=>x.includes("viewerMergeBodyText"))) {out({data:{repository:{pullRequest:{...s.pr,viewerMergeBodyText:"Fixture body"}}}});}
  else {const pr={...s.pr};if(s.drift&&s.reads%2===0) pr.baseRefName="changed";out({data:{repository:{...s.repo,ref:{target:{oid:main()}},pullRequest:pr}}});}
} else if(args.some(x=>x.includes("/comments"))) {
  if(args.includes("POST")) {
    s.posts++;
    if(s.cleanup==="absent") git(["push","-q","origin",":refs/heads/topic"]);
    if(s.cleanup==="advanced") {
      s.cleanupHead=git(["commit-tree",git(["rev-parse",s.pr.headRefOid+"^{tree}"]),"-p",s.pr.headRefOid],"Branch advance\\n");
      git(["push","-q","origin",s.cleanupHead+":refs/heads/topic"]);
    }
    const body=args.find(x=>x.startsWith("body="))?.slice(5);
    const url=s.pr.url+"#issuecomment-1";
    if(s.comment!=="rejected") s.comments.push({body,html_url:url});
    save();
    if(s.comment!=="success") fail("comment response lost");
    out(url);
  } else out([s.comments]);
} else if(args.some(x=>x.includes("/commits/"))) {
  if(s.audit) fail("audit unavailable");
  out({parents:[{sha:git(["rev-parse",s.pr.mergeCommit.oid+"^1"])}]});
} else fail("unexpected gh "+args.join(" "));
save();
`,
  );
  const shell = join(root, "invoke.sh");
  writeFileSync(
    shell,
    `#!/usr/bin/env bash
set -euo pipefail
script_parent_dir="$FIXTURE_SCRIPTS"
source "$script_parent_dir/pr-lib/worktree.sh"
source "$script_parent_dir/pr-lib/operation-lock.sh"
source "$script_parent_dir/pr-lib/common.sh"
source "$script_parent_dir/pr-lib/merge.sh"
repo_root() { printf '%s\\n' "$FIXTURE_REPO"; }
ensure_gh_api_auth() { :; }
validate_review_artifact_data() { [ "$(command jq -r .review "$FIXTURE_STATE")" = true ]; }
require_ready_review_recommendation() { [ "$(command jq -r .ready "$FIXTURE_STATE")" = true ]; }
verify_prep_branch_matches_prepared_head() { [ "$(command git rev-parse HEAD)" = "$2" ]; }
node() { if [[ "$1" == */watch-pr-ci.mjs ]]; then return 0; fi; command node "$@"; }
gh() { command node "$FIXTURE_GH" path "$@"; }
gh_plain() { command node "$FIXTURE_GH" direct "$@"; }
verify_crabbox_admin_merge_bypass() {
  [ "$(command jq -r .admin "$FIXTURE_STATE")" = true ] || return 1
  command jq --arg main "$(git --git-dir="$FIXTURE_REMOTE" rev-parse refs/heads/main)" '{mainSha:$main,crabboxCheckUrl:"fixture",ciGateUrl:"fixture"}' "$FIXTURE_STATE" > .local/merge-crabbox-bypass.json
}
# Fault the Git boundary, not the outcome owner: crash after intent CAS, or
# reject later receipt writes. All successful object/ref operations are real.
git() {
  if [ "$1" = update-ref ] && [ "\${3-}" = refs/openclaw/pr-merge-outcomes/123 ]; then
    local crash
    crash=$(command jq -r .crash "$FIXTURE_STATE")
    if [ "$crash" = receipt ] && command git show-ref --verify --quiet "$3"; then return 1; fi
    if [ "$crash" = successor ]; then
      command git update-ref "$3" "$(printf 'successor\\n' | command git hash-object -w --stdin)"
    fi
    command git "$@" || return
    if [ "$crash" = intent ]; then kill -KILL "$$"; fi
    return
  fi
  command git "$@"
}
export FIXTURE_LEADER="$$"
acquire_pr_operation_lock 123
begin_pr_operation_validation_phase
merge_run 123 "\${1:-false}"
`,
  );
  chmodSync(shell, 0o755);
  const env = {
    ...process.env,
    FIXTURE_STATE: statePath,
    FIXTURE_REPO: repo,
    FIXTURE_REMOTE: remote,
    FIXTURE_SCRIPTS: scripts,
    FIXTURE_GH: gh,
    OPENCLAW_PR_MERGE_METHOD: "squash",
    OPENCLAW_PR_STRICT_DRIFT: "",
  };
  const run = (auto = false, cwd = repo, method = "squash") => {
    const result = spawnSync(
      process.execPath,
      [join(scripts, "pr-lib/process-group-runner.mjs"), repo, shell, String(auto)],
      { cwd, env: { ...env, OPENCLAW_PR_MERGE_METHOD: method }, encoding: "utf8", timeout: 20_000 },
    );
    return { ...result, output: result.stdout + result.stderr };
  };
  const recover = () => {
    const read = spawnSync("git", ["rev-parse", "--verify", lockRef], {
      cwd: repo,
      encoding: "utf8",
    });
    if (read.status !== 0) return false;
    const oid = read.stdout.trim();
    const owner = git(["cat-file", "blob", oid]);
    const pgid = Number(/^pgid=(\d+)$/m.exec(owner)?.[1]);
    expect(() => process.kill(-pgid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    const result = spawnSync(
      "bash",
      [
        "-c",
        'set -euo pipefail; source "$1"; repo_root() { pwd; }; recover_pr_operation_lock 123 "$2" --confirmed-no-running-tools',
        "recover",
        join(scripts, "pr-lib/operation-lock.sh"),
        oid,
      ],
      { cwd: repo, encoding: "utf8" },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return true;
  };
  const advance = (owner = "after\n", sibling = "advanced\n") => {
    const parent = git(["--git-dir=" + remote, "rev-parse", "main"]);
    // Same-tree main advances must not become source commits within one clock second.
    const next = commit(tree(owner, sibling), [parent], "Main advance\n");
    git(["push", "-q", "origin", next + ":refs/heads/main"]);
    return next;
  };
  const ordinaryRead = () =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [gh, "path", "pr", "view", "123", "--json", "state,headRefOid,mergeCommit"],
        { cwd: repo, env, encoding: "utf8" },
      ),
    );
  const record = () => JSON.parse(git(["show", outcomeRef + ":outcome.json"]));
  return {
    root,
    repo,
    remote,
    worktree,
    base,
    head,
    sourceCommits,
    git,
    tree,
    commit,
    state,
    save,
    run,
    recover,
    advance,
    record,
    ordinaryRead,
  };
}

describePosix("native merge outcome with real Git and supervised lock recovery", () => {
  it.each([false, true])("confirms a real multi-commit rebase with queue=%s", (queue) => {
    const f = fixture(undefined, [["prefix\n"], ["after\n"]]);
    const main = f.advance("before\n");
    f.save({
      ...f.state(),
      landing: "rebase",
      pr: { ...f.state().pr, isMergeQueueEnabled: queue },
    });
    const run = f.run(false, f.repo, queue ? "squash" : "rebase");
    const landed = f.state().pr.mergeCommit!.oid;
    const rewritten = f.git(["rev-list", "--reverse", `${main}..${landed}`]).split("\n");
    expect(rewritten).toHaveLength(2);
    expect(rewritten.every((oid) => !f.sourceCommits.includes(oid))).toBe(true);
    expect(f.git(["show", `${landed}:owner.txt`])).toBe("after");
    expect(f.git(["show", `${landed}:sibling.txt`])).toBe("advanced");
    // The final parent is only the rewritten prefix, not the base of the series.
    expect(() => f.git(["merge-tree", "--write-tree", `${landed}^`, f.head])).toThrow();
    expect(run.status, run.output).toBe(0);
    expect(f.record()).toMatchObject({ landed, phase: "complete" });
    f.advance("before\n");
    expect(f.run().status).toBe(0);
    expect(f.state().mutations).toBe(1);
    expect(f.state().posts).toBe(1);
  });
  it.each(["rebase", "merge"])(
    "rejects a mismatched %s receipt before comment or cleanup",
    (method) => {
      const f = fixture(undefined, [["prefix\n"], ["after\n"]]);
      f.advance("before\n");
      f.save({ ...f.state(), landing: "mismatch" });
      const run = f.run(false, f.repo, method);
      expect(run.status, run.output).toBe(1);
      expect(f.record()).toMatchObject({ phase: "intent", landed: null });
      expect(f.state().posts).toBe(0);
      expect(existsSync(f.worktree)).toBe(true);
      expect(f.git(["--git-dir=" + f.remote, "rev-parse", "topic"])).toBe(f.head);
      f.recover();
      expect(f.run().status).toBe(1);
      expect(f.state().mutations).toBe(1);
    },
  );
  it("checks the source fork base even when recorded main contains a cherry-picked prefix", () => {
    const f = fixture(undefined, [["after\n"], ["after\n", "reviewed\n"]]);
    const main = f.advance("after\n", "stable\n");
    expect(main).not.toBe(f.sourceCommits[0]);
    expect(f.git(["merge-base", main, f.head])).toBe(f.base);
    f.save({ ...f.state(), mode: "unapplied" });
    expect(f.run(false, f.repo, "rebase").status).toBe(1);
    f.recover();
    const landed = f.advance("before\n", "reviewed\n");
    expect(f.git(["merge-tree", "--write-tree", `--merge-base=${main}`, landed, f.head])).toBe(
      f.git(["rev-parse", `${landed}^{tree}`]),
    );
    f.save({
      ...f.state(),
      pr: { ...f.state().pr, state: "MERGED", mergeCommit: { oid: landed } },
    });
    const run = f.run();
    expect(run.status, run.output).toBe(1);
    expect(f.record()).toMatchObject({ phase: "intent", landed: null });
    expect(f.state().posts).toBe(0);
    expect(f.state().mutations).toBe(1);
  });
  it.each(["multiple", "missing"])("refuses a %s source fork base", (fault) => {
    const f = fixture();
    f.save({ ...f.state(), mode: "unapplied" });
    expect(f.run(false, f.repo, "rebase").status).toBe(1);
    f.recover();
    const other = f.commit(f.tree("before\n", "branch\n"), [f.base]);
    const head = f.commit(f.tree("after\n", "branch\n"), [f.head, other], "Source merge\n");
    const main = f.commit(
      f.tree("after\n", "branch\n"),
      fault === "multiple" ? [other, f.head] : [],
      "Main merge\n",
    );
    // A valid retained record with criss-cross (or unrelated) source/main history.
    const previous = f.git(["rev-parse", outcomeRef]);
    const record = { ...f.record(), head, main };
    const blob = f.git(["hash-object", "-w", "--stdin"], JSON.stringify(record));
    const tree = f.git(["mktree"], `100644 blob ${blob}\toutcome.json\n`);
    f.git(["update-ref", outcomeRef, f.commit(tree, [head, main, previous])]);
    const landed = f.commit(f.git(["rev-parse", `${head}^{tree}`]), [main]);
    f.git(["push", "-q", "--force", "origin", `${landed}:refs/heads/main`]);
    f.save({
      ...f.state(),
      pr: { ...f.state().pr, headRefOid: head, state: "MERGED", mergeCommit: { oid: landed } },
    });
    const run = f.run();
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("require one source fork base");
    expect(f.record()).toEqual(record);
    expect(f.state().posts).toBe(0);
    expect(f.state().mutations).toBe(1);
  });
  it.each([false, true])("rejects an ancestral-head revert receipt with queue=%s", (queue) => {
    const f = fixture();
    f.save({
      ...f.state(),
      mode: "unapplied",
      pr: { ...f.state().pr, isMergeQueueEnabled: queue },
    });
    expect(f.run(false, f.repo, queue ? "merge" : "rebase").status).toBe(1);
    f.recover();
    f.git(["push", "-q", "origin", `${f.head}:refs/heads/main`]);
    const landed = f.advance("before\n");
    expect(f.git(["merge-tree", "--write-tree", landed, f.head])).toBe(
      f.git(["rev-parse", `${landed}^{tree}`]),
    );
    f.save({
      ...f.state(),
      pr: { ...f.state().pr, state: "MERGED", mergeCommit: { oid: landed } },
    });
    const run = f.run();
    expect(run.status, run.output).toBe(1);
    expect(f.record()).toMatchObject({ phase: "intent", landed: null });
    expect(f.state().posts).toBe(0);
    expect(f.state().mutations).toBe(1);
    expect(existsSync(f.worktree)).toBe(true);
  });
  it.each(["", "Earlier merge response was lost\n"])(
    "refuses pre-journal merge output without erasing its evidence: %j",
    (output) => {
      const f = fixture();
      const capture = join(f.worktree, ".local/merge-output.log");
      writeFileSync(capture, output);
      f.save({ ...f.state(), mode: "unapplied" });
      const run = f.run();
      expect(run.status, run.output).toBe(1);
      expect(f.state().mutations).toBe(0);
      expect(readFileSync(capture, "utf8")).toBe(output);
      expect(() => f.record()).toThrow();
    },
  );
  it.each([
    { auto: false, admin: false, mergeState: "CLEAN", route: "immediate" },
    { auto: false, admin: true, mergeState: "CLEAN", route: "admin" },
    { auto: true, admin: false, mergeState: "BEHIND", route: "auto" },
    { auto: true, admin: false, mergeState: "CLEAN", route: "immediate" },
  ])(
    "submits verified attribution with pinned head for %j",
    ({ auto, admin, mergeState, route }) => {
      const credit = "Co-authored-by: Fixture Contributor <contributor@example.invalid>";
      const f = fixture(`Source change\n\n${credit}\n`);
      f.save({
        ...f.state(),
        admin,
        gates: admin ? "fail" : "pass",
        pr: { ...f.state().pr, mergeStateStatus: mergeState },
      });
      const run = f.run(auto);
      expect(run.status, run.output).toBe(0);
      const submissions = f.state().calls.filter((call) => call[1] === "pr" && call[2] === "merge");
      expect(submissions).toHaveLength(1);
      const args = submissions[0]!;
      expect(args[args.indexOf("--match-head-commit") + 1]).toBe(f.head);
      expect(args.includes("--auto")).toBe(route === "auto");
      expect(args.includes("--admin")).toBe(admin);
      expect(f.state().mergeBody).toBe(`Fixture body\n\n${credit}\n`);
      expect(f.record()).toMatchObject({ route, phase: "complete" });
    },
  );
  it("warns on a recorded empty squash and preserves its receipt after a later revert", () => {
    const f = fixture();
    f.save({ ...f.state(), mode: "unapplied" });
    expect(f.run().status).toBe(1);
    f.recover();
    const patch = f.advance("after\n", "stable\n");
    const landed = f.commit(f.git(["rev-parse", patch + "^{tree}"]), [patch], "Empty squash\n");
    f.git(["push", "-q", "origin", landed + ":refs/heads/main"]);
    f.save({
      ...f.state(),
      pr: { ...f.state().pr, state: "MERGED", mergeCommit: { oid: landed } },
    });
    const confirmed = f.run();
    expect(confirmed.status, confirmed.output).toBe(0);
    expect(confirmed.output).toContain(
      "Warning: recorded squash has no net change at its landed parent",
    );
    expect(f.record()).toMatchObject({ phase: "merged", landed });
    const receipt = f.git(["rev-parse", outcomeRef]);
    const reverted = f.advance("before\n", "stable\n");
    const resumed = f.run();
    expect(resumed.status, resumed.output).toBe(0);
    expect(resumed.output).toContain(
      "Warning: recorded squash has no net change at its landed parent",
    );
    expect(f.git(["rev-parse", outcomeRef])).toBe(receipt);
    expect(f.git(["--git-dir=" + f.remote, "rev-parse", "main"])).toBe(reverted);
    expect(f.state().mutations).toBe(1);
    expect(f.state().posts).toBe(0);
  });
  it("does not repeat applied 502 + OPEN after main advance and exact lock recovery", () => {
    const f = fixture();
    f.save({ ...f.state(), mode: "applied-open" });
    const first = f.run();
    expect(first.status, first.output).toBe(1);
    expect(f.state().pr.state).toBe("OPEN");
    f.advance();
    expect(f.recover()).toBe(true);
    const second = f.run();
    expect(f.state().mutations, "one mutation across exact lock recovery").toBe(1);
    expect(second.status, second.output).toBe(1);
    expect(f.state().posts).toBe(0);
    expect(second.output).toContain("prior dispatch unresolved");
  });
  it.each(["unapplied", "applied-open"])(
    "keeps %s uncertainty through missing prep/worktree and eventual receipt",
    (mode) => {
      const f = fixture();
      f.save({ ...f.state(), mode });
      expect(f.run().status).toBe(1);
      f.recover();
      f.git(["worktree", "remove", "--force", f.worktree]);
      const unknown = f.run();
      expect(unknown.status, unknown.output).toBe(1);
      f.recover();
      const landed =
        mode === "unapplied"
          ? f.advance("after\n", "stable\n")
          : f.git(["--git-dir=" + f.remote, "rev-parse", "main"]);
      f.save({
        ...f.state(),
        pr: { ...f.state().pr, state: "MERGED", mergeCommit: { oid: landed } },
      });
      const confirmed = f.run();
      expect(confirmed.status, confirmed.output).toBe(0);
      expect(f.state().mutations).toBe(1);
      expect(f.state().posts).toBe(0);
      expect(confirmed.output).toContain("completion pending");
      expect(f.record().phase).toBe("merged");
    },
  );
  it.each(["success", "applied-merged", "advance-at-dispatch"])(
    "confirms %s through fresh reads and preserves completion after later revert",
    (mode) => {
      const f = fixture();
      f.save({ ...f.state(), mode, stale: true });
      const first = f.run();
      expect(first.status, first.output).toBe(0);
      expect(f.state().posts).toBe(1);
      expect(f.record().phase).toBe("complete");
      expect(first.output).not.toContain("Warning: recorded squash");
      expect(f.ordinaryRead().state).toBe("OPEN");
      f.advance("before\n");
      const second = f.run();
      expect(second.status, second.output).toBe(0);
      expect(f.state().mutations).toBe(1);
      expect(f.state().posts).toBe(1);
      expect(second.output).toContain("already complete");
      expect(second.output).not.toContain("Warning: recorded squash");
    },
  );
  it.each(["rejected", "lost"])("does not duplicate a %s completion comment", (comment) => {
    const f = fixture();
    f.save({ ...f.state(), comment });
    const first = f.run();
    expect(first.status, first.output).toBe(1);
    expect(f.record().phase).toBe("commenting");
    f.recover();
    const second = f.run();
    expect(second.status, second.output).toBe(0);
    expect(f.state().mutations).toBe(1);
    expect(f.state().posts).toBe(1);
    expect(existsSync(f.worktree)).toBe(true);
    expect(f.record().phase).toBe(comment === "lost" ? "commented" : "commenting");
  });
  it.each(["intent", "dispatch", "receipt"])(
    "retains uncertainty across crash/failure at %s",
    (crash) => {
      const f = fixture();
      f.save({ ...f.state(), crash, mode: crash === "receipt" ? "success" : "applied-open" });
      expect(f.run().status).not.toBe(0);
      expect(f.record().phase).toBe("intent");
      f.recover();
      f.save({ ...f.state(), crash: "" });
      const retry = f.run();
      expect(retry.status, retry.output).toBe(crash === "receipt" ? 0 : 1);
      expect(f.state().mutations).toBe(crash === "intent" ? 0 : 1);
    },
  );
  it.each(["head", "base", "closed", "invalid", "unavailable", "partial", "revert"])(
    "does not replay unresolved intent after %s",
    (change) => {
      const f = fixture();
      f.save({ ...f.state(), mode: "unapplied" });
      expect(f.run().status).toBe(1);
      f.recover();
      const next = f.state();
      if (change === "head") next.pr.headRefOid = f.base;
      if (change === "base") next.pr.baseRefName = "release";
      if (change === "closed") next.pr.state = "CLOSED";
      if (change === "invalid") next.invalid = true;
      if (change === "unavailable") next.unavailable = true;
      if (change === "partial") f.advance("partial\n");
      if (change === "revert") {
        f.advance();
        f.advance("before\n");
      }
      f.save(next);
      const retry = f.run();
      expect(retry.status, retry.output).toBe(1);
      expect(f.state().mutations).toBe(1);
    },
  );
  it.each([
    "head",
    "base",
    "closed",
    "draft",
    "invalid",
    "unavailable",
    "conflict",
    "drift",
    "no-op",
    "ancestral-revert",
  ])("refuses new dispatch on %s", (change) => {
    const f = fixture();
    const next = f.state();
    if (change === "head") next.pr.headRefOid = f.base;
    if (change === "base") next.pr.baseRefName = "release";
    if (change === "closed") next.pr.state = "CLOSED";
    if (change === "draft") next.pr.isDraft = true;
    if (change === "invalid") next.invalid = true;
    if (change === "unavailable") next.unavailable = true;
    if (change === "drift") next.drift = true;
    if (change === "conflict") f.advance("conflict\n");
    if (change === "no-op") f.advance();
    if (change === "ancestral-revert") {
      f.git(["push", "-q", "origin", f.head + ":refs/heads/main"]);
      f.advance("before\n");
    }
    f.save(next);
    const run = f.run();
    expect(run.status, run.output).toBe(1);
    expect(f.state().mutations).toBe(0);
    if (["no-op", "ancestral-revert"].includes(change))
      expect(run.output).toContain("NO NET CHANGE");
  });
  it.each([
    { auto: false, method: "squash" },
    { auto: false, method: "merge" },
    { auto: true, method: "squash" },
  ])("retains accepted pending intent for %j", ({ auto, method }) => {
    const f = fixture();
    f.save({
      ...f.state(),
      mode: "pending",
      pr: { ...f.state().pr, isMergeQueueEnabled: !auto },
    });
    const first = f.run(auto, f.repo, method);
    expect(first.status, first.output).toBe(0);
    expect(first.output).toContain("AUTO/QUEUE PENDING");
    expect(f.run(auto, f.repo, method).status).toBe(0);
    expect(f.state().mutations).toBe(1);
    const landed = f.advance("after\n", "stable\n");
    f.save({
      ...f.state(),
      pr: {
        ...f.state().pr,
        state: "MERGED",
        mergeCommit: { oid: landed },
        autoMergeRequest: null,
        isInMergeQueue: false,
      },
    });
    const done = f.run(auto, f.repo, method);
    expect(done.status, done.output).toBe(0);
    expect(f.state().mutations).toBe(1);
  });
  it.each([false, true])(
    "never cancels/rearms/falls back after ambiguous queue/auto=%s",
    (auto) => {
      const f = fixture();
      f.save({
        ...f.state(),
        mode: "pending-error",
        pr: { ...f.state().pr, isMergeQueueEnabled: !auto },
      });
      expect(f.run(auto).status).toBe(1);
      f.recover();
      f.save({
        ...f.state(),
        pr: { ...f.state().pr, autoMergeRequest: null, isInMergeQueue: false },
      });
      expect(f.run(auto).status).toBe(1);
      expect(f.state().mutations).toBe(1);
    },
  );
  it("does not impose squash no-op semantics on an ancestry-recording merge", () => {
    const f = fixture();
    f.advance();
    const run = f.run(false, f.repo, "merge");
    expect(run.status, run.output).toBe(0);
    expect(f.state().mutations).toBe(1);
    f.git(["merge-base", "--is-ancestor", f.head, f.record().landed]);
  });
  it("retains confirmed admin merge before failed post-merge audit", () => {
    const f = fixture();
    f.save({ ...f.state(), admin: true, audit: true, gates: "fail" });
    const first = f.run();
    expect(first.status, first.output).toBe(1);
    expect(f.record().route).toBe("admin");
    expect(f.record().phase).toBe("merged");
    f.recover();
    const retry = f.run();
    expect(retry.status, retry.output).toBe(0);
    expect(f.state().mutations).toBe(1);
    expect(f.state().posts).toBe(0);
  });
  it("keeps required commits reachable through worktree deletion and aggressive GC", () => {
    const f = fixture();
    f.save({ ...f.state(), mode: "unapplied" });
    expect(f.run().status).toBe(1);
    f.recover();
    f.git(["worktree", "remove", "--force", f.worktree]);
    f.git(["branch", "-D", "pr-123-prep", "pr-123", "topic"]);
    f.git(["update-ref", "-d", "refs/remotes/origin/topic"]);
    f.git(["reflog", "expire", "--expire=now", "--all"]);
    f.git(["gc", "--prune=now"]);
    f.git(["cat-file", "-e", f.head + "^{commit}"]);
    expect(f.run().status).toBe(1);
    expect(f.state().mutations).toBe(1);
  });
  it.each([
    "corrupt",
    "symbolic",
    "mismatched",
    "missing-head",
    "missing-parent",
    "wrong-tree",
    "unreachable",
  ])("fails closed on %s outcome evidence", (fault) => {
    const f = fixture();
    f.save({ ...f.state(), mode: "unapplied" });
    expect(f.run().status).toBe(1);
    f.recover();
    const previous = f.git(["rev-parse", outcomeRef]);
    if (fault === "corrupt")
      f.git(["update-ref", outcomeRef, f.git(["hash-object", "-w", "--stdin"], "bad")]);
    if (fault === "symbolic") f.git(["symbolic-ref", outcomeRef, "refs/heads/topic"]);
    if (fault === "mismatched")
      f.save({ ...f.state(), repo: { ...f.state().repo, id: "other-repo" } });
    if (fault === "missing-head")
      rmSync(join(f.repo, ".git/objects", f.head.slice(0, 2), f.head.slice(2)));
    if (fault === "missing-parent") {
      const detached = f.commit(f.git(["rev-parse", previous + "^{tree}"]), []);
      f.git(["update-ref", outcomeRef, detached]);
    }
    if (fault === "wrong-tree" || fault === "unreachable") {
      const landed = fault === "wrong-tree" ? f.advance("partial\n") : f.head;
      f.save({
        ...f.state(),
        pr: { ...f.state().pr, state: "MERGED", mergeCommit: { oid: landed } },
      });
    }
    const before = f.git(["rev-parse", outcomeRef]);
    const retry = f.run();
    expect(retry.status, retry.output).toBe(1);
    expect(f.state().mutations).toBe(1);
    expect(f.state().posts).toBe(0);
    expect(f.git(["rev-parse", outcomeRef])).toBe(before);
  });
  it("does not overwrite a successor installed at intent CAS", () => {
    const f = fixture();
    f.save({ ...f.state(), crash: "successor" });
    const run = f.run();
    expect(run.status, run.output).toBe(1);
    expect(f.git(["cat-file", "blob", outcomeRef])).toBe("successor");
    expect(f.state().mutations).toBe(0);
  });
  it.each(["review", "ready", "checks", "pending", "existing-auto", "auto-ineligible"])(
    "keeps %s admission ahead of intent",
    (gate) => {
      const f = fixture();
      const next = f.state();
      if (gate === "review") next.review = false;
      if (gate === "ready") next.ready = false;
      if (gate === "checks") next.gates = "fail";
      if (gate === "pending") next.gates = "pending";
      if (gate === "existing-auto") next.pr.autoMergeRequest = { mergeMethod: "MERGE" };
      if (gate === "auto-ineligible") next.pr.mergeStateStatus = "BLOCKED";
      f.save(next);
      const run = f.run(true);
      expect(run.status, run.output).toBe(1);
      expect(f.state().mutations).toBe(0);
      expect(() => f.record()).toThrow();
    },
  );
  it("does not delete an advanced remote branch and reports cleanup pending", () => {
    const f = fixture();
    f.save({ ...f.state(), cleanup: "advanced" });
    const run = f.run();
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("completion pending");
    expect(f.git(["--git-dir=" + f.remote, "rev-parse", "topic"])).toBe(f.state().cleanupHead);
    expect(f.record().phase).toBe("commented");
    const retry = f.run();
    expect(retry.status, retry.output).toBe(0);
    expect(f.state().posts).toBe(1);
    expect(f.state().mutations).toBe(1);
  });
  it("shares retained outcome across linked checkout contenders", () => {
    const f = fixture();
    const linked = join(f.root, "contender");
    f.git(["worktree", "add", "-q", "--detach", linked, f.base]);
    f.save({ ...f.state(), mode: "unapplied" });
    expect(f.run().status).toBe(1);
    f.recover();
    const retry = f.run(false, linked);
    expect(retry.status, retry.output).toBe(1);
    expect(f.state().mutations).toBe(1);
  });
  it("fetches the immutable authoritative main object during delayed reconciliation", () => {
    const f = fixture();
    f.save({ ...f.state(), mode: "unapplied" });
    expect(f.run().status).toBe(1);
    f.recover();
    const landed = f.git(
      [
        "--git-dir=" + f.remote,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit-tree",
        f.git(["rev-parse", f.head + "^{tree}"]),
        "-p",
        f.base,
      ],
      "Remote-only landing\n",
    );
    f.git(["--git-dir=" + f.remote, "update-ref", "refs/heads/main", landed]);
    expect(() => f.git(["cat-file", "-e", landed])).toThrow();
    f.save({
      ...f.state(),
      pr: { ...f.state().pr, state: "MERGED", mergeCommit: { oid: landed } },
    });
    const retry = f.run();
    expect(retry.status, retry.output).toBe(0);
    f.git(["cat-file", "-e", landed]);
    expect(f.state().mutations).toBe(1);
  });
  it("completes cleanup when GitHub already deleted the source branch", () => {
    const f = fixture();
    f.save({ ...f.state(), cleanup: "absent" });
    const run = f.run();
    expect(run.status, run.output).toBe(0);
    expect(run.output).not.toContain("Warning: remote cleanup pending");
    expect(f.record().phase).toBe("complete");
    expect(f.state().posts).toBe(1);
  });
});
