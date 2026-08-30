import os
import re
import subprocess

from ci_git_owner import FetchTimeout, GitFailure, run_git


def quiet_git(*arguments):
    try:
        run_git(os.getcwd(), *arguments, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return True
    except GitFailure:
        return False


def ensure_base():
    base = os.environ["BASE_SHA"]
    ref = os.environ["FETCH_REF"]
    if not base or re.fullmatch("0+", base):
        print("No concrete base SHA available; skipping targeted fetch.")
        return 0
    if not re.fullmatch("[0-9a-fA-F]{7,40}", base):
        print(f"::error title=ensure-base-commit invalid base sha::Refusing invalid base SHA: {base}")
        return 2
    if not quiet_git("check-ref-format", "--branch", ref):
        print(f"::error title=ensure-base-commit invalid fetch ref::Refusing invalid fetch ref: {ref}")
        return 2
    if quiet_git("rev-parse", "--verify", f"{base}^{{commit}}"):
        print(f"Base commit already present: {base}")
        return 0

    attempts = [
        (
            ["--no-tags", "--depth=1", "origin", base],
            "Base commit missing; fetching exact SHA before branch history.",
            f"::warning title=ensure-base-commit exact fetch failed::Failed to fetch exact base SHA {base}",
            "exact fetch",
        ),
        *[(
            ["--no-tags", f"--deepen={depth}", "origin", "--", ref],
            f"Base commit missing; deepening {ref} by {depth}.",
            f"::warning title=ensure-base-commit fetch failed::Failed to deepen {ref} by {depth} while looking for {base}",
            "deepening",
        ) for depth in (25, 100, 300)],
        (
            ["--no-tags", "origin", "--", ref],
            f"Base commit still missing; fetching ref {ref}.",
            f"::warning title=ensure-base-commit fetch failed::Failed to fetch ref {ref} while looking for {base}",
            "full ref fetch",
        ),
    ]
    for arguments, message, warning, resolution in attempts:
        print(message, flush=True)
        try:
            run_git(os.getcwd(), "-c", "protocol.version=2", "fetch", *arguments,
                    timeout=30, reclaim_locks=True)
        except (GitFailure, FetchTimeout):
            # A failed fetch can still supply the base. Lifecycle failures and
            # cancellation escape this policy before any availability probe.
            print(warning)
        if quiet_git("rev-parse", "--verify", f"{base}^{{commit}}"):
            print(f"Resolved base commit after {resolution}: {base}")
            return 0
    print(f"::error title=ensure-base-commit missing base::Base commit still unavailable after fetch attempts: {base}")
    return 1


raise SystemExit(ensure_base())
