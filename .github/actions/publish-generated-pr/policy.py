"""Generated publication decisions share one terminal Git lifecycle owner."""
import base64
import os
from pathlib import Path
import re
import subprocess
import tempfile

from ci_git_owner import run_git, GitFailure, FetchTimeout, check_cancelled

workspace = os.getcwd()
base_branch = os.environ["BASE_BRANCH"]
head_branch = os.environ["HEAD_BRANCH"]
base_ref = f"refs/remotes/origin/{base_branch}"
generated_paths = [p for p in os.environ["GENERATED_PATHS"].split("\n") if p]
invalidation_paths = [p for p in os.environ["INVALIDATION_PATHS"].split("\n") if p]
push_log = Path(os.environ["RUNNER_TEMP"]) / "generated-pr-push.log"
auth_key = "http.https://github.com/.extraheader"
lease_rejection = r"stale info|non-fast-forward|fetch first"


class PublicationFailure(Exception):
    def __init__(self, code=1):
        self.code = code


def fail(message):
    print(f"::error::{message}", flush=True)
    raise PublicationFailure()


def summary(message):
    check_cancelled()
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as output:
        output.write(message + "\n")


def git(*arguments, timeout=None, capture=False):
    # These operations own an exclusive physical checkout. The canonical owner
    # preserves preexisting locks and reclaims new locks only after extinction.
    with tempfile.TemporaryFile() as output:
        run_git(workspace, *arguments, timeout=timeout, reclaim_locks=True,
                stdout=output if capture else None)
        if capture:
            output.seek(0)
            return output.read().decode("utf-8", errors="surrogateescape")


def git_test(*arguments):
    # diff/merge-base status 1 is a negative answer; read/inspection errors are
    # never an empty tree, no overlap, or a successful reconciliation.
    try:
        git(*arguments)
        return True
    except GitFailure as error:
        if error.code != 1:
            raise
        return False


def gh(function, *arguments, capture=False, tolerate_failure=False):
    # Retain the action's Bash GH bodies and their GNU timeout policy verbatim.
    # This is a synchronous call, not another process-tree supervisor.
    check_cancelled()
    result = subprocess.run(
        ["bash", "--noprofile", "--norc", "-euo", "pipefail", "-c",
         (f'if {function} "$@"; then exit 0; else exit $?; fi'
          if function == "read_auto_merge_record_for_head" else f'{function} "$@"'), function, *arguments],
        stdout=subprocess.PIPE if capture else None,
    )
    check_cancelled()
    if result.returncode and not tolerate_failure:
        raise PublicationFailure(result.returncode if result.returncode > 0 else 128 - result.returncode)
    return result.stdout.decode("utf-8", errors="surrogateescape").rstrip("\n") if capture else ""


def find_open_pr(*, tolerate_failure=False):
    record = gh("find_open_pr", capture=True, tolerate_failure=tolerate_failure)
    return tuple(record.split("\t", 1)) if record else ("", "")


def read_remote_head():
    output = git("ls-remote", "--heads", "origin", f"refs/heads/{head_branch}",
                 timeout=60, capture=True)
    return output.splitlines()[0].split()[0] if output.splitlines() else ""


def fetch_base():
    git("fetch", "--no-tags", "origin", f"+refs/heads/{base_branch}:{base_ref}", timeout=120)


def entry_at(commit, path):
    entry = git("ls-tree", commit, "--", path, capture=True).split("\t", 1)[0].rstrip("\n")
    return entry or "__missing__"


def find_owned_path_overlap():
    candidates = set()
    for tree in (desired_commit, base_ref):
        candidates.update(git("diff", "--name-only", "-z", "--no-renames", source_commit,
                              tree, "--", *generated_paths, capture=True).split("\0")[:-1])
    for path in sorted(candidates, key=os.fsencode):
        source_entry = entry_at(source_commit, path)
        desired_entry = entry_at(desired_commit, path)
        base_entry = entry_at(base_ref, path)
        if source_entry != base_entry and desired_entry != base_entry:
            return path
    return ""


def desired_matches_tree(treeish):
    for path in changed_paths:
        if entry_at(desired_commit, path) != entry_at(treeish, path):
            return False
    return True


def stale_reason():
    fetch_base()
    if not git_test("merge-base", "--is-ancestor", source_commit, base_ref):
        fail(f"Resolved workflow source is not an ancestor of latest {base_branch}.")
    if invalidation_paths and not git_test("diff", "--quiet", source_commit, base_ref,
                                          "--", *invalidation_paths):
        return "stale-input", ""
    overlap = find_owned_path_overlap()
    return ("overlap", overlap) if overlap else ("current", "")


