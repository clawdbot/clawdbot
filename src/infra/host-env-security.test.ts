// Covers host environment sanitization and dangerous key detection.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isDangerousHostEnvOverrideVarName,
  isDangerousHostInheritedEnvVarName,
  isDangerousHostEnvVarName,
  normalizeEnvVarKey,
  sanitizeHostExecEnv,
  sanitizeHostExecEnvWithDiagnostics,
  sanitizeSystemRunEnvOverrides,
} from "./host-env-security.js";

const OPENCLAW_CLI_ENV_VALUE = "1";

function findSystemCommandPath(command: string) {
  if (process.platform === "win32") {
    return null;
  }
  for (const dir of (process.env.PATH ?? "/usr/bin:/bin").split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, command);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function getSystemGitPath() {
  return findSystemCommandPath("git");
}

function getSystemMakePath() {
  return findSystemCommandPath("make");
}

function clearMarker(marker: string) {
  try {
    fs.unlinkSync(marker);
  } catch {
    // no-op
  }
}

function listKeys(source: string): string[] {
  return source.trim().split(/\s+/u);
}

function envRecord(
  entries: ReadonlyArray<readonly [string, string]> | string,
): Record<string, string> {
  if (typeof entries !== "string") {
    return Object.fromEntries(entries);
  }
  return Object.fromEntries(
    entries
      .trim()
      .split(/\n|\s+\|\s+/u)
      .map((entry) => {
        const separator = entry.indexOf("=");
        if (separator < 1) {
          throw new Error(`invalid env fixture entry: ${entry}`);
        }
        return [entry.slice(0, separator).trim(), entry.slice(separator + 1).trim()];
      }),
  );
}

function expectPolicyCases(check: (key: string) => boolean, source: string): void {
  for (const encoded of listKeys(source)) {
    const marker = encoded[0];
    if (marker !== "+" && marker !== "-") {
      throw new Error(`invalid policy fixture entry: ${encoded}`);
    }
    expect(check(encoded.slice(1))).toBe(marker === "+");
  }
}

function expectEnvKeysUndefined(env: Record<string, string | undefined>, source: string): void {
  for (const key of listKeys(source)) {
    expect(env[key]).toBeUndefined();
  }
}

async function runGitLsRemote(gitPath: string, target: string, env: NodeJS.ProcessEnv) {
  await new Promise<void>((resolve) => {
    const child = spawn(gitPath, ["ls-remote", target], { env, stdio: "ignore" });
    child.once("error", () => resolve());
    child.once("close", () => resolve());
  });
}

async function runGitCommand(
  gitPath: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  },
) {
  await new Promise<void>((resolve) => {
    const child = spawn(gitPath, args, {
      cwd: options?.cwd,
      env: options?.env,
      stdio: "ignore",
    });
    child.once("error", () => resolve());
    child.once("close", () => resolve());
  });
}

async function runGitCommandExitCode(
  gitPath: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<number | null> {
  return await new Promise<number | null>((resolve) => {
    const child = spawn(gitPath, args, {
      cwd: options?.cwd,
      env: options?.env,
      stdio: "ignore",
    });
    child.once("error", () => resolve(null));
    child.once("close", (code) => resolve(code));
  });
}

async function runGitClone(
  gitPath: string,
  source: string,
  destination: string,
  env: NodeJS.ProcessEnv,
) {
  await runGitCommand(gitPath, ["clone", source, destination], { env });
}

async function initGitRepoWithCommits(gitPath: string, repoDir: string, commitCount: number) {
  await runGitCommand(gitPath, ["init", repoDir]);
  for (let index = 1; index <= commitCount; index += 1) {
    fs.writeFileSync(path.join(repoDir, `commit-${index}.txt`), `commit ${index}\n`, "utf8");
    await runGitCommand(gitPath, ["-C", repoDir, "add", "."], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
      },
    });
    await runGitCommand(
      gitPath,
      [
        "-C",
        repoDir,
        "-c",
        "user.name=OpenClaw Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-m",
        `commit ${index}`,
      ],
      {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
        },
      },
    );
  }
}

async function runMakeCommand(makePath: string, cwd: string, env: NodeJS.ProcessEnv) {
  await new Promise<void>((resolve) => {
    const child = spawn(makePath, ["all"], {
      cwd,
      env,
      stdio: "ignore",
    });
    child.once("error", () => resolve());
    child.once("close", () => resolve());
  });
}

describe("isDangerousHostEnvVarName", () => {
  it("matches dangerous keys and prefixes case-insensitively", () => {
    expectPolicyCases(
      isDangerousHostEnvVarName,
      `+BASH_ENV +bash_env +BROWSER +browser +SHELL +GIT_ALLOW_PROTOCOL +git_protocol_from_user
+GIT_EDITOR +git_editor +GIT_EXTERNAL_DIFF +GIT_DIR +git_work_tree +GIT_COMMON_DIR
+git_exec_path +GIT_INDEX_FILE +git_object_directory +git_alternate_object_directories
+GIT_NAMESPACE +GIT_SEQUENCE_EDITOR +git_sequence_editor +GIT_TEMPLATE_DIR +git_template_dir
-KUBECONFIG -google_application_credentials -AWS_SHARED_CREDENTIALS_FILE
-aws_web_identity_token_file -AZURE_AUTH_LOCATION +CC +cpp +cxx +cxxcpp +CARGO_BUILD_RUSTC
+cargo_build_rustc +CARGO_BUILD_RUSTC_WRAPPER +cargo_build_rustc_wrapper
+CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER +cargo_build_rustc_workspace_wrapper +CARGO_BUILD_RUSTDOC
+cargo_build_rustdoc -cargo_home -RUSTUP_DIST_SERVER -RUSTUP_HOME -rustup_update_root
-rustup_toolchain +CMAKE_C_COMPILER +cmake_c_compiler +CMAKE_CXX_COMPILER +cmake_cxx_compiler
+RUSTC +rustc +RUSTC_WRAPPER +rustc_wrapper +RUSTC_WORKSPACE_WRAPPER +rustc_workspace_wrapper
+RUSTDOC +rustdoc -HELM_HOME +SHELLOPTS +ps4 +DYLD_INSERT_LIBRARIES +ld_preload
+BASH_FUNC_echo%% +JAVA_OPTS +java_opts +JAVA_TOOL_OPTIONS +java_tool_options +_JAVA_OPTIONS
+_java_options +JDK_JAVA_OPTIONS +jdk_java_options +PYTHONBREAKPOINT +pythonbreakpoint
+DOTNET_STARTUP_HOOKS +dotnet_startup_hooks +DOTNET_ADDITIONAL_DEPS +dotnet_additional_deps
+GLIBC_TUNABLES +glibc_tunables +MAVEN_OPTS +maven_opts +MAKE +make +MAKEFLAGS +makeflags
+NODE_REDIRECT_WARNINGS +node_redirect_warnings +NODE_REPL_EXTERNAL_MODULE
+node_repl_external_module +NODE_REPL_HISTORY +node_repl_history +NODE_V8_COVERAGE
+node_v8_coverage +MFLAGS +mflags +SBT_OPTS +sbt_opts +GRADLE_OPTS +gradle_opts +ANT_OPTS
+ant_opts +HGRCPATH +hgrcpath +HGEDITOR +hgeditor +HGMERGE +hgmerge -HTTPS_PROXY -https_proxy
-HTTP_PROXY -http_proxy -ALL_PROXY -no_proxy -NODE_TLS_REJECT_UNAUTHORIZED -node_extra_ca_certs
-SSL_CERT_FILE -SSL_CERT_DIR -requests_ca_bundle -CURL_CA_BUNDLE -DOCKER_HOST -docker_cert_path
-DOCKER_TLS_VERIFY -CARGO_REGISTRIES_CRATES_IO_INDEX -AWS_CONFIG_FILE -aws_config_file
-yarn_rc_filename +BASHOPTS +bashopts +FPATH +fpath +KSH_ENV +ksh_env +TCLLIBPATH +tcllibpath
-PATH -FOO -GRADLE_USER_HOME`,
    );
  });

  it("blocks newly added startup, orchestration, and resolver env keys", () => {
    const keys = listKeys(`VIMINIT EXINIT MYVIMRC GVIMINIT LUA_INIT LUA_INIT_5_4 HOSTALIASES
CONFIG_SITE CONFIG_SHELL CMAKE_TOOLCHAIN_FILE ERL_AFLAGS ERL_FLAGS ERL_ZFLAGS R_ENVIRON
R_PROFILE_USER`);

    for (const key of keys) {
      expect(isDangerousHostEnvVarName(key)).toBe(true);
      expect(isDangerousHostEnvVarName(key.toLowerCase())).toBe(true);
    }

    expect(isDangerousHostEnvVarName("ANSIBLE_CONFIG")).toBe(false);
    expect(isDangerousHostEnvVarName("ANSIBLE_LIBRARY")).toBe(false);
    expect(isDangerousHostEnvVarName("TF_CLI_CONFIG_FILE")).toBe(false);
    expect(isDangerousHostEnvVarName("AWS_CONTAINER_CREDENTIALS_FULL_URI")).toBe(false);
    expect(isDangerousHostEnvVarName("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI")).toBe(false);
  });
});

