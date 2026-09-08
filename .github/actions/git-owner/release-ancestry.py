import os
import re
import subprocess
import time
from pathlib import Path

from ci_git_owner import FetchTimeout, GitFailure, backoff, cleanup_seconds, git_output, run_git


source_local_ref = "refs/remotes/origin/release-ancestry-source"
target_hydration_local_ref = "refs/remotes/origin/release-ancestry-target-hydration"
deepen_chunks = (128, 256, 512, 1024, 2048)
max_total_seconds = 120
max_fetch_seconds = 30
max_fetch_attempts = 3
retry_backoff_seconds = 2
workspace = os.getcwd()
deadline = time.monotonic() + max_total_seconds


class TotalBudgetExpired(Exception):
    pass


def operation_timeout(maximum=None):
    seconds = deadline - time.monotonic() - cleanup_seconds
    if seconds <= 0:
        raise TotalBudgetExpired()
    return min(seconds, maximum) if maximum is not None else seconds


def git_test(*arguments):
    try:
        run_git(
            workspace,
            *arguments,
            timeout=operation_timeout(),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return True
    except GitFailure as error:
        if error.code != 1:
            raise
        return False


def git_text(*arguments):
    return git_output(workspace, *arguments, timeout=operation_timeout()).strip()


def resolve_commit(ref):
    value = git_text("rev-parse", "--verify", f"{ref}^{{commit}}")
    if not re.fullmatch("[0-9a-f]{40}", value):
        raise RuntimeError("Git returned an invalid commit")
    return value


def fetch_history(source_sha, target, depth_argument):
    for attempt in range(1, max_fetch_attempts + 1):
        try:
            run_git(
                workspace,
                "-c",
                "protocol.version=2",
                "fetch",
                "--atomic",
                "--no-tags",
                "--no-recurse-submodules",
                "--filter=blob:none",
                "--refmap=",
                depth_argument,
                "origin",
                f"+{source_sha}:{source_local_ref}",
                target,
                timeout=operation_timeout(max_fetch_seconds),
                reclaim_locks=True,
            )
            return
        except (FetchTimeout, GitFailure):
            if attempt == max_fetch_attempts:
                raise
            print(
                f"::warning::Release ancestry fetch failed on attempt {attempt}; retrying.",
                flush=True,
            )
            if operation_timeout() < retry_backoff_seconds:
                raise TotalBudgetExpired()
            backoff(retry_backoff_seconds)


def repository_is_shallow():
    value = git_text("rev-parse", "--is-shallow-repository")
    if value not in ("true", "false"):
        raise RuntimeError("Git returned an invalid shallow-repository state")
    return value == "true"


def merge_base(source_sha, target_sha):
    try:
        value = git_text("merge-base", source_sha, target_sha)
    except GitFailure as error:
        if error.code == 1:
            return None
        raise
    if not re.fullmatch("[0-9a-f]{40}", value):
        raise RuntimeError("Git returned an invalid merge base")
    return value


def relevant_shallow_boundaries(source_sha, target_sha):
    shallow_path = Path(git_text("rev-parse", "--git-path", "shallow"))
    if not shallow_path.is_absolute():
        shallow_path = Path(workspace) / shallow_path
    boundaries = shallow_path.read_text(encoding="ascii").splitlines()
    if any(not re.fullmatch("[0-9a-f]{40}", boundary) for boundary in boundaries):
        raise RuntimeError("Git returned an invalid shallow boundary")
    return tuple(
        sorted(
            boundary
            for boundary in boundaries
            if git_test("merge-base", "--is-ancestor", boundary, source_sha)
            or git_test("merge-base", "--is-ancestor", boundary, target_sha)
        )
    )


def merge_base_is_final(base, boundaries):
    # A boundary newer than the visible base can hide a better or incomparable
    # base. Boundaries already behind that base cannot change Git's answer.
    for boundary in boundaries:
        if not git_test("merge-base", "--is-ancestor", boundary, base):
            return False
    return True


def inspect_relation(mode, source_sha, target_sha):
    shallow = repository_is_shallow()
    boundaries = relevant_shallow_boundaries(source_sha, target_sha) if shallow else ()
    if mode == "ancestor":
        if git_test("merge-base", "--is-ancestor", source_sha, target_sha):
            return "proven", boundaries
        return ("incomplete" if shallow else "invalid"), boundaries

    base = merge_base(source_sha, target_sha)
    if base is None:
        return ("incomplete" if shallow else "invalid"), boundaries
    if not shallow or merge_base_is_final(base, boundaries):
        return "proven", boundaries
    return "incomplete", boundaries


def reachable_commit_count(source_sha, target_sha):
    value = git_text("rev-list", "--count", source_sha, target_sha)
    if not value.isdigit():
        raise RuntimeError("Git returned an invalid reachable commit count")
    return int(value)


def relation_result(mode, source_sha, target_sha):
    relation, boundaries = inspect_relation(mode, source_sha, target_sha)
    if relation == "incomplete":
        return None, boundaries
    if relation == "proven":
        print(f"Established release {mode} relationship with {target_sha}.", flush=True)
        return 0, boundaries
    print(
        f"::error::Release {mode} relationship with {target_sha} is invalid after complete history.",
        flush=True,
    )
    return 1, boundaries


def establish_ancestry():
    mode = os.environ.get("RELEASE_ANCESTRY_MODE", "")
    target_ref = os.environ.get("RELEASE_ANCESTRY_TARGET_REF", "")
    if mode not in ("merge-base", "ancestor"):
        print("::error::Release ancestry mode must be merge-base or ancestor.", flush=True)
        return 2
    if not target_ref.startswith("refs/heads/") or not git_test("check-ref-format", target_ref):
        print("::error::Release ancestry target must be a valid branch ref.", flush=True)
        return 2
    target_local_ref = f"refs/remotes/origin/{target_ref[len('refs/heads/') :]}"
    source_sha = resolve_commit("HEAD")
    fetch_history(source_sha, f"+{target_ref}:{target_local_ref}", "--depth=64")
    # Freeze the branch after the first fetch. Later requests hydrate the live
    # branch into a separate ref: Git may not deepen a detached SHA want, while
    # every ancestry decision below remains bound to this immutable target.
    target_sha = resolve_commit(target_local_ref)
    result, previous_boundaries = relation_result(mode, source_sha, target_sha)
    if result is not None:
        return result

    previous_count = reachable_commit_count(source_sha, target_sha)
    # Seed the separate destination: Git may only create a new ref on the first
    # deepen, leaving existing shallow edges unchanged until the next fetch.
    run_git(workspace, "update-ref", target_hydration_local_ref, target_sha, timeout=operation_timeout())
    chunk_index = 0
    while True:
        chunk = deepen_chunks[min(chunk_index, len(deepen_chunks) - 1)]
        fetch_history(
            source_sha,
            f"+{target_ref}:{target_hydration_local_ref}",
            f"--deepen={chunk}",
        )
        result, current_boundaries = relation_result(mode, source_sha, target_sha)
        if result is not None:
            return result
        current_count = reachable_commit_count(source_sha, target_sha)
        if current_count < previous_count or (
            current_count == previous_count and current_boundaries == previous_boundaries
        ):
            print("::error::Release ancestry fetch completed without ancestry progress.", flush=True)
            return 125
        previous_count = current_count
        previous_boundaries = current_boundaries
        chunk_index += 1


try:
    raise SystemExit(establish_ancestry())
except TotalBudgetExpired:
    print("::error::Release ancestry exceeded its total time budget.", flush=True)
    raise SystemExit(124)