def push_generated_branch(expected_head):
    # Only typed ordinary outcomes permit reading output or semantic recovery.
    # Owner failure/cancellation escapes before a log, auth cleanup, or GH call.
    with tempfile.TemporaryFile() as output:
        code = 0
        try:
            run_git(workspace, "push", f"--force-with-lease=refs/heads/{head_branch}:{expected_head}",
                    "origin", f"HEAD:refs/heads/{head_branch}", timeout=60,
                    reclaim_locks=True, stdout=output, stderr=subprocess.STDOUT)
        except GitFailure as error:
            code = error.code
        except FetchTimeout:
            code = 124
        output.seek(0)
        text = output.read().decode("utf-8", errors="surrogateescape").rstrip("\n") + "\n"
    print(text, end="", flush=True)
    push_log.write_text(text, errors="surrogateescape")
    return code


def report_push_failure():
    text = push_log.read_text(errors="surrogateescape")
    if re.search(r"GH013|repository rule violations|required status check", text, re.I):
        print("::error::Generated branch push was rejected by repository rules; refusing a doomed retry.", flush=True)
    elif re.search(lease_rejection, text, re.I):
        print("::error::Generated branch moved concurrently; refusing to overwrite the newer head.", flush=True)


def preserve_stale_pr():
    stale_pr_url, stale_pr_head = find_open_pr()
    if not stale_pr_url:
        return
    if read_remote_head() != stale_pr_head:
        fail("Generated branch moved before stale auto-merge reconciliation.")
    record = gh("read_auto_merge_record_for_head", stale_pr_head, stale_pr_url, capture=True)
    if record.split("\t", 1)[1]:
        # Disarming has no head-CAS API. It can conservatively pause a concurrent
        # successor, but must never overwrite its commits or enable stale output.
        gh("disable_auto_merge", stale_pr_url)
        record = gh("read_auto_merge_record_for_head", stale_pr_head, stale_pr_url, capture=True)
        if record.split("\t", 1)[1]:
            fail("Stale generated pull request still has auto-merge enabled.")
    if read_remote_head() != stale_pr_head:
        fail("Generated branch moved during stale auto-merge reconciliation; rerun the publisher.")
    summary(f"Preserved stale generated pull request with auto-merge disabled: {stale_pr_url}. "
            "A fresh generator run will update it and restore the configured auto-merge policy.")


def finish_nonpublication(reason):
    current, _ = stale_reason()
    if reason in ("no-change", "merged"):
        if current == "current":
            return
        reason = current
    preserve_stale_pr()
    detail = (f"generator inputs changed on {base_branch}" if reason == "stale-input"
              else f"owned generated paths changed on {base_branch}")
    if os.environ["OVERLAP_POLICY"] == "fail":
        fail(f"Refusing stale generated output because {detail}.")
    summary(f"Deferred stale generated output because {detail}.")


def prepare_branch():
    reason, overlap = stale_reason()
    if reason == "stale-input":
        print(f"::notice::Stale generated output detected because generator inputs changed on {base_branch}.", flush=True)
        return reason
    if reason == "overlap":
        print(f"::notice::Stale generated output detected because {overlap} changed on {base_branch}.", flush=True)
        return reason
    git("switch", "-C", head_branch, base_ref)
    for path in changed_paths:
        if entry_at(desired_commit, path) == "__missing__":
            git("rm", "-f", "--ignore-unmatch", "--", path)
        else:
            git("restore", f"--source={desired_commit}", "--staged", "--worktree", "--", path)
    git("add", "-A", "--", *generated_paths)
    if git_test("diff", "--cached", "--quiet", "--", *generated_paths):
        return "merged"
    git("commit", "--no-gpg-sign", "--no-verify", "-m", os.environ["COMMIT_MESSAGE"])
    return "ready"


def verify_publication(published_commit):
    for attempt in (1, 2, 3):
        final_pr_url, final_pr_head = find_open_pr(tolerate_failure=True)
        if final_pr_url:
            if final_pr_head == published_commit:
                summary(f"Generated pull request: {final_pr_url}")
                return final_pr_url
            print("::notice::Generated pull request head has not converged yet; rechecking.", flush=True)
        subprocess.run(["sleep", str(attempt)], check=True)
        check_cancelled()
    fetch_base()
    if desired_matches_tree(base_ref):
        summary("Generated output was merged while publication was being reconciled.")
        return ""
    if read_remote_head() != published_commit:
        fail("Generated automation branch moved during pull request reconciliation.")
    fail("Generated branch has no open same-repository pull request.")