describe("isDangerousHostInheritedEnvVarName", () => {
  it("blocks inherited keys from both policy buckets while preserving explicit inherited allowlist keys", () => {
    expectPolicyCases(
      isDangerousHostInheritedEnvVarName,
      `+BASH_ENV +bash_env +ANSIBLE_CONFIG +ansible_library +TF_CLI_CONFIG_FILE -TF_VAR_admin_cidr
+AWS_CONTAINER_CREDENTIALS_FULL_URI +AWS_CONTAINER_CREDENTIALS_RELATIVE_URI -KUBECONFIG
-GOOGLE_APPLICATION_CREDENTIALS -AWS_SHARED_CREDENTIALS_FILE -AWS_WEB_IDENTITY_TOKEN_FILE
-AWS_CONFIG_FILE -AZURE_AUTH_LOCATION -SSH_AUTH_SOCK -DOCKER_CONTEXT -GIT_CONFIG_GLOBAL
-NPM_CONFIG_USERCONFIG -CARGO_REGISTRIES_CRATES_IO_INDEX -HTTP_PROXY -https_proxy -SSL_CERT_FILE
-node_extra_ca_certs -HOME -FOO`,
    );
  });
});

describe("sanitizeHostExecEnv", () => {
  it("removes dangerous inherited keys while preserving PATH", () => {
    const env = sanitizeHostExecEnv({
      baseEnv: envRecord(`PATH=/usr/bin:/bin | BASH_ENV=/tmp/pwn.sh | BROWSER=/tmp/pwn-browser
GIT_ALLOW_PROTOCOL=ext | GIT_EDITOR=/tmp/pwn-editor | GIT_EXTERNAL_DIFF=/tmp/pwn.sh
GIT_DIR=/tmp/evil-git-dir | GIT_WORK_TREE=/tmp/evil-work-tree
GIT_COMMON_DIR=/tmp/evil-common-dir | GIT_TEMPLATE_DIR=/tmp/git-template
GIT_INDEX_FILE=/tmp/evil-git-index | GIT_OBJECT_DIRECTORY=/tmp/evil-git-objects
GIT_ALTERNATE_OBJECT_DIRECTORIES=/tmp/evil-git-alt-objects | GIT_NAMESPACE=evil-namespace
GIT_PROTOCOL_FROM_USER=1 | GIT_SEQUENCE_EDITOR=/tmp/pwn-sequence-editor | HGRCPATH=/tmp/evil-hgrc
CARGO_BUILD_RUSTC_WRAPPER=/tmp/evil-rustc-wrapper | RUSTC_WRAPPER=/tmp/evil-rustc-wrapper
JAVA_OPTS=-javaagent:/tmp/evil.jar | MAKEFLAGS=--eval=$(shell touch /tmp/pwned)
MFLAGS=--eval=$(shell touch /tmp/pwned-too) | KUBECONFIG=/tmp/kubeconfig
GOOGLE_APPLICATION_CREDENTIALS=/tmp/gcp.json | AWS_SHARED_CREDENTIALS_FILE=/tmp/aws-credentials
AWS_WEB_IDENTITY_TOKEN_FILE=/tmp/aws-web-token | AZURE_AUTH_LOCATION=/tmp/azure-auth.json
AWS_CONFIG_FILE=/tmp/aws-config | SSH_AUTH_SOCK=/tmp/trusted-ssh-agent.sock | CPP=/tmp/evil-cpp
CARGO_HOME=/tmp/cargo | RUSTUP_DIST_ROOT=https://mirror.example.test/deprecated-dist
RUSTUP_DIST_SERVER=https://mirror.example.test | RUSTUP_HOME=/tmp/rustup-home
RUSTUP_TOOLCHAIN=/tmp/rustup-toolchain | RUSTUP_UPDATE_ROOT=https://mirror.example.test/rustup
HELM_HOME=/tmp/helm | HTTP_PROXY=http://proxy.example.test:8080
HTTPS_PROXY=http://proxy.example.test:8443 | SSL_CERT_FILE=/tmp/evil-cert.pem
SSL_CERT_DIR=/tmp/evil-cert-dir | DOCKER_CONTEXT=trusted-remote
DOCKER_HOST=tcp://docker.example.test:2376 | LD_PRELOAD=/tmp/pwn.so | BASHOPTS=xtrace
FPATH=/tmp/evil-fpath | KSH_ENV=/tmp/evil-ksh-env | TCLLIBPATH=/tmp/evil-tcllibpath
NODE_REDIRECT_WARNINGS=/tmp/node-warnings.log | NODE_REPL_EXTERNAL_MODULE=/tmp/pwn.js
NODE_REPL_HISTORY=/tmp/node-repl-history | NODE_V8_COVERAGE=/tmp/coverage | OK=1`),
    });

    expect(env).toEqual(
      envRecord(`OPENCLAW_CLI=${OPENCLAW_CLI_ENV_VALUE} | PATH=/usr/bin:/bin
AWS_CONFIG_FILE=/tmp/aws-config | KUBECONFIG=/tmp/kubeconfig
GOOGLE_APPLICATION_CREDENTIALS=/tmp/gcp.json | AWS_SHARED_CREDENTIALS_FILE=/tmp/aws-credentials
AWS_WEB_IDENTITY_TOKEN_FILE=/tmp/aws-web-token | AZURE_AUTH_LOCATION=/tmp/azure-auth.json
SSH_AUTH_SOCK=/tmp/trusted-ssh-agent.sock | HTTP_PROXY=http://proxy.example.test:8080
HTTPS_PROXY=http://proxy.example.test:8443 | SSL_CERT_FILE=/tmp/evil-cert.pem
SSL_CERT_DIR=/tmp/evil-cert-dir | DOCKER_CONTEXT=trusted-remote
DOCKER_HOST=tcp://docker.example.test:2376 | GIT_ALLOW_PROTOCOL= | GIT_PROTOCOL_FROM_USER=0
RUSTUP_DIST_ROOT=https://mirror.example.test/deprecated-dist
RUSTUP_DIST_SERVER=https://mirror.example.test | RUSTUP_HOME=/tmp/rustup-home
RUSTUP_TOOLCHAIN=/tmp/rustup-toolchain | RUSTUP_UPDATE_ROOT=https://mirror.example.test/rustup | OK=1`),
    );
  });

  it("preserves inherited non-permissive GIT_PROTOCOL_FROM_USER values", () => {
    const restrictiveValues = ["", "0", "00", "+0", "-0", "false", "False", "no", "off", "maybe"];

    for (const value of restrictiveValues) {
      const env = sanitizeHostExecEnv({
        baseEnv: {
          PATH: "/usr/bin:/bin",
          GIT_PROTOCOL_FROM_USER: value,
        },
      });

      expect(env.GIT_PROTOCOL_FROM_USER).toBe(value);
    }
  });

  it("preserves inherited safe GIT_ALLOW_PROTOCOL allowlist values", () => {
    const safeValues = ["", "git", "https:ssh", "git:http:https:ssh"];

    for (const value of safeValues) {
      const env = sanitizeHostExecEnv({
        baseEnv: {
          PATH: "/usr/bin:/bin",
          GIT_ALLOW_PROTOCOL: value,
        },
      });

      expect(env.GIT_ALLOW_PROTOCOL).toBe(value);
    }
  });

  it("filters inherited GIT_ALLOW_PROTOCOL allowlists to Git safe defaults", () => {
    const cases = [
      ["ext", ""],
      ["https:ext", "https"],
      ["file", ""],
      ["https:file", "https"],
      ["hg", ""],
      ["https::ssh", "https:ssh"],
    ] as const;

    for (const [value, expected] of cases) {
      const env = sanitizeHostExecEnv({
        baseEnv: {
          PATH: "/usr/bin:/bin",
          GIT_ALLOW_PROTOCOL: value,
        },
      });

      expect(env.GIT_ALLOW_PROTOCOL).toBe(expected);
    }
  });

  it("forces inherited permissive GIT_PROTOCOL_FROM_USER values to the Git disabled value", () => {
    const permissiveValues = ["1", "01", "+1", "-1", "2", "true", "yes", "on"];

    for (const value of permissiveValues) {
      const env = sanitizeHostExecEnv({
        baseEnv: {
          PATH: "/usr/bin:/bin",
          GIT_PROTOCOL_FROM_USER: value,
        },
      });

      expect(env.GIT_PROTOCOL_FROM_USER).toBe("0");
    }
  });

  it("blocks PATH and dangerous override values", () => {
    const baseEnv = envRecord(`PATH=/usr/bin:/bin | HOME=/tmp/trusted-home
ZDOTDIR=/tmp/trusted-zdotdir
CARGO_REGISTRIES_CRATES_IO_INDEX=https://trusted.example/crates.io-index
YARN_RC_FILENAME=.trusted-yarnrc.yml`);
    const overrides = envRecord(`PATH=/tmp/evil | HOME=/tmp/evil-home | ZDOTDIR=/tmp/evil-zdotdir
BASH_ENV=/tmp/pwn.sh | BROWSER=/tmp/browser | CC=/tmp/evil-cc | CPP=/tmp/evil-cpp | CXX=/tmp/evil-cxx
CARGO_BUILD_RUSTC=/tmp/evil-rustc | CARGO_BUILD_RUSTC_WRAPPER=/tmp/evil-rustc-wrapper
CMAKE_C_COMPILER=/tmp/evil-c-compiler | CMAKE_CXX_COMPILER=/tmp/evil-cxx-compiler
RUSTC_WRAPPER=/tmp/evil-rustc-wrapper | HGRCPATH=/tmp/evil-hgrc | GIT_ALLOW_PROTOCOL=ext
GIT_PROTOCOL_FROM_USER=1 | GIT_SSH_COMMAND=touch /tmp/pwned | GIT_EDITOR=/tmp/git-editor
GIT_DIR=/tmp/evil-git-dir | GIT_WORK_TREE=/tmp/evil-work-tree | GIT_COMMON_DIR=/tmp/evil-common-dir
GIT_EXEC_PATH=/tmp/git-exec-path | GIT_INDEX_FILE=/tmp/evil-git-index
GIT_OBJECT_DIRECTORY=/tmp/evil-git-objects
GIT_ALTERNATE_OBJECT_DIRECTORIES=/tmp/evil-git-alt-objects | GIT_NAMESPACE=evil-namespace
GIT_SEQUENCE_EDITOR=/tmp/git-sequence-editor | EDITOR=/tmp/editor | NPM_CONFIG_USERCONFIG=/tmp/npmrc
GIT_CONFIG_GLOBAL=/tmp/gitconfig
CARGO_REGISTRIES_CRATES_IO_INDEX=https://example.invalid/crates.io-index
AWS_CONFIG_FILE=/tmp/override-aws-config | YARN_RC_FILENAME=.evil-yarnrc.yml
KUBECONFIG=/tmp/override-kubeconfig | GOOGLE_APPLICATION_CREDENTIALS=/tmp/override-gcp.json
AWS_SHARED_CREDENTIALS_FILE=/tmp/override-aws-credentials
AWS_WEB_IDENTITY_TOKEN_FILE=/tmp/override-aws-web-token
AZURE_AUTH_LOCATION=/tmp/override-azure-auth.json | PIP_INDEX_URL=https://example.invalid/simple
PIP_PYPI_URL=https://example.invalid/simple | PIP_EXTRA_INDEX_URL=https://example.invalid/simple
PIP_CONFIG_FILE=/tmp/evil-pip.conf | PIP_FIND_LINKS=https://example.invalid/wheels
PIP_TRUSTED_HOST=example.invalid | UV_INDEX=https://example.invalid/simple
UV_INDEX_URL=https://example.invalid/simple | UV_PYTHON=/tmp/evil-uv-python
UV_DEFAULT_INDEX=https://example.invalid/simple | UV_EXTRA_INDEX_URL=https://example.invalid/simple
DOCKER_HOST=tcp://example.invalid:2376 | DOCKER_TLS_VERIFY=1 | DOCKER_CERT_PATH=/tmp/evil-docker-certs
DOCKER_CONTEXT=evil-remote | LIBRARY_PATH=/tmp/evil-lib | CPATH=/tmp/evil-headers
C_INCLUDE_PATH=/tmp/evil-c-headers | CPLUS_INCLUDE_PATH=/tmp/evil-cpp-headers
OBJC_INCLUDE_PATH=/tmp/evil-objc-headers | HELM_HOME=/tmp/override-helm | BASHOPTS=xtrace
FPATH=/tmp/evil-fpath | KSH_ENV=/tmp/evil-ksh-env | TCLLIBPATH=/tmp/evil-tcllibpath
NODE_REDIRECT_WARNINGS=/tmp/node-warnings.log | NODE_REPL_EXTERNAL_MODULE=/tmp/pwn.js
NODE_REPL_HISTORY=/tmp/node-repl-history | NODE_V8_COVERAGE=/tmp/coverage
NODE_EXTRA_CA_CERTS=/tmp/evil-ca.pem | SSL_CERT_FILE=/tmp/evil-cert.pem
SSL_CERT_DIR=/tmp/evil-cert-dir | REQUESTS_CA_BUNDLE=/tmp/evil-requests-ca.pem
CURL_CA_BUNDLE=/tmp/evil-curl-ca.pem | GIT_SSL_NO_VERIFY=1 | GIT_SSL_CAINFO=/tmp/evil-git-ca.pem
GIT_SSL_CAPATH=/tmp/evil-git-ca-dir | GOPROXY=https://example.invalid/proxy
GONOSUMCHECK=example.invalid/* | GONOSUMDB=example.invalid/* | GONOPROXY=example.invalid/*
GOPRIVATE=example.invalid/* | GOENV=/tmp/evil-goenv | GOPATH=/tmp/evil-go
PYTHONUSERBASE=/tmp/evil-python-userbase | VIRTUAL_ENV=/tmp/evil-venv
CONDA_DEFAULT_ENV=evil-conda | CONDA_PREFIX=/tmp/evil-conda | SHELLOPTS=xtrace
PS4=$(touch /tmp/pwned) | CLASSPATH=/tmp/evil-classpath | JAVA_OPTS=-javaagent:/tmp/evil.jar
GOFLAGS=-mod=mod | RUSTFLAGS=-C link-args=-l/tmp/evil.so
MAKEFLAGS=--eval=$(shell touch /tmp/pwned) | MFLAGS=--eval=$(shell touch /tmp/pwned-too)
PHPRC=/tmp/evil-php.ini | XDG_CONFIG_HOME=/tmp/evil-config | SAFE=ok`);
    const env = sanitizeHostExecEnv({
      baseEnv,
      overrides,
    });

    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.OPENCLAW_CLI).toBe(OPENCLAW_CLI_ENV_VALUE);
    expectEnvKeysUndefined(
      env,
      `BASH_ENV BROWSER GIT_ALLOW_PROTOCOL GIT_EDITOR GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR CC CXX
CARGO_BUILD_RUSTC CARGO_BUILD_RUSTC_WRAPPER CMAKE_C_COMPILER CMAKE_CXX_COMPILER RUSTC_WRAPPER
HGRCPATH GIT_TEMPLATE_DIR GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
GIT_NAMESPACE GIT_PROTOCOL_FROM_USER GIT_SEQUENCE_EDITOR AWS_CONFIG_FILE KUBECONFIG
GOOGLE_APPLICATION_CREDENTIALS AWS_SHARED_CREDENTIALS_FILE AWS_WEB_IDENTITY_TOKEN_FILE
AZURE_AUTH_LOCATION GIT_SSH_COMMAND GIT_EXEC_PATH EDITOR NPM_CONFIG_USERCONFIG GIT_CONFIG_GLOBAL`,
    );
    expect(env.CARGO_REGISTRIES_CRATES_IO_INDEX).toBe("https://trusted.example/crates.io-index");
    expectEnvKeysUndefined(
      env,
      `SHELLOPTS PS4 CLASSPATH JAVA_OPTS GOFLAGS RUSTFLAGS MAKEFLAGS MFLAGS PHPRC XDG_CONFIG_HOME
YARN_RC_FILENAME PIP_INDEX_URL PIP_PYPI_URL PIP_EXTRA_INDEX_URL PIP_CONFIG_FILE PIP_FIND_LINKS
PIP_TRUSTED_HOST UV_INDEX UV_INDEX_URL UV_PYTHON UV_DEFAULT_INDEX UV_EXTRA_INDEX_URL DOCKER_HOST
DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_CONTEXT LIBRARY_PATH CPATH C_INCLUDE_PATH
CPLUS_INCLUDE_PATH OBJC_INCLUDE_PATH NODE_EXTRA_CA_CERTS SSL_CERT_FILE SSL_CERT_DIR
REQUESTS_CA_BUNDLE CURL_CA_BUNDLE GOPROXY GONOSUMCHECK GONOSUMDB GONOPROXY GOPRIVATE GOENV
GOPATH CARGO_HOME HELM_HOME BASHOPTS FPATH KSH_ENV TCLLIBPATH NODE_REDIRECT_WARNINGS
NODE_REPL_EXTERNAL_MODULE NODE_REPL_HISTORY NODE_V8_COVERAGE PYTHONUSERBASE VIRTUAL_ENV
CONDA_DEFAULT_ENV CONDA_PREFIX`,
    );
    expect(env.SAFE).toBe("ok");
    expect(env.HOME).toBe("/tmp/trusted-home");
    expect(env.ZDOTDIR).toBe("/tmp/trusted-zdotdir");
  });

  it("drops inherited vars blocked by either policy bucket and keeps explicit inherited allowlist keys", () => {
    const env = sanitizeHostExecEnv({
      baseEnv: {
        PATH: "/usr/bin:/bin",
        HTTPS_PROXY: "http://trusted-proxy.example.test:8443",
        KUBECONFIG: "/tmp/trusted-kubeconfig",
        GOOGLE_APPLICATION_CREDENTIALS: "/tmp/trusted-gcp.json",
        AWS_SHARED_CREDENTIALS_FILE: "/tmp/trusted-aws-credentials",
        AWS_WEB_IDENTITY_TOKEN_FILE: "/tmp/trusted-aws-web-token",
        AWS_CONFIG_FILE: "/tmp/trusted-aws-config",
        AZURE_AUTH_LOCATION: "/tmp/trusted-azure-auth.json",
        SSH_AUTH_SOCK: "/tmp/trusted-ssh-agent.sock",
        DOCKER_CONTEXT: "trusted-remote",
        XDG_CACHE_HOME: "/tmp/trusted-xdg-cache",
        XDG_CONFIG_DIRS: "/tmp/trusted-xdg-config-dirs:/etc/xdg",
        XDG_CONFIG_HOME: "/tmp/trusted-xdg-config",
        XDG_DATA_DIRS: "/tmp/trusted-xdg-data-dirs:/usr/share",
        XDG_DATA_HOME: "/tmp/trusted-xdg-data",
        XDG_RUNTIME_DIR: "/tmp/trusted-xdg-runtime",
        XDG_STATE_HOME: "/tmp/trusted-xdg-state",
        VIMINIT: ":!touch /tmp/pwned",
        EXINIT: "silent !touch /tmp/pwned",
        LUA_INIT_5_4: "os.execute('touch /tmp/pwned')",
        HOSTALIASES: "/tmp/evil-hostaliases",
        BASHOPTS: "xtrace",
        FPATH: "/tmp/evil-fpath",
        KSH_ENV: "/tmp/evil-ksh-env",
        TCLLIBPATH: "/tmp/evil-tcllibpath",
        AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://169.254.170.2/credentials",
        AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/abcd",
        CONFIG_SITE: "/tmp/evil-config-site",
        ANSIBLE_CONFIG: "/tmp/evil-ansible.cfg",
        R_PROFILE_USER: "/tmp/evil-Rprofile",
        ERL_AFLAGS: "-eval 'os:cmd(\"id\")'",
        TF_CLI_CONFIG_FILE: "/tmp/evil-terraformrc",
        TF_VAR_admin_cidr: "10.0.0.0/24",
        SAFE: "1",
      },
    });

    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.OPENCLAW_CLI).toBe(OPENCLAW_CLI_ENV_VALUE);
    expectEnvKeysUndefined(
      env,
      "VIMINIT EXINIT LUA_INIT_5_4 HOSTALIASES BASHOPTS FPATH KSH_ENV TCLLIBPATH",
    );
    expect(env.HTTPS_PROXY).toBe("http://trusted-proxy.example.test:8443");
    expect(env.KUBECONFIG).toBe("/tmp/trusted-kubeconfig");
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBe("/tmp/trusted-gcp.json");
    expect(env.AWS_SHARED_CREDENTIALS_FILE).toBe("/tmp/trusted-aws-credentials");
    expect(env.AWS_WEB_IDENTITY_TOKEN_FILE).toBe("/tmp/trusted-aws-web-token");
    expect(env.AWS_CONFIG_FILE).toBe("/tmp/trusted-aws-config");
    expect(env.AZURE_AUTH_LOCATION).toBe("/tmp/trusted-azure-auth.json");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/trusted-ssh-agent.sock");
    expect(env.DOCKER_CONTEXT).toBe("trusted-remote");
    expect(env.XDG_CACHE_HOME).toBe("/tmp/trusted-xdg-cache");
    expect(env.XDG_CONFIG_DIRS).toBe("/tmp/trusted-xdg-config-dirs:/etc/xdg");
    expect(env.XDG_CONFIG_HOME).toBe("/tmp/trusted-xdg-config");
    expect(env.XDG_DATA_DIRS).toBe("/tmp/trusted-xdg-data-dirs:/usr/share");
    expect(env.XDG_DATA_HOME).toBe("/tmp/trusted-xdg-data");
    expect(env.XDG_RUNTIME_DIR).toBe("/tmp/trusted-xdg-runtime");
    expect(env.XDG_STATE_HOME).toBe("/tmp/trusted-xdg-state");
    expectEnvKeysUndefined(
      env,
      "AWS_CONTAINER_CREDENTIALS_FULL_URI AWS_CONTAINER_CREDENTIALS_RELATIVE_URI CONFIG_SITE ANSIBLE_CONFIG R_PROFILE_USER ERL_AFLAGS TF_CLI_CONFIG_FILE",
    );
    expect(env.TF_VAR_admin_cidr).toBe("10.0.0.0/24");
    expect(env.SAFE).toBe("1");
  });

  it("drops newly blocked override credential and startup vars", () => {
    const env = sanitizeHostExecEnv({
      baseEnv: {
        PATH: "/usr/bin:/bin",
      },
      overrides: envRecord(`VIMINIT=:!touch /tmp/pwned | HOSTALIASES=/tmp/evil-hostaliases
BASHOPTS=xtrace | FPATH=/tmp/evil-fpath | KSH_ENV=/tmp/evil-ksh-env
TCLLIBPATH=/tmp/evil-tcllibpath | AWS_CONTAINER_CREDENTIALS_FULL_URI=http://attacker/credentials
AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=/attacker-credentials | ANSIBLE_CONFIG=/tmp/override-ansible.cfg
ANSIBLE_REMOTE_TEMP=/tmp/evil-ansible-remote | R_LIBS_USER=/tmp/evil-r-libs-user
TF_CLI_CONFIG_FILE=/tmp/override-terraformrc | TF_PLUGIN_CACHE_DIR=/tmp/evil-tf-plugin-cache
CFLAGS=-I/attacker/include | LDFLAGS=-L/attacker/lib | XDG_CACHE_HOME=/tmp/evil-cache
XDG_CONFIG_DIRS=/tmp/evil-config-dirs | XDG_CONFIG_HOME=/tmp/evil-config
XDG_DATA_DIRS=/tmp/evil-data-dirs | XDG_DATA_HOME=/tmp/evil-data
XDG_RUNTIME_DIR=/tmp/evil-runtime | XDG_STATE_HOME=/tmp/evil-state
TF_VAR_admin_cidr=10.0.0.0/24 | GITHUB_TOKEN=ghp-test | DATABASE_URL=postgres://attacker
NPM_TOKEN=npm-test | SSH_AUTH_SOCK=/tmp/evil-agent.sock | SAFE=ok`),
    });

    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.OPENCLAW_CLI).toBe(OPENCLAW_CLI_ENV_VALUE);
    expectEnvKeysUndefined(
      env,
      `VIMINIT HOSTALIASES BASHOPTS FPATH KSH_ENV TCLLIBPATH AWS_CONTAINER_CREDENTIALS_FULL_URI
AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ANSIBLE_CONFIG ANSIBLE_REMOTE_TEMP R_LIBS_USER
TF_CLI_CONFIG_FILE TF_PLUGIN_CACHE_DIR CFLAGS LDFLAGS XDG_CACHE_HOME XDG_CONFIG_DIRS
XDG_CONFIG_HOME XDG_DATA_DIRS XDG_DATA_HOME XDG_RUNTIME_DIR XDG_STATE_HOME TF_VAR_admin_cidr
GITHUB_TOKEN DATABASE_URL NPM_TOKEN SSH_AUTH_SOCK`,
    );
    expect(env.SAFE).toBe("ok");
  });

  it("blocks reported build-tool executable override values", () => {
    const result = sanitizeHostExecEnvWithDiagnostics({
      baseEnv: {
        PATH: "/usr/bin:/bin",
      },
      overrides: {
        CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER: "/tmp/evil-rustc-workspace-wrapper",
        CARGO_BUILD_RUSTDOC: "/tmp/evil-rustdoc",
        CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER: "/tmp/evil-linker",
        CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUNNER: "/tmp/evil-runner",
        CARGO_TARGET_DIR: "/tmp/target",
        HGEDITOR: "/tmp/evil-hg-editor",
        HGMERGE: "/tmp/evil-hg-merge",
        MAKE: "/tmp/evil-make",
        RUSTC: "/tmp/evil-rustc",
        RUSTC_WORKSPACE_WRAPPER: "/tmp/evil-rustc-workspace-wrapper",
        RUSTDOC: "/tmp/evil-rustdoc",
      },
    });

    expect(result.rejectedOverrideBlockedKeys).toEqual(
      listKeys(`CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER CARGO_BUILD_RUSTDOC
CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUNNER
HGEDITOR HGMERGE MAKE RUSTC RUSTC_WORKSPACE_WRAPPER RUSTDOC`),
    );
    expect(result.rejectedOverrideInvalidKeys).toStrictEqual([]);
    expect(result.env.CARGO_TARGET_DIR).toBe("/tmp/target");
    expectEnvKeysUndefined(
      result.env,
      `CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER CARGO_BUILD_RUSTDOC
CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUNNER
HGEDITOR HGMERGE MAKE RUSTC RUSTC_WORKSPACE_WRAPPER RUSTDOC`,
    );
  });

  it("keeps trusted inherited proxy and TLS env while blocking overrides", () => {
    const env = sanitizeHostExecEnv({
      baseEnv: envRecord(`PATH=/usr/bin:/bin | HTTP_PROXY=http://trusted-proxy.example.test:8080
HTTPS_PROXY=http://trusted-proxy.example.test:8443 | NODE_TLS_REJECT_UNAUTHORIZED=0
SSL_CERT_DIR=/etc/ssl/certs | CURL_CA_BUNDLE=/etc/ssl/cert.pem | DOCKER_TLS_VERIFY=1`),
      overrides: envRecord(`HTTP_PROXY=http://evil-proxy.example.test:8080
NODE_TLS_REJECT_UNAUTHORIZED=1 | DOCKER_TLS_VERIFY=0`),
    });

    expect(env).toEqual(
      envRecord(`OPENCLAW_CLI=${OPENCLAW_CLI_ENV_VALUE} | PATH=/usr/bin:/bin
HTTP_PROXY=http://trusted-proxy.example.test:8080 | HTTPS_PROXY=http://trusted-proxy.example.test:8443
NODE_TLS_REJECT_UNAUTHORIZED=0 | SSL_CERT_DIR=/etc/ssl/certs
CURL_CA_BUNDLE=/etc/ssl/cert.pem | DOCKER_TLS_VERIFY=1`),
    );
  });

  it("blocks proxy, TLS, and Docker override values explicitly", () => {
    expectPolicyCases(
      isDangerousHostEnvOverrideVarName,
      `+HTTPS_PROXY +https_proxy +HTTP_PROXY +http_proxy +ALL_PROXY +no_proxy
+NODE_TLS_REJECT_UNAUTHORIZED +node_extra_ca_certs +SSL_CERT_FILE +SSL_CERT_DIR
+requests_ca_bundle +CURL_CA_BUNDLE +DOCKER_HOST +docker_cert_path +DOCKER_TLS_VERIFY`,
    );
  });

  it("drops dangerous inherited shell trace keys", () => {
    const env = sanitizeHostExecEnv({
      baseEnv: {
        PATH: "/usr/bin:/bin",
        SHELLOPTS: "xtrace",
        PS4: "$(touch /tmp/pwned)",
        OK: "1",
      },
    });

    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.OPENCLAW_CLI).toBe(OPENCLAW_CLI_ENV_VALUE);
    expect(env.OK).toBe("1");
    expectEnvKeysUndefined(env, "SHELLOPTS PS4");
  });

  it("drops non-portable env key names", () => {
    const env = sanitizeHostExecEnv({
      baseEnv: {
        PATH: "/usr/bin:/bin",
      },
      overrides: {
        " BAD KEY": "x",
        "NOT-PORTABLE": "x",
        GOOD_KEY: "ok",
      },
    });

    expect(env.GOOD_KEY).toBe("ok");
    expect(env.OPENCLAW_CLI).toBe(OPENCLAW_CLI_ENV_VALUE);
    expect(env[" BAD KEY"]).toBeUndefined();
    expect(env["NOT-PORTABLE"]).toBeUndefined();
  });

  it("can allow PATH overrides when explicitly opted out of blocking", () => {
    const env = sanitizeHostExecEnv({
      baseEnv: {
        PATH: "/usr/bin:/bin",
      },
      overrides: {
        PATH: "/custom/bin",
      },
      blockPathOverrides: false,
    });

    expect(env.PATH).toBe("/custom/bin");
    expect(env.OPENCLAW_CLI).toBe(OPENCLAW_CLI_ENV_VALUE);
  });

  it("drops non-string inherited values while preserving non-portable inherited keys", () => {
    const env = sanitizeHostExecEnv({
      baseEnv: {
        PATH: "/usr/bin:/bin",
        GOOD: "1",
        BAD_NUMBER: 1 as unknown as string,
        "NOT-PORTABLE": "x",
        "ProgramFiles(x86)": "C:\\Program Files (x86)",
      },
    });

    expect(env).toEqual({
      OPENCLAW_CLI: OPENCLAW_CLI_ENV_VALUE,
      PATH: "/usr/bin:/bin",
      GOOD: "1",
      "NOT-PORTABLE": "x",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
    });
  });
});

