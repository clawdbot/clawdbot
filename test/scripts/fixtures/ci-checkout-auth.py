"""Exercise the checkout owner's authentication against real smart HTTP Git."""
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
from urllib.parse import urlsplit

owner = str(Path(sys.argv[1]).resolve())
mode = sys.argv[2]
git = shutil.which("git")
assert git, "Git is required for checkout authentication proof"

def cancelled(signum, _frame):
    raise SystemExit(128 + signum)

signal.signal(signal.SIGTERM, cancelled)

with tempfile.TemporaryDirectory(prefix="checkout-auth-") as directory:
    root = Path(directory)
    home = root / "home"
    home.mkdir()
    # Only tool-location/OS variables enter the fixture; real Git credentials,
    # helpers, config overrides and tracing from the host must never participate.
    env = {key: os.environ[key] for key in ("PATH", "SystemRoot", "SYSTEMROOT", "WINDIR")
           if key in os.environ}
    env.update(HOME=str(home), USERPROFILE=str(home), XDG_CONFIG_HOME=str(home),
               GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
               GIT_TERMINAL_PROMPT="0", LC_ALL="C")

    def command(*arguments, cwd=root, extra=None):
        return subprocess.run(arguments, cwd=cwd, env={**env, **(extra or {})},
                              capture_output=True, text=True, timeout=20)

    def checked(*arguments, **options):
        result = command(*arguments, **options)
        assert result.returncode == 0, result.stderr
        return result.stdout.strip()

    source = root / "source"
    checked(git, "init", "--initial-branch=main", str(source))
    (source / "payload.txt").write_text("checkout must hydrate this promised blob\n")
    setup_action = source / ".github/actions/setup-node-env/action.yml"
    setup_action.parent.mkdir(parents=True)
    setup_action.write_text("name: fixture\n")
    checked(git, "add", ".", cwd=source)
    checked(git, "-c", "user.name=Checkout Fixture", "-c", "user.email=fixture@example.invalid",
            "commit", "-m", "fixture", cwd=source)
    revision = checked(git, "rev-parse", "HEAD", cwd=source)
    historical_revision = revision
    if mode.startswith("qa-") and mode not in ("qa-main", "qa-main-no-dotgit", "qa-mismatch", "qa-foreign-origin"):
        checked(git, "checkout", "-b", "release/2026.9.1", cwd=source)
        (source / "payload.txt").write_text("release candidate outside main\n")
        checked(git, "add", "payload.txt", cwd=source)
        checked(git, "-c", "user.name=Checkout Fixture", "-c", "user.email=fixture@example.invalid",
                "commit", "-m", "release candidate", cwd=source)
        revision = checked(git, "rev-parse", "HEAD", cwd=source)
        if mode == "qa-tag":
            checked(git, "-c", "user.name=Checkout Fixture", "-c", "user.email=fixture@example.invalid",
                    "tag", "-a", "v2026.9.1", "-m", "release", cwd=source)
    if mode == "historical":
        (source / "payload.txt").write_text("current checkout\n")
        checked(git, "add", "payload.txt", cwd=source)
        checked(git, "-c", "user.name=Checkout Fixture", "-c", "user.email=fixture@example.invalid",
                "commit", "-m", "current", cwd=source)
        revision = checked(git, "rev-parse", "HEAD", cwd=source)
    blob = checked(git, "rev-parse", "HEAD:payload.txt", cwd=source)
    bare = root / ("repo" if mode == "qa-main-no-dotgit" else "repo.git")
    checked(git, "clone", "--bare", str(source), str(bare))
    checked(git, "config", "uploadpack.allowFilter", "true", cwd=bare)
    checked(git, "config", "uploadpack.allowAnySHA1InWant", "true", cwd=bare)
    if mode in ("qa-untrusted", "qa-pr", "qa-api-error"):
        checked(git, "update-ref", "-d", "refs/heads/release/2026.9.1", cwd=bare)
    token = "synthetic-checkout-fixture"
    encoded = base64.b64encode(f"x-access-token:{token}".encode()).decode()
    authorization = f"Basic {encoded}"
    requests = []
    kova_methods = []
    redirect = False

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            self.serve_git()

        def do_POST(self):
            self.serve_git()

        def serve_git(self):
            parsed = urlsplit(self.path)
            headers = self.headers.get_all("Authorization") or []
            authenticated = len(headers) == 1 and headers[0].lower().startswith("basic ") and headers[0][6:] == encoded
            requests.append({"path": parsed.path, "authenticated": authenticated,
                             "authorizationPresent": bool(headers)})
            if parsed.path.startswith("/other.git"):
                self.send_error(404)
                return
            if redirect:
                self.send_response(302)
                self.send_header("Location", f"/other.git/info/refs?{parsed.query}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if mode == "kova":
                kova_methods.append(self.command)
            public_fetch = mode == "kova" and kova_methods.count("GET") == 1
            if not authenticated and not public_fetch:
                self.send_response(401)
                self.send_header("WWW-Authenticate", 'Basic realm="checkout fixture"')
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            backend = subprocess.run(
                [git, "http-backend"], input=body, capture_output=True, timeout=15,
                env={**env, "GIT_PROJECT_ROOT": str(root), "GIT_HTTP_EXPORT_ALL": "1",
                     "PATH_INFO": parsed.path, "QUERY_STRING": parsed.query,
                     "REQUEST_METHOD": self.command,
                     "CONTENT_TYPE": self.headers.get("Content-Type", ""),
                     "CONTENT_LENGTH": str(len(body)),
                     "HTTP_GIT_PROTOCOL": self.headers.get("Git-Protocol", "")})
            assert backend.returncode == 0, backend.stderr.decode()
            headers, separator, response = backend.stdout.partition(b"\r\n\r\n")
            if not separator:
                headers, separator, response = backend.stdout.partition(b"\n\n")
            assert separator, "Git HTTP backend omitted CGI headers"
            fields = [line.split(b":", 1) for line in headers.splitlines()]
            code = next((int(value.strip().split()[0]) for key, value in fields
                         if key.lower() == b"status"), 200)
            self.send_response(code)
            for key, value in fields:
                if key.lower() != b"status":
                    self.send_header(key.decode(), value.strip().decode())
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever)
    thread.start()
    try:
        remote = f"http://127.0.0.1:{server.server_port}/{bare.name}"
        workspace = root / "workspace"
        if mode == "kova":
            # Keep the whole workflow body intact. Only unrelated OCM/npm tools
            # are stubbed; Git talks to the real server for every object it needs.
            workspace = root / "kova-src"
            (root / "ocm-install").mkdir()
            (root / "ocm-install/ocm").write_text("#!/bin/sh\nexit 0\n")
            script = '''curl() { :; }
sha256sum() { cat >/dev/null; }
tar() { :; }
npm() { test -s "$KOVA_SRC/payload.txt"; }
node() { :; }
''' + sys.argv[3]
            config = home / ".gitconfig"
            checked(git, "config", "--file", str(config), f"url.{remote}.insteadOf",
                    "https://github.com/fixture/kova.git")
            result = command("bash", "-e", "-o", "pipefail", "-c", script, extra={
                "GIT_CONFIG_GLOBAL": str(config), "CI_GIT_OWNER": owner,
                "RUNNER_TEMP": str(root), "KOVA_HOME": str(home / "kova"),
                "GITHUB_ENV": str(root / "environment"), "GITHUB_PATH": str(root / "path"),
                "OCM_VERSION": "fixture", "OCM_LINUX_X64_SHA256": "fixture",
                "KOVA_REPOSITORY": "fixture/kova", "KOVA_REF": revision})
            complete = result.returncode == 0 and (workspace / "payload.txt").read_text() == (source / "payload.txt").read_text()
            local_config = (workspace / ".git/config").read_text()
            assert token not in result.stdout + result.stderr + local_config
            assert encoded not in result.stdout + result.stderr + local_config
            print(json.dumps({"mode": mode, "exitCode": result.returncode, "stderr": result.stderr,
                              "checkoutComplete": complete, "sessions": kova_methods.count("GET"),
                              "credentialPersisted": "extraheader" in local_config.lower(), "requests": requests}))
            raise SystemExit(0)
        checked(git, "init", str(workspace))
        checked(git, "remote", "add", "origin", remote, cwd=workspace)
        if mode.startswith("qa-"):
            # Reproduce checkout@v7's complete authenticated ref snapshot, then
            # remove its credential scope before executing the actual validator.
            seed_auth = {"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": f"http.{remote}.extraHeader",
                         "GIT_CONFIG_VALUE_0": f"Authorization: Basic {encoded}"}
            checked(git, "fetch", "--no-tags", "--prune", "origin",
                    "+refs/heads/*:refs/remotes/origin/*", "+refs/tags/*:refs/tags/*", cwd=workspace, extra=seed_auth)
            if mode in ("qa-untrusted", "qa-pr", "qa-api-error"):
                checked(git, "fetch", "--no-tags", "origin", revision, cwd=workspace, extra=seed_auth)
            checked(git, "checkout", "--detach", revision, cwd=workspace)
            requests.clear()
            if mode == "qa-foreign-origin":
                checked(git, "remote", "set-url", "origin", remote.replace("/repo.git", "/other.git"), cwd=workspace)
            output = root / "output"
            summary = root / "summary"
            fixture_bin = root / "bin"
            fixture_bin.mkdir()
            gh = fixture_bin / "gh"
            gh.write_text(f'''#!{sys.executable}
import os, sys
assert os.environ["GH_TOKEN"] == {token!r}
print("1")
sys.exit({23 if mode == "qa-api-error" else 0})
''')
            gh.chmod(0o755)
            expected = revision if mode in ("qa-exact", "qa-untrusted") else ""
            if mode == "qa-mismatch":
                expected = "f" * 40
            result = command("bash", "-e", "-o", "pipefail", "-c", sys.argv[3], cwd=workspace, extra={
                "PATH": str(fixture_bin) + os.pathsep + env["PATH"], "CI_GIT_OWNER": owner,
                "GH_TOKEN": token, "GITHUB_REPOSITORY": "repo",
                "GITHUB_SERVER_URL": f"http://127.0.0.1:{server.server_port}",
                "GITHUB_OUTPUT": str(output), "GITHUB_STEP_SUMMARY": str(summary),
                "EXPECTED_SHA": expected,
                "INPUT_REF": "release/2026.9.1" if mode == "qa-branch" else revision})
            outputs = dict(line.split("=", 1) for line in output.read_text().splitlines()) if output.exists() else {}
            local_config = (workspace / ".git/config").read_text()
            published = result.stdout + result.stderr + local_config + (output.read_text() if output.exists() else "")
            assert token not in published and encoded not in published
            print(json.dumps({"mode": mode, "exitCode": result.returncode, "stderr": result.stderr,
                              "trustedReason": outputs.get("trusted_reason", ""),
                              "selectedRevisionMatched": outputs.get("selected_revision") == revision,
                              "fetchAuthenticated": all(item["authenticated"] for item in requests),
                              "credentialPersisted": "extraheader" in local_config.lower(), "requests": requests}))
            raise SystemExit(0)
        policy = root / "policy.py"
        policy.write_text('''from ci_git_owner import run_git, git_output
import json, os, sys
remote, token, phase = sys.argv[3:]
if phase == "fetch-only":
    import base64
    encoded = base64.b64encode(f"x-access-token:{token}".encode()).decode()
    auth = {"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": f"http.{remote}.extraHeader",
            "GIT_CONFIG_VALUE_0": f"Authorization: Basic {encoded}"}
else:
    from ci_git_owner import git_auth_environment
    os.environ.update(GIT_CONFIG_COUNT="1", GIT_CONFIG_KEY_0="fixture.inherited",
                      GIT_CONFIG_VALUE_0="retained")
    inherited = dict(os.environ)
    auth = git_auth_environment(remote, token)
    assert dict(os.environ) == inherited, "auth helper mutated the policy environment"
    assert git_output(os.getcwd(), "config", "--get", "fixture.inherited", env=auth).strip() == "retained"
if phase in ("fetch-only", "fetch"):
    run_git(os.getcwd(), "-c", "protocol.version=2", "fetch", "--filter=blob:none",
            "--depth=1", "origin", "refs/heads/main", env=auth, timeout=15)
elif phase == "checkout":
    run_git(os.getcwd(), "checkout", "--detach", "FETCH_HEAD", env=auth, timeout=15)
elif phase == "scope":
    run_git(os.getcwd(), "ls-remote", remote.replace("/repo.git", "/other.git"),
            env=auth, timeout=15)
elif phase == "scope-host":
    run_git(os.getcwd(), "ls-remote", remote.replace("127.0.0.1", "localhost"),
            env=auth, timeout=15)
elif phase == "redirect":
    run_git(os.getcwd(), "ls-remote", remote, env=auth, timeout=15)
''')

        def owned(phase, selected_policy=policy):
            with subprocess.Popen([sys.executable, "-I", "-S", owner, "--policy", str(selected_policy),
                                   remote, token, phase], cwd=workspace, env=env,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) as child:
                try:
                    stdout, stderr = child.communicate(timeout=25)
                except BaseException:
                    # The Git owner must drain its separately owned Git groups
                    # before this fixture closes the server or removes its root.
                    child.terminate()
                    try:
                        child.communicate(timeout=12)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait()
                        raise RuntimeError("checkout owner did not finish cancellation cleanup")
                    raise
                return subprocess.CompletedProcess(child.args, child.returncode, stdout, stderr)

        if mode == "historical":
            env["GIT_CONFIG_GLOBAL"] = str(home / ".gitconfig")
            policy.write_text('''import ci_git_owner as owner
import json, os, sys
from pathlib import Path
remote, token, phase = sys.argv[3:]
owner.kind, owner.reset = "linux-node", True
owner.workspace, owner.remote = os.getcwd(), remote
owner.checkout_environment = owner.git_auth_environment(remote, token)
try:
    owner.checkout()
finally:
    owner.checkout_environment.clear()
historical = json.loads(os.environ["CHECKOUT_GIT_COMMITS_JSON"])[0]
owner.run_git(os.getcwd(), "cat-file", "-e", historical + "^{commit}")
reader = str(Path.cwd().parent / "historical-reader")
owner.run_git(os.getcwd(), "worktree", "add", "--detach", reader, historical)
assert Path(reader, "payload.txt").read_text() == "checkout must hydrate this promised blob\\n"
owner.run_git(os.getcwd(), "worktree", "remove", reader)
''')
            env.update(CHECKOUT_SHA=revision, WORKFLOW_SHA=revision,
                       CHECKOUT_GIT_COMMITS_JSON=json.dumps([historical_revision]))
            result = owned("historical")
            assert result.returncode == 0, result.stderr
            assert requests and all(item["authenticated"] for item in requests)
            config = (workspace / ".git/config").read_text()
            assert token not in config and encoded not in config and "extraheader" not in config.lower()
            assert checked(git, "rev-parse", "HEAD", cwd=workspace) == revision
            print(json.dumps({"historicalReaderPrepared": True, "credentialPersisted": False}))
            raise SystemExit(0)

        fetched = owned("fetch-only" if mode == "fetch-only" else "fetch")
        assert fetched.returncode == 0, fetched.stderr
        assert requests and all(item["authenticated"] for item in requests)
        assert checked(git, "config", "remote.origin.promisor", cwd=workspace) == "true"
        missing = checked(git, "rev-list", "--objects", "--missing=print", "FETCH_HEAD", cwd=workspace)
        assert f"?{blob}" in missing, "initial filtered fetch unexpectedly downloaded the blob"
        fetch_requests = len(requests)
        if mode == "fetch-only":
            # Use the unmodified owner's actual checkout call: authentication on
            # the earlier fetch alone cannot reach the lazy promisor subprocess.
            policy.write_text('''from ci_git_owner import run_git
import os
run_git(os.getcwd(), "checkout", "--detach", "FETCH_HEAD", timeout=15)
''')
        hydrated = owned("checkout")
        assert len(requests) > fetch_requests, "checkout did not exercise lazy network hydration"
        if mode == "fetch-only":
            assert hydrated.returncode != 0, "unauthenticated lazy checkout unexpectedly succeeded"
            assert any(not item["authenticated"] for item in requests[fetch_requests:])
            assert "could not fetch" in hydrated.stderr, hydrated.stderr
        else:
            assert hydrated.returncode == 0, hydrated.stderr
            assert all(item["authenticated"] for item in requests[fetch_requests:])
            assert (workspace / "payload.txt").read_text() == (source / "payload.txt").read_text()
            assert checked(git, "rev-parse", "HEAD", cwd=workspace) == revision
            scoped = owned("scope")
            assert scoped.returncode != 0
            assert requests[-1] == {"path": "/other.git/info/refs", "authenticated": False, "authorizationPresent": False}
            scoped_host = owned("scope-host")
            assert scoped_host.returncode != 0
            assert requests[-1] == {"path": "/repo.git/info/refs", "authenticated": False, "authorizationPresent": False}
            before_redirect = len(requests)
            redirect = True
            redirected = owned("redirect")
            assert redirected.returncode != 0
            assert requests[before_redirect:] == [{"path": "/repo.git/info/refs", "authenticated": True, "authorizationPresent": True}]
        if mode != "fetch-only":
            entry = root / "entry.py"
            entry.write_text('''import ci_git_owner as owner
import base64, os, sys
_, token, phase = sys.argv[3:]
sys.argv = [sys.argv[0]]
expected_auth = phase not in ("cross-repository", "missing-token")
os.environ.update(CHECKOUT_KIND="platform", GITHUB_WORKSPACE=os.getcwd(),
                  CHECKOUT_REPO="fixture/repository", GITHUB_REPOSITORY="fixture/repository")
if phase == "cross-repository":
    os.environ["GITHUB_REPOSITORY"] = "fixture/other"
if phase != "missing-token":
    os.environ["CHECKOUT_TOKEN"] = token
header = "AUTHORIZATION: basic " + base64.b64encode(f"x-access-token:{token}".encode()).decode()
def observed_header():
    try:
        return owner.git_output(os.getcwd(), "config", "--get-urlmatch", "http.extraheader", owner.remote).strip()
    except owner.GitFailure as error:
        assert error.code == 1
        return ""
def checkout():
    assert observed_header() == (header if expected_auth else "")
    owner.run_git(os.getcwd(), "-c", 'alias.token-absent=!test "${CHECKOUT_TOKEN+x}" != x', "token-absent")
    if phase == "failure":
        raise owner.GitFailure(23)
owner.checkout = checkout
try:
    owner.main()
except SystemExit as error:
    assert error.code == (23 if phase == "failure" else 0)
else:
    raise AssertionError("main returned instead of reporting checkout outcome")
assert not owner.checkout_environment, "checkout auth survived entry completion"
assert observed_header() == "", "later generic Git inherited checkout authentication"
print("main entry scope and cleanup passed")
''')
            for phase in ("success", "failure", "cross-repository", "missing-token"):
                result = owned(phase, entry)
                assert result.returncode == 0, result.stderr
                assert result.stdout.strip() == "main entry scope and cleanup passed"
        config = (workspace / ".git/config").read_text()
        assert token not in config and encoded not in config and "extraheader" not in config.lower()
        assert "followredirects" not in config.lower()
        for result in [fetched, hydrated]:
            assert token not in result.stdout + result.stderr
            assert encoded not in result.stdout + result.stderr
        print(json.dumps({"mode": mode, "fetchAuthenticated": True,
                          "lazyCheckoutSucceeded": hydrated.returncode == 0,
                          "missingBlobBeforeCheckout": True,
                          "credentialPersisted": False, "requests": requests}))
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        assert not thread.is_alive(), "Git fixture HTTP server survived cleanup"