def enable_auto_merge(published_commit, published_pr_url):
    if os.environ["AUTO_MERGE"] != "true" or not published_pr_url:
        return
    reason, _ = stale_reason()
    if reason != "current":
        finish_nonpublication(reason)
        return
    try:
        record = gh("read_auto_merge_record_for_head", published_commit, published_pr_url, capture=True)
    except PublicationFailure:
        if read_remote_head() != published_commit:
            summary("Generated pull request moved before auto-merge reconciliation.")
            return
        fail("Generated pull request head did not converge for auto-merge reconciliation.")
    method = record.split("\t", 1)[1]
    if method == "SQUASH":
        summary(f"Squash auto-merge already enabled for generated pull request: {published_pr_url}")
        return
    if method:
        fail(f"Generated pull request already uses incompatible {method} auto-merge.")
    gh("merge_pr", published_pr_url, published_commit)
    summary(f"Enabled squash auto-merge for exact generated head: {published_pr_url}")


def publish():
    global desired_commit, changed_paths
    git("add", "-A", "--", *generated_paths)
    if git_test("diff", "--cached", "--quiet", "--", *generated_paths):
        print("No generated changes.", flush=True)
        desired_commit = source_commit
        finish_nonpublication("no-change")
        return
    # Snapshot the generator's desired blobs before moving to the latest base.
    git("commit", "--no-gpg-sign", "--no-verify", "-m", os.environ["COMMIT_MESSAGE"])
    desired_commit = git("rev-parse", "HEAD", capture=True).rstrip("\n")
    changed_paths = git("diff", "--name-only", "-z", "--no-renames", source_commit,
                        desired_commit, "--", *generated_paths, capture=True).split("\0")[:-1]
    outcome = prepare_branch()
    if outcome != "ready":
        finish_nonpublication(outcome)
        return
    remote_head = read_remote_head()
    gh("ensure_auto_merge_compatible", remote_head)
    code = push_generated_branch(remote_head)
    if code:
        current_remote_head = read_remote_head()
        branch_was_deleted = bool(remote_head) and not current_remote_head
        if not branch_was_deleted or not re.search(lease_rejection, push_log.read_text(errors="surrogateescape"), re.I):
            report_push_failure()
            raise PublicationFailure(code)
        # A merge can consume/delete the observed branch. Rebuild exactly once;
        # overlap policy decides whether stale output defers or fails.
        outcome = prepare_branch()
        if outcome != "ready":
            finish_nonpublication(outcome)
            return
        code = push_generated_branch("")
        if code:
            report_push_failure()
            raise PublicationFailure(code)
    published_commit = git("rev-parse", "HEAD", capture=True).rstrip("\n")
    if read_remote_head() != published_commit:
        fetch_base()
        if desired_matches_tree(base_ref):
            summary("Generated output was merged before pull request reconciliation.")
            return
        fail("Generated automation branch moved after publication.")
    body_file = Path(os.environ["RUNNER_TEMP"]) / "generated-pr-body.md"
    body_file.write_text(os.environ["PR_BODY"] + "\n")
    pr_url, _ = find_open_pr()
    mutation_code = 0
    try:
        gh("mutate_pr", pr_url, str(body_file))
    except PublicationFailure as error:
        mutation_code = error.code
    try:
        published_pr_url = verify_publication(published_commit)
    except PublicationFailure:
        raise PublicationFailure(mutation_code or 1)
    enable_auto_merge(published_commit, published_pr_url)


def cleanup_git_auth():
    try:
        git("config", "--local", "--unset-all", auth_key)
    except GitFailure:
        pass  # Preserve ordinary missing/unset tolerance, never lifecycle failure.


if not generated_paths:
    import sys
    print("Generated PR publication requires at least one generated path.", file=sys.stderr)
    raise SystemExit(1)
source_commit = git("rev-parse", "HEAD", capture=True).rstrip("\n")
git("config", "user.name", "github-actions[bot]")
git("config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com")
# Branch transport and PR mutations retain their separate least-privilege identities.
git_auth = base64.b64encode(f"x-access-token:{os.environ['CONTENTS_TOKEN']}".encode()).decode()
print(f"::add-mask::{git_auth}", flush=True)
git("config", "--local", auth_key, f"AUTHORIZATION: basic {git_auth}")
del git_auth
try:
    publish()
except PublicationFailure as error:
    raise SystemExit(error.code)
finally:
    cleanup_git_auth()