describe("isDangerousHostEnvOverrideVarName", () => {
  it("matches override-only blocked keys case-insensitively", () => {
    expectPolicyCases(
      isDangerousHostEnvOverrideVarName,
      `+HOME +zdotdir +GIT_DIR +git_work_tree +GIT_COMMON_DIR +git_index_file +GIT_OBJECT_DIRECTORY
+git_alternate_object_directories +git_namespace +GIT_SSH_COMMAND +editor +NPM_CONFIG_USERCONFIG
+git_config_global +CARGO_REGISTRIES_CRATES_IO_INDEX +cargo_registries_internal_index
+GRADLE_USER_HOME +gradle_user_home +PIP_INDEX_URL +pip_config_file +PIP_FIND_LINKS
+pip_trusted_host +pip_pypi_url +PIP_EXTRA_INDEX_URL +UV_INDEX +UV_INDEX_URL +uv_python
+uv_default_index +UV_EXTRA_INDEX_URL +DOCKER_HOST +docker_context +NODE_EXTRA_CA_CERTS
+ssl_cert_file +REQUESTS_CA_BUNDLE +curl_ca_bundle +LIBRARY_PATH +c_include_path +GOPROXY
+gonosumdb +GOPRIVATE +goenv +PYTHONUSERBASE +virtual_env +conda_default_env +conda_prefix
+KUBECONFIG +google_application_credentials +AWS_SHARED_CREDENTIALS_FILE
+aws_web_identity_token_file +AZURE_AUTH_LOCATION +cargo_home +HELM_HOME +CLASSPATH +classpath
+MAKEFLAGS +makeflags +MFLAGS +mflags +GOFLAGS +goflags +HGRCPATH +hgrcpath +RUSTC_WRAPPER
+rustc_wrapper -RUSTC_WORKSPACE_WRAPPER +RUSTFLAGS +rustflags +RUSTUP_DIST_ROOT
+rustup_dist_server +RUSTUP_HOME +rustup_toolchain +RUSTUP_UPDATE_ROOT
+CARGO_BUILD_RUSTC_WRAPPER +cargo_build_rustc_wrapper
+CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER
+cargo_target_x86_64_unknown_linux_gnu_runner -CARGO_TARGET_DIR +CARGO_HOME +cargo_home
+TF_VAR_admin_cidr +CORECLR_PROFILER_PATH +coreclr_profiler_path +XDG_CACHE_HOME +xdg_cache_home
+XDG_CONFIG_HOME +xdg_config_home +XDG_CONFIG_DIRS +xdg_config_dirs +XDG_DATA_DIRS
+xdg_data_dirs +XDG_DATA_HOME +xdg_data_home +XDG_RUNTIME_DIR +xdg_runtime_dir +XDG_STATE_HOME
+xdg_state_home +AWS_CONFIG_FILE +aws_config_file +yarn_rc_filename +SystemRoot +windir
-BASH_ENV -FOO`,
    );
  });

  it("blocks newly added credential and build influence keys", () => {
    const keys = listKeys(`GITHUB_TOKEN GH_TOKEN GITLAB_TOKEN NPM_TOKEN NODE_AUTH_TOKEN
AWS_ACCESS_KEY_ID AWS_CONTAINER_CREDENTIALS_FULL_URI AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
ANSIBLE_CONFIG ANSIBLE_LIBRARY ANSIBLE_REMOTE_TEMP R_LIBS_USER TF_CLI_CONFIG_FILE
TF_PLUGIN_CACHE_DIR CFLAGS LDFLAGS XDG_CACHE_HOME XDG_CONFIG_DIRS XDG_CONFIG_HOME XDG_DATA_DIRS
XDG_DATA_HOME XDG_RUNTIME_DIR XDG_STATE_HOME AWS_SECRET_ACCESS_KEY AZURE_CLIENT_SECRET DATABASE_URL
REDIS_URL MONGODB_URI AMQP_URL SSH_AUTH_SOCK`);

    for (const key of keys) {
      expect(isDangerousHostEnvOverrideVarName(key)).toBe(true);
      expect(isDangerousHostEnvOverrideVarName(key.toLowerCase())).toBe(true);
    }
  });
});

describe("sanitizeHostExecEnvWithDiagnostics", () => {
  it("reports blocked and invalid requested overrides", () => {
    const overrides = envRecord(`PATH=/tmp/evil | CPP=/tmp/evil-cpp | CXX=/tmp/evil-cxx
CARGO_BUILD_RUSTC_WRAPPER=/tmp/evil-rustc-wrapper
CARGO_REGISTRIES_CRATES_IO_INDEX=https://example.invalid/crates.io-index
CMAKE_C_COMPILER=/tmp/evil-c-compiler | KUBECONFIG=/tmp/evil-kubeconfig
GOOGLE_APPLICATION_CREDENTIALS=/tmp/evil-gcp.json
AWS_SHARED_CREDENTIALS_FILE=/tmp/evil-aws-credentials
AWS_WEB_IDENTITY_TOKEN_FILE=/tmp/evil-aws-web-token
AZURE_AUTH_LOCATION=/tmp/evil-azure-auth.json | CLASSPATH=/tmp/evil-classpath
PIP_INDEX_URL=https://example.invalid/simple | PIP_PYPI_URL=https://example.invalid/simple
PIP_EXTRA_INDEX_URL=https://example.invalid/simple | PIP_CONFIG_FILE=/tmp/evil-pip.conf
PIP_FIND_LINKS=https://example.invalid/wheels | PIP_TRUSTED_HOST=example.invalid
UV_INDEX=https://example.invalid/simple | UV_INDEX_URL=https://example.invalid/simple
UV_PYTHON=/tmp/evil-uv-python | UV_DEFAULT_INDEX=https://example.invalid/simple
UV_EXTRA_INDEX_URL=https://example.invalid/simple | DOCKER_HOST=tcp://example.invalid:2376
DOCKER_TLS_VERIFY=1 | DOCKER_CERT_PATH=/tmp/evil-docker-certs | DOCKER_CONTEXT=evil-remote
LIBRARY_PATH=/tmp/evil-lib | CPATH=/tmp/evil-headers | C_INCLUDE_PATH=/tmp/evil-c-headers
CPLUS_INCLUDE_PATH=/tmp/evil-cpp-headers | OBJC_INCLUDE_PATH=/tmp/evil-objc-headers
NODE_EXTRA_CA_CERTS=/tmp/evil-ca.pem | SSL_CERT_FILE=/tmp/evil-cert.pem
SSL_CERT_DIR=/tmp/evil-cert-dir | REQUESTS_CA_BUNDLE=/tmp/evil-requests-ca.pem
CURL_CA_BUNDLE=/tmp/evil-curl-ca.pem | GIT_ALLOW_PROTOCOL=ext | GIT_DIR=/tmp/evil-git-dir
GIT_WORK_TREE=/tmp/evil-work-tree | GIT_COMMON_DIR=/tmp/evil-common-dir
GIT_INDEX_FILE=/tmp/evil-git-index | GIT_OBJECT_DIRECTORY=/tmp/evil-git-objects
GIT_ALTERNATE_OBJECT_DIRECTORIES=/tmp/evil-git-alt-objects | GIT_NAMESPACE=evil-namespace
GIT_PROTOCOL_FROM_USER=1 | GOPROXY=https://example.invalid/proxy
GONOSUMCHECK=example.invalid/* | GONOSUMDB=example.invalid/* | GONOPROXY=example.invalid/*
GOPRIVATE=example.invalid/* | GOENV=/tmp/evil-goenv | GOPATH=/tmp/evil-go
CARGO_HOME=/tmp/evil-cargo | HGRCPATH=/tmp/evil-hgrc
MAKEFLAGS=--eval=$(shell touch /tmp/pwned) | MFLAGS=--eval=$(shell touch /tmp/pwned-too)
HELM_HOME=/tmp/evil-helm | NODE_REDIRECT_WARNINGS=/tmp/node-warnings.log
NODE_REPL_EXTERNAL_MODULE=/tmp/pwn.js | NODE_REPL_HISTORY=/tmp/node-repl-history
NODE_V8_COVERAGE=/tmp/coverage | PYTHONUSERBASE=/tmp/evil-python-userbase
RUSTC_WRAPPER=/tmp/evil-rustc-wrapper | RUSTFLAGS=-C link-args=-l/tmp/evil.so
RUSTUP_DIST_ROOT=https://evil.example.test/deprecated-dist
RUSTUP_DIST_SERVER=https://evil.example.test | RUSTUP_HOME=/tmp/evil-rustup-home
RUSTUP_TOOLCHAIN=/tmp/evil-toolchain | RUSTUP_UPDATE_ROOT=https://evil.example.test/rustup
VIRTUAL_ENV=/tmp/evil-venv | CONDA_DEFAULT_ENV=evil-conda | CONDA_PREFIX=/tmp/evil-conda
JAVA_OPTS=-javaagent:/tmp/evil.jar | YARN_RC_FILENAME=.evil-yarnrc.yml
HTTPS_PROXY=http://proxy.example.test:8080 | GIT_SSL_NO_VERIFY=1
GIT_SSL_CAINFO=/tmp/evil-git-ca.pem | GIT_SSL_CAPATH=/tmp/evil-git-capath
NODE_TLS_REJECT_UNAUTHORIZED=0 | SAFE_KEY=ok | BAD-KEY=bad`);
    const result = sanitizeHostExecEnvWithDiagnostics({
      baseEnv: {
        PATH: "/usr/bin:/bin",
      },
      overrides,
    });

    expect(result.rejectedOverrideBlockedKeys).toEqual(
      listKeys(`AWS_SHARED_CREDENTIALS_FILE AWS_WEB_IDENTITY_TOKEN_FILE AZURE_AUTH_LOCATION
CARGO_BUILD_RUSTC_WRAPPER CARGO_HOME CARGO_REGISTRIES_CRATES_IO_INDEX CLASSPATH CMAKE_C_COMPILER
CONDA_DEFAULT_ENV CONDA_PREFIX CPATH CPLUS_INCLUDE_PATH CPP CURL_CA_BUNDLE CXX C_INCLUDE_PATH
DOCKER_CERT_PATH DOCKER_CONTEXT DOCKER_HOST DOCKER_TLS_VERIFY GIT_ALLOW_PROTOCOL
GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_DIR GIT_INDEX_FILE GIT_NAMESPACE
GIT_OBJECT_DIRECTORY GIT_PROTOCOL_FROM_USER GIT_SSL_CAINFO GIT_SSL_CAPATH GIT_SSL_NO_VERIFY
GIT_WORK_TREE GOENV GONOPROXY GONOSUMCHECK GONOSUMDB GOOGLE_APPLICATION_CREDENTIALS GOPATH
GOPRIVATE GOPROXY HELM_HOME HGRCPATH HTTPS_PROXY JAVA_OPTS KUBECONFIG LIBRARY_PATH MAKEFLAGS
MFLAGS NODE_EXTRA_CA_CERTS NODE_REDIRECT_WARNINGS NODE_REPL_EXTERNAL_MODULE NODE_REPL_HISTORY
NODE_TLS_REJECT_UNAUTHORIZED NODE_V8_COVERAGE OBJC_INCLUDE_PATH PATH PIP_CONFIG_FILE
PIP_EXTRA_INDEX_URL PIP_FIND_LINKS PIP_INDEX_URL PIP_PYPI_URL PIP_TRUSTED_HOST PYTHONUSERBASE
REQUESTS_CA_BUNDLE RUSTC_WRAPPER RUSTFLAGS RUSTUP_DIST_ROOT RUSTUP_DIST_SERVER RUSTUP_HOME
RUSTUP_TOOLCHAIN RUSTUP_UPDATE_ROOT SSL_CERT_DIR SSL_CERT_FILE UV_DEFAULT_INDEX UV_EXTRA_INDEX_URL
UV_INDEX UV_INDEX_URL UV_PYTHON VIRTUAL_ENV YARN_RC_FILENAME`),
    );
    expect(result.rejectedOverrideInvalidKeys).toEqual(["BAD-KEY"]);
    expect(result.env.SAFE_KEY).toBe("ok");
    expect(result.env.PATH).toBe("/usr/bin:/bin");
    expectEnvKeysUndefined(
      result.env,
      `CLASSPATH CXX CMAKE_C_COMPILER CARGO_BUILD_RUSTC_WRAPPER CARGO_REGISTRIES_CRATES_IO_INDEX
PIP_INDEX_URL PIP_PYPI_URL PIP_EXTRA_INDEX_URL PIP_CONFIG_FILE PIP_FIND_LINKS PIP_TRUSTED_HOST
UV_INDEX UV_INDEX_URL UV_PYTHON UV_DEFAULT_INDEX UV_EXTRA_INDEX_URL KUBECONFIG
GOOGLE_APPLICATION_CREDENTIALS AWS_SHARED_CREDENTIALS_FILE AWS_WEB_IDENTITY_TOKEN_FILE
AZURE_AUTH_LOCATION GIT_SSL_NO_VERIFY GIT_SSL_CAINFO GIT_SSL_CAPATH DOCKER_HOST
DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_CONTEXT LIBRARY_PATH CPATH C_INCLUDE_PATH
CPLUS_INCLUDE_PATH OBJC_INCLUDE_PATH NODE_EXTRA_CA_CERTS SSL_CERT_FILE SSL_CERT_DIR
REQUESTS_CA_BUNDLE CURL_CA_BUNDLE GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE
GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_OBJECT_DIRECTORY GIT_NAMESPACE GIT_ALLOW_PROTOCOL
GIT_PROTOCOL_FROM_USER GOPROXY GONOSUMCHECK GONOSUMDB GONOPROXY GOPRIVATE GOENV GOPATH
CARGO_HOME HGRCPATH HELM_HOME NODE_REDIRECT_WARNINGS NODE_REPL_EXTERNAL_MODULE NODE_REPL_HISTORY
NODE_V8_COVERAGE HTTPS_PROXY JAVA_OPTS MAKEFLAGS MFLAGS NODE_TLS_REJECT_UNAUTHORIZED
PYTHONUSERBASE RUSTC_WRAPPER RUSTFLAGS RUSTUP_DIST_ROOT RUSTUP_DIST_SERVER RUSTUP_HOME
RUSTUP_TOOLCHAIN RUSTUP_UPDATE_ROOT VIRTUAL_ENV CONDA_DEFAULT_ENV CONDA_PREFIX YARN_RC_FILENAME`,
    );
  });

  it("reports newly blocked keys from everywhere and override buckets", () => {
    const result = sanitizeHostExecEnvWithDiagnostics({
      baseEnv: {
        PATH: "/usr/bin:/bin",
      },
      overrides: {
        VIMINIT: ":!touch /tmp/pwned",
        LUA_INIT_5_4: "os.execute('touch /tmp/pwned')",
        HOSTALIASES: "/tmp/evil-hostaliases",
        BASHOPTS: "xtrace",
        FPATH: "/tmp/evil-fpath",
        KSH_ENV: "/tmp/evil-ksh-env",
        TCLLIBPATH: "/tmp/evil-tcllibpath",
        ANSIBLE_CONFIG: "/tmp/evil-ansible.cfg",
        ANSIBLE_REMOTE_TEMP: "/tmp/evil-ansible-remote",
        R_LIBS_USER: "/tmp/evil-r-libs-user",
        TF_CLI_CONFIG_FILE: "/tmp/evil-terraformrc",
        TF_PLUGIN_CACHE_DIR: "/tmp/evil-tf-plugin-cache",
        AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://attacker/credentials",
        AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/attacker-credentials",
        GITHUB_TOKEN: "ghp-test",
        DATABASE_URL: "postgres://attacker",
        R_PROFILE_USER: "/tmp/evil-Rprofile",
        XDG_CACHE_HOME: "/tmp/evil-cache",
        XDG_CONFIG_DIRS: "/tmp/evil-config-dirs",
        XDG_CONFIG_HOME: "/tmp/evil-config",
        XDG_DATA_DIRS: "/tmp/evil-data-dirs",
        XDG_DATA_HOME: "/tmp/evil-data",
        XDG_RUNTIME_DIR: "/tmp/evil-runtime",
        XDG_STATE_HOME: "/tmp/evil-state",
        TF_VAR_admin_cidr: "10.0.0.0/24",
        SAFE_KEY: "ok",
      },
    });

    expect(result.rejectedOverrideBlockedKeys).toEqual(
      listKeys(`ANSIBLE_CONFIG ANSIBLE_REMOTE_TEMP AWS_CONTAINER_CREDENTIALS_FULL_URI
AWS_CONTAINER_CREDENTIALS_RELATIVE_URI BASHOPTS DATABASE_URL FPATH GITHUB_TOKEN HOSTALIASES
KSH_ENV LUA_INIT_5_4 R_LIBS_USER R_PROFILE_USER TCLLIBPATH TF_CLI_CONFIG_FILE TF_PLUGIN_CACHE_DIR
TF_VAR_ADMIN_CIDR VIMINIT XDG_CACHE_HOME XDG_CONFIG_DIRS XDG_CONFIG_HOME XDG_DATA_DIRS
XDG_DATA_HOME XDG_RUNTIME_DIR XDG_STATE_HOME`),
    );
    expect(result.rejectedOverrideInvalidKeys).toStrictEqual([]);
    expect(result.env.SAFE_KEY).toBe("ok");
    expectEnvKeysUndefined(
      result.env,
      `VIMINIT LUA_INIT_5_4 HOSTALIASES BASHOPTS FPATH KSH_ENV TCLLIBPATH ANSIBLE_CONFIG
ANSIBLE_REMOTE_TEMP R_LIBS_USER TF_CLI_CONFIG_FILE TF_PLUGIN_CACHE_DIR GITHUB_TOKEN DATABASE_URL
R_PROFILE_USER XDG_CACHE_HOME XDG_CONFIG_DIRS XDG_CONFIG_HOME XDG_DATA_DIRS XDG_DATA_HOME
XDG_RUNTIME_DIR XDG_STATE_HOME TF_VAR_admin_cidr`,
    );
  });

  it("allows Windows-style override names while still rejecting invalid keys", () => {
    const result = sanitizeHostExecEnvWithDiagnostics({
      baseEnv: {
        PATH: "/usr/bin:/bin",
        "ProgramFiles(x86)": "C:\\Program Files (x86)",
      },
      overrides: {
        "ProgramFiles(x86)": "D:\\SDKs",
        "BAD-KEY": "bad",
      },
    });

    expect(result.rejectedOverrideBlockedKeys).toStrictEqual([]);
    expect(result.rejectedOverrideInvalidKeys).toEqual(["BAD-KEY"]);
    expect(result.env["ProgramFiles(x86)"]).toBe("D:\\SDKs");
  });
});

describe("normalizeEnvVarKey", () => {
  it("normalizes and validates keys", () => {
    expect(normalizeEnvVarKey(" OPENROUTER_API_KEY ")).toBe("OPENROUTER_API_KEY");
    expect(normalizeEnvVarKey("NOT-PORTABLE", { portable: true })).toBeNull();
    expect(normalizeEnvVarKey(" BASH_FUNC_echo%% ")).toBe("BASH_FUNC_echo%%");
    expect(normalizeEnvVarKey("   ")).toBeNull();
  });
});

describe("sanitizeSystemRunEnvOverrides", () => {
  it("keeps overrides for non-shell commands", () => {
    const overrides = sanitizeSystemRunEnvOverrides({
      shellWrapper: false,
      overrides: {
        OPENCLAW_TEST: "1",
        TOKEN: "abc",
      },
    });
    expect(overrides).toEqual({
      OPENCLAW_TEST: "1",
      TOKEN: "abc",
    });
  });

  it("drops non-allowlisted overrides for shell wrappers", () => {
    const overrides = sanitizeSystemRunEnvOverrides({
      shellWrapper: true,
      overrides: {
        OPENCLAW_TEST: "1",
        TOKEN: "abc",
        LANG: "C",
        LC_ALL: "C",
        LC_TIME: "C",
      },
    });
    expect(overrides).toEqual({
      LANG: "C",
      LC_ALL: "C",
      LC_TIME: "C",
    });
  });

  it("returns undefined when no shell-wrapper overrides survive", () => {
    expect(
      sanitizeSystemRunEnvOverrides({
        shellWrapper: true,
        overrides: {
          TOKEN: "abc",
        },
      }),
    ).toBeUndefined();
    expect(sanitizeSystemRunEnvOverrides({ shellWrapper: true })).toBeUndefined();
  });

  it("keeps allowlisted shell-wrapper overrides case-insensitively", () => {
    expect(
      sanitizeSystemRunEnvOverrides({
        shellWrapper: true,
        overrides: {
          lang: "C",
          ColorTerm: "truecolor",
          lc_numeric: "C",
        },
      }),
    ).toEqual({
      lang: "C",
      ColorTerm: "truecolor",
      lc_numeric: "C",
    });
  });
});

describe("shell wrapper exploit regression", () => {
  it("blocks SHELLOPTS/PS4 chain after sanitization", async () => {
    const bashPath = "/bin/bash";
    if (process.platform === "win32" || !fs.existsSync(bashPath)) {
      return;
    }
    const marker = path.join(os.tmpdir(), `openclaw-ps4-marker-${process.pid}-${Date.now()}`);
    try {
      fs.unlinkSync(marker);
    } catch {
      // no-op
    }

    const filteredOverrides = sanitizeSystemRunEnvOverrides({
      shellWrapper: true,
      overrides: {
        SHELLOPTS: "xtrace",
        PS4: `$(touch ${marker})`,
      },
    });
    const env = sanitizeHostExecEnv({
      overrides: filteredOverrides,
      baseEnv: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
      },
    });

    await new Promise<void>((resolve, reject) => {
      const child = spawn(bashPath, ["-lc", "echo SAFE"], { env, stdio: "ignore" });
      child.once("error", reject);
      child.once("close", () => resolve());
    });

    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe("git env exploit regression", () => {
  it("blocks inherited GIT_SEQUENCE_EDITOR so git rebase -i cannot execute helper payloads", async () => {
    const gitPath = getSystemGitPath();
    if (!gitPath) {
      return;
    }

    const repoDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `openclaw-git-sequence-editor-${process.pid}-${Date.now()}-`),
    );
    const safeRepoDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `openclaw-git-sequence-editor-safe-${process.pid}-${Date.now()}-`),
    );
    const editorPath = path.join(repoDir, "sequence-editor.sh");
    const safeEditorPath = path.join(safeRepoDir, "sequence-editor.sh");
    const marker = path.join(
      os.tmpdir(),
      `openclaw-git-sequence-editor-marker-${process.pid}-${Date.now()}`,
    );

    try {
      await initGitRepoWithCommits(gitPath, repoDir, 2);
      await initGitRepoWithCommits(gitPath, safeRepoDir, 2);
      clearMarker(marker);
      fs.writeFileSync(editorPath, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, "utf8");
      fs.chmodSync(editorPath, 0o755);
      fs.writeFileSync(safeEditorPath, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, "utf8");
      fs.chmodSync(safeEditorPath, 0o755);

      const unsafeEnv = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        GIT_SEQUENCE_EDITOR: editorPath,
        GIT_TERMINAL_PROMPT: "0",
      };

      await runGitCommand(gitPath, ["-C", repoDir, "rebase", "-i", "HEAD~1"], {
        env: unsafeEnv,
      });

      expect(fs.existsSync(marker)).toBe(true);
      clearMarker(marker);

      const safeEnv = sanitizeHostExecEnv({
        baseEnv: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          GIT_SEQUENCE_EDITOR: safeEditorPath,
          GIT_TERMINAL_PROMPT: "0",
        },
      });

      await runGitCommand(gitPath, ["-C", safeRepoDir, "rebase", "-i", "HEAD~1"], {
        env: safeEnv,
      });

      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(safeRepoDir, { recursive: true, force: true });
      fs.rmSync(marker, { force: true });
    }
  });

  it("blocks inherited GIT_EXEC_PATH so git cannot execute helper payloads", async () => {
    const gitPath = getSystemGitPath();
    if (!gitPath) {
      return;
    }

    const helperDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `openclaw-git-exec-path-${process.pid}-${Date.now()}-`),
    );
    const helperPath = path.join(helperDir, "git-remote-https");
    const marker = path.join(
      os.tmpdir(),
      `openclaw-git-exec-path-marker-${process.pid}-${Date.now()}`,
    );
    try {
      clearMarker(marker);
      fs.writeFileSync(helperPath, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`, "utf8");
      fs.chmodSync(helperPath, 0o755);

      const target = "https://127.0.0.1:1/does-not-matter";
      const unsafeEnv = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        GIT_EXEC_PATH: helperDir,
        GIT_TERMINAL_PROMPT: "0",
      };

      await runGitLsRemote(gitPath, target, unsafeEnv);

      expect(fs.existsSync(marker)).toBe(true);
      clearMarker(marker);

      const safeEnv = sanitizeHostExecEnv({
        baseEnv: unsafeEnv,
      });

      await runGitLsRemote(gitPath, target, safeEnv);

      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(helperDir, { recursive: true, force: true });
      fs.rmSync(marker, { force: true });
    }
  });

  it("blocks inherited GIT_TEMPLATE_DIR so git clone cannot install hook payloads", async () => {
    const gitPath = getSystemGitPath();
    if (!gitPath) {
      return;
    }

    const repoDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `openclaw-git-template-source-${process.pid}-${Date.now()}-`),
    );
    const cloneDir = path.join(
      os.tmpdir(),
      `openclaw-git-template-clone-${process.pid}-${Date.now()}`,
    );
    const safeCloneDir = path.join(
      os.tmpdir(),
      `openclaw-git-template-safe-clone-${process.pid}-${Date.now()}`,
    );
    const templateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `openclaw-git-template-dir-${process.pid}-${Date.now()}-`),
    );
    const hooksDir = path.join(templateDir, "hooks");
    const marker = path.join(
      os.tmpdir(),
      `openclaw-git-template-marker-${process.pid}-${Date.now()}`,
    );

    try {
      fs.mkdirSync(hooksDir, { recursive: true });
      clearMarker(marker);
      fs.writeFileSync(
        path.join(hooksDir, "post-checkout"),
        `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`,
        "utf8",
      );
      fs.chmodSync(path.join(hooksDir, "post-checkout"), 0o755);

      await runGitCommand(gitPath, ["init", repoDir]);
      await runGitCommand(
        gitPath,
        [
          "-C",
          repoDir,
          "-c",
          "user.name=OpenClaw Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "--allow-empty",
          "-m",
          "init",
        ],
        {
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
          },
        },
      );

      const unsafeEnv = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        GIT_TEMPLATE_DIR: templateDir,
        GIT_TERMINAL_PROMPT: "0",
      };

      await runGitClone(gitPath, repoDir, cloneDir, unsafeEnv);

      expect(fs.existsSync(marker)).toBe(true);
      clearMarker(marker);

      const safeEnv = sanitizeHostExecEnv({
        baseEnv: unsafeEnv,
      });

      await runGitClone(gitPath, repoDir, safeCloneDir, safeEnv);

      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(cloneDir, { recursive: true, force: true });
      fs.rmSync(safeCloneDir, { recursive: true, force: true });
      fs.rmSync(templateDir, { recursive: true, force: true });
      fs.rmSync(marker, { force: true });
    }
  });

  it("blocks inherited GIT_ALLOW_PROTOCOL so git cannot enable ext transport helpers", async () => {
    const gitPath = getSystemGitPath();
    if (!gitPath) {
      return;
    }

    const helperDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `openclaw-git-allow-protocol-${process.pid}-${Date.now()}-`),
    );
    const helperPath = path.join(helperDir, "ext-helper.sh");
    const marker = path.join(
      os.tmpdir(),
      `openclaw-git-allow-protocol-marker-${process.pid}-${Date.now()}`,
    );

    try {
      clearMarker(marker);
      fs.writeFileSync(helperPath, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`, "utf8");
      fs.chmodSync(helperPath, 0o755);

      const target = `ext::${helperPath}`;
      const unsafeEnv = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        GIT_ALLOW_PROTOCOL: "ext",
        GIT_TERMINAL_PROMPT: "0",
      };

      await runGitLsRemote(gitPath, target, unsafeEnv);

      expect(fs.existsSync(marker)).toBe(true);
      clearMarker(marker);

      const safeEnv = sanitizeHostExecEnv({
        baseEnv: unsafeEnv,
      });

      await runGitLsRemote(gitPath, target, safeEnv);

      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(helperDir, { recursive: true, force: true });
      fs.rmSync(marker, { force: true });
    }
  });

  it("filters inherited GIT_ALLOW_PROTOCOL without widening file transport access", async () => {
    const gitPath = getSystemGitPath();
    if (!gitPath) {
      return;
    }

    const repoDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `openclaw-git-allow-protocol-source-${process.pid}-${Date.now()}-`),
    );
    const cloneDir = path.join(
      os.tmpdir(),
      `openclaw-git-allow-protocol-clone-${process.pid}-${Date.now()}`,
    );

    try {
      await runGitCommand(gitPath, ["init", repoDir]);
      await runGitCommand(
        gitPath,
        [
          "-C",
          repoDir,
          "-c",
          "user.name=OpenClaw Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "--allow-empty",
          "-m",
          "init",
        ],
        {
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
          },
        },
      );

      const inheritedEnv = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        GIT_ALLOW_PROTOCOL: "https::ssh",
        GIT_TERMINAL_PROMPT: "0",
      };
      const unsafeExitCode = await runGitCommandExitCode(gitPath, ["clone", repoDir, cloneDir], {
        env: inheritedEnv,
      });

      expect(unsafeExitCode).not.toBe(0);

      const safeEnv = sanitizeHostExecEnv({
        baseEnv: inheritedEnv,
      });

      expect(safeEnv.GIT_ALLOW_PROTOCOL).toBe("https:ssh");

      const safeExitCode = await runGitCommandExitCode(gitPath, ["clone", repoDir, cloneDir], {
        env: safeEnv,
      });

      expect(safeExitCode).not.toBe(0);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(cloneDir, { recursive: true, force: true });
    }
  });

  it("forces inherited permissive GIT_PROTOCOL_FROM_USER to block file transport access", async () => {
    const gitPath = getSystemGitPath();
    if (!gitPath) {
      return;
    }

    const repoDir = fs.mkdtempSync(
      path.join(
        os.tmpdir(),
        `openclaw-git-protocol-from-user-source-${process.pid}-${Date.now()}-`,
      ),
    );
    const unsafeCloneDir = path.join(
      os.tmpdir(),
      `openclaw-git-protocol-from-user-unsafe-${process.pid}-${Date.now()}`,
    );
    const safeCloneDir = path.join(
      os.tmpdir(),
      `openclaw-git-protocol-from-user-safe-${process.pid}-${Date.now()}`,
    );

    try {
      await runGitCommand(gitPath, ["init", repoDir]);
      await runGitCommand(
        gitPath,
        [
          "-C",
          repoDir,
          "-c",
          "user.name=OpenClaw Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "--allow-empty",
          "-m",
          "init",
        ],
        {
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
          },
        },
      );

      const inheritedEnv = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        GIT_PROTOCOL_FROM_USER: "1",
        GIT_TERMINAL_PROMPT: "0",
      };
      const unsafeExitCode = await runGitCommandExitCode(
        gitPath,
        ["clone", repoDir, unsafeCloneDir],
        { env: inheritedEnv },
      );

      expect(unsafeExitCode).toBe(0);

      const safeEnv = sanitizeHostExecEnv({
        baseEnv: inheritedEnv,
      });

      expect(safeEnv.GIT_PROTOCOL_FROM_USER).toBe("0");

      const safeExitCode = await runGitCommandExitCode(gitPath, ["clone", repoDir, safeCloneDir], {
        env: safeEnv,
      });

      expect(safeExitCode).not.toBe(0);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(unsafeCloneDir, { recursive: true, force: true });
      fs.rmSync(safeCloneDir, { recursive: true, force: true });
    }
  });

  it("blocks GIT_SSH_COMMAND override so git cannot execute helper payloads", async () => {
    const gitPath = getSystemGitPath();
    if (!gitPath) {
      return;
    }

    const marker = path.join(os.tmpdir(), `openclaw-git-ssh-command-${process.pid}-${Date.now()}`);
    clearMarker(marker);

    const target = "ssh://127.0.0.1:1/does-not-matter";
    const exploitValue = `touch ${JSON.stringify(marker)}; false`;
    const gitSshCommandKey = "GIT_SSH_COMMAND";
    const baseEnv = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_TERMINAL_PROMPT: "0",
    };

    const unsafeEnv = envRecord([...Object.entries(baseEnv), [gitSshCommandKey, exploitValue]]);

    await runGitLsRemote(gitPath, target, unsafeEnv);

    expect(fs.existsSync(marker)).toBe(true);
    clearMarker(marker);

    const safeEnv = sanitizeHostExecEnv({
      baseEnv,
      overrides: envRecord([[gitSshCommandKey, exploitValue]]),
    });

    await runGitLsRemote(gitPath, target, safeEnv);

    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe("compiler override exploit regression", () => {
  it("blocks CC overrides so make cannot execute a substituted compiler", async () => {
    const makePath = getSystemMakePath();
    if (!makePath) {
      return;
    }

    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `openclaw-compiler-override-${process.pid}-${Date.now()}-`),
    );
    const exploitPath = path.join(tempDir, "evil-cc");
    const marker = path.join(
      os.tmpdir(),
      `openclaw-compiler-override-marker-${process.pid}-${Date.now()}`,
    );

    try {
      // `CC` is a representative proof for the whole class because all compiler override keys
      // flow through the same host env sanitization boundary; unit tests cover the sibling keys.
      clearMarker(marker);
      fs.writeFileSync(
        path.join(tempDir, "Makefile"),
        "all:\n\t@$(CC) --version >/dev/null 2>&1 || true\n",
        "utf8",
      );
      fs.writeFileSync(exploitPath, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`, "utf8");
      fs.chmodSync(exploitPath, 0o755);

      const baseEnv = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
      };
      const compilerKey = "CC";

      await runMakeCommand(
        makePath,
        tempDir,
        envRecord([...Object.entries(baseEnv), [compilerKey, exploitPath]]),
      );

      expect(fs.existsSync(marker)).toBe(true);
      clearMarker(marker);

      const safeEnv = sanitizeHostExecEnv({
        baseEnv,
        overrides: envRecord([[compilerKey, exploitPath]]),
      });

      await runMakeCommand(makePath, tempDir, safeEnv);

      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      fs.rmSync(marker, { force: true });
    }
  });
});

describe("make env exploit regression", () => {
  it("blocks MAKEFLAGS overrides so make cannot evaluate shell payloads from env", async () => {
    const makePath = getSystemMakePath();
    if (!makePath) {
      return;
    }

    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `openclaw-makeflags-override-${process.pid}-${Date.now()}-`),
    );
    const exploitPath = path.join(tempDir, "evil-makeflags.sh");
    const marker = path.join(os.tmpdir(), `openclaw-makeflags-marker-${process.pid}-${Date.now()}`);

    try {
      clearMarker(marker);
      fs.writeFileSync(path.join(tempDir, "Makefile"), "all:\n\t@:\n", "utf8");
      fs.writeFileSync(exploitPath, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, "utf8");
      fs.chmodSync(exploitPath, 0o755);

      const exploitValue = `--eval=$(shell ${exploitPath})`;
      const baseEnv = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
      };
      const makeFlagsKey = "MAKEFLAGS";

      await runMakeCommand(
        makePath,
        tempDir,
        envRecord([...Object.entries(baseEnv), [makeFlagsKey, exploitValue]]),
      );

      const baselineTriggered = fs.existsSync(marker);
      clearMarker(marker);

      const safeEnv = sanitizeHostExecEnv({
        baseEnv,
        overrides: envRecord([[makeFlagsKey, exploitValue]]),
      });
      expect(safeEnv.MAKEFLAGS).toBeUndefined();

      await runMakeCommand(makePath, tempDir, safeEnv);

      expect(fs.existsSync(marker)).toBe(false);
      expect(typeof baselineTriggered).toBe("boolean");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      fs.rmSync(marker, { force: true });
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
