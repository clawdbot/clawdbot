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
import { OPENCLAW_CLI_ENV_VALUE } from "./openclaw-exec-env.js";

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
    expect(isDangerousHostEnvVarName("BASH_ENV")).toBe(true);
    expect(isDangerousHostEnvVarName("bash_env")).toBe(true);
    expect(isDangerousHostEnvVarName("BROWSER")).toBe(true);
    expect(isDangerousHostEnvVarName("browser")).toBe(true);
    expect(isDangerousHostEnvVarName("SHELL")).toBe(true);
    expect(isDangerousHostEnvVarName("GIT_EDITOR")).toBe(true);
    expect(isDangerousHostEnvVarName("git_editor")).toBe(true);
    expect(isDangerousHostEnvVarName("GIT_EXTERNAL_DIFF")).toBe(true);
    expect(isDangerousHostEnvVarName("GIT_DIR")).toBe(true);
    expect(isDangerousHostEnvVarName("git_work_tree")).toBe(true);
    expect(isDangerousHostEnvVarName("GIT_COMMON_DIR")).toBe(true);
    expect(isDangerousHostEnvVarName("git_exec_path")).toBe(true);
    expect(isDangerousHostEnvVarName("GIT_INDEX_FILE")).toBe(true);
    expect(isDangerousHostEnvVarName("git_object_directory")).toBe(true);
    expect(isDangerousHostEnvVarName("git_alternate_object_directories")).toBe(true);
    expect(isDangerousHostEnvVarName("GIT_NAMESPACE")).toBe(true);
    expect(isDangerousHostEnvVarName("GIT_SEQUENCE_EDITOR")).toBe(true);
    expect(isDangerousHostEnvVarName("git_sequence_editor")).toBe(true);
    expect(isDangerousHostEnvVarName("GIT_TEMPLATE_DIR")).toBe(true);
    expect(isDangerousHostEnvVarName("git_template_dir")).toBe(true);
    expect(isDangerousHostEnvVarName("KUBECONFIG")).toBe(false);
    expect(isDangerousHostEnvVarName("google_application_credentials")).toBe(false);
    expect(isDangerousHostEnvVarName("AWS_SHARED_CREDENTIALS_FILE")).toBe(false);
    expect(isDangerousHostEnvVarName("aws_web_identity_token_file")).toBe(false);
    expect(isDangerousHostEnvVarName("AZURE_AUTH_LOCATION")).toBe(false);
    expect(isDangerousHostEnvVarName("CC")).toBe(true);
    expect(isDangerousHostEnvVarName("cxx")).toBe(true);
    expect(isDangerousHostEnvVarName("CARGO_BUILD_RUSTC")).toBe(true);
    expect(isDangerousHostEnvVarName("cargo_build_rustc")).toBe(true);
    expect(isDangerousHostEnvVarName("CARGO_BUILD_RUSTC_WRAPPER")).toBe(true);
    expect(isDangerousHostEnvVarName("cargo_build_rustc_wrapper")).toBe(true);
    expect(isDangerousHostEnvVarName("cargo_home")).toBe(false);
    expect(isDangerousHostEnvVarName("CMAKE_C_COMPILER")).toBe(true);
    expect(isDangerousHostEnvVarName("cmake_c_compiler")).toBe(true);
    expect(isDangerousHostEnvVarName("CMAKE_CXX_COMPILER")).toBe(true);
    expect(isDangerousHostEnvVarName("cmake_cxx_compiler")).toBe(true);
    expect(isDangerousHostEnvVarName("RUSTC_WRAPPER")).toBe(true);
    expect(isDangerousHostEnvVarName("rustc_wrapper")).toBe(true);
    expect(isDangerousHostEnvVarName("HELM_HOME")).toBe(false);
    expect(isDangerousHostEnvVarName("SHELLOPTS")).toBe(true);
    expect(isDangerousHostEnvVarName("ps4")).toBe(true);
    expect(isDangerousHostEnvVarName("DYLD_INSERT_LIBRARIES")).toBe(true);
    expect(isDangerousHostEnvVarName("ld_preload")).toBe(true);
    expect(isDangerousHostEnvVarName("BASH_FUNC_echo%%")).toBe(true);
    expect(isDangerousHostEnvVarName("JAVA_OPTS")).toBe(true);
    expect(isDangerousHostEnvVarName("java_opts")).toBe(true);
    expect(isDangerousHostEnvVarName("JAVA_TOOL_OPTIONS")).toBe(true);
    expect(isDangerousHostEnvVarName("java_tool_options")).toBe(true);
    expect(isDangerousHostEnvVarName("_JAVA_OPTIONS")).toBe(true);
    expect(isDangerousHostEnvVarName("_java_options")).toBe(true);
    expect(isDangerousHostEnvVarName("JDK_JAVA_OPTIONS")).toBe(true);
    expect(isDangerousHostEnvVarName("jdk_java_options")).toBe(true);
    expect(isDangerousHostEnvVarName("PYTHONBREAKPOINT")).toBe(true);
    expect(isDangerousHostEnvVarName("pythonbreakpoint")).toBe(true);
    expect(isDangerousHostEnvVarName("DOTNET_STARTUP_HOOKS")).toBe(true);
    expect(isDangerousHostEnvVarName("dotnet_startup_hooks")).toBe(true);
    expect(isDangerousHostEnvVarName("DOTNET_ADDITIONAL_DEPS")).toBe(true);
    expect(isDangerousHostEnvVarName("dotnet_additional_deps")).toBe(true);
    expect(isDangerousHostEnvVarName("GLIBC_TUNABLES")).toBe(true);
    expect(isDangerousHostEnvVarName("glibc_tunables")).toBe(true);
    expect(isDangerousHostEnvVarName("MAVEN_OPTS")).toBe(true);
    expect(isDangerousHostEnvVarName("maven_opts")).toBe(true);
    expect(isDangerousHostEnvVarName("MAKEFLAGS")).toBe(true);
    expect(isDangerousHostEnvVarName("makeflags")).toBe(true);
    expect(isDangerousHostEnvVarName("MFLAGS")).toBe(true);
    expect(isDangerousHostEnvVarName("mflags")).toBe(true);
    expect(isDangerousHostEnvVarName("SBT_OPTS")).toBe(true);
    expect(isDangerousHostEnvVarName("sbt_opts")).toBe(true);
    expect(isDangerousHostEnvVarName("GRADLE_OPTS")).toBe(true);
    expect(isDangerousHostEnvVarName("gradle_opts")).toBe(true);
    expect(isDangerousHostEnvVarName("ANT_OPTS")).toBe(true);
    expect(isDangerousHostEnvVarName("ant_opts")).toBe(true);
    expect(isDangerousHostEnvVarName("HGRCPATH")).toBe(true);
    expect(isDangerousHostEnvVarName("hgrcpath")).toBe(true);
    expect(isDangerousHostEnvVarName("HTTPS_PROXY")).toBe(false);
    expect(isDangerousHostEnvVarName("https_proxy")).toBe(false);
    expect(isDangerousHostEnvVarName("HTTP_PROXY")).toBe(false);
    expect(isDangerousHostEnvVarName("http_proxy")).toBe(false);
    expect(isDangerousHostEnvVarName("ALL_PROXY")).toBe(false);
    expect(isDangerousHostEnvVarName("no_proxy")).toBe(false);
    expect(isDangerousHostEnvVarName("NODE_TLS_REJECT_UNAUTHORIZED")).toBe(false);
    expect(isDangerousHostEnvVarName("node_extra_ca_certs")).toBe(false);
    expect(isDangerousHostEnvVarName("SSL_CERT_FILE")).toBe(false);
    expect(isDangerousHostEnvVarName("SSL_CERT_DIR")).toBe(false);
    expect(isDangerousHostEnvVarName("requests_ca_bundle")).toBe(false);
    expect(isDangerousHostEnvVarName("CURL_CA_BUNDLE")).toBe(false);
    expect(isDangerousHostEnvVarName("DOCKER_HOST")).toBe(false);
    expect(isDangerousHostEnvVarName("docker_cert_path")).toBe(false);
    expect(isDangerousHostEnvVarName("DOCKER_TLS_VERIFY")).toBe(false);
    expect(isDangerousHostEnvVarName("CARGO_REGISTRIES_CRATES_IO_INDEX")).toBe(false);
    expect(isDangerousHostEnvVarName("AWS_CONFIG_FILE")).toBe(false);
    expect(isDangerousHostEnvVarName("aws_config_file")).toBe(false);
    expect(isDangerousHostEnvVarName("yarn_rc_filename")).toBe(false);
    expect(isDangerousHostEnvVarName("PATH")).toBe(false);
    expect(isDangerousHostEnvVarName("FOO")).toBe(false);
    expect(isDangerousHostEnvVarName("GRADLE_USER_HOME")).toBe(false);
  });

  it("blocks newly added startup, orchestration, and resolver env keys", () => {
    const keys = [
      "VIMINIT",
      "EXINIT",
      "MYVIMRC",
      "GVIMINIT",
      "LUA_INIT",
      "LUA_INIT_5_4",
      "HOSTALIASES",
      "CONFIG_SITE",
      "CONFIG_SHELL",
      "CMAKE_TOOLCHAIN_FILE",
      "ERL_AFLAGS",
      "ERL_FLAGS",
      "ERL_ZFLAGS",
      "R_ENVIRON",
      "R_PROFILE_USER",
    ] as const;

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
    expect(isDangerousHostInheritedEnvVarName("BASH_ENV")).toBe(true);
    expect(isDangerousHostInheritedEnvVarName("bash_env")).toBe(true);
    expect(isDangerousHostInheritedEnvVarName("ANSIBLE_CONFIG")).toBe(true);
    expect(isDangerousHostInheritedEnvVarName("ansible_library")).toBe(true);
    expect(isDangerousHostInheritedEnvVarName("TF_CLI_CONFIG_FILE")).toBe(true);
    expect(isDangerousHostInheritedEnvVarName("TF_VAR_admin_cidr")).toBe(false);
    expect(isDangerousHostInheritedEnvVarName("AWS_CONTAINER_CREDENTIALS_FULL_URI")).toBe(true);
    expect(isDangerousHostInheritedEnvVarName("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI")).toBe(true);
    expect(isDangerousHostInheritedEnvVarName("KUBECONFIG")).toBe(false);
    expect(isDangerousHostInheritedEnvVarName("GOOGLE_APPLICATION_CREDENTIALS")).toBe(false);
    expect(isDangerousHostInheritedEnvVarName("AWS_SHARED_CREDENTIALS_FILE")).toBe(false);
    expect(isDangerousHostInheritedEnvVarName("AWS_WEB_IDENTITY_TOKEN_FILE")).toBe(false);
    expect(isDangerousHostInheritedEnvVarName("AWS_CONFIG_FILE")).toBe(false);
    expect(isDangerousHostInheritedEnvVarName("AZURE_AUTH_LOCATION")).toBe(false);
    expect(isDangerousHostInheritedEnvVarName("SSH_AUTH_SOCK")).toBe(false);
    expect(isDangerousHostInheritedEnvVarName("DOCKER_CONTEXT")).toBe(false);
    expect(isDangerousHostInheritedEnvVarName("GIT_CONFIG_GLOBAL")).toBe(false);
    expect(isDangerousHostInheritedEnvVarName("NPM_CONFIG_USERCONFIG")).toBe(false);
    expect(isDangerousHostInheritedEnvVarName("CARGO_REGISTRIES_CRATES_IO_INDEX")).toBe(false);

    expect(isDangerousHostInheritedEnvVarName("HTTP_PROXY")).toBe(false);
    expect(isDangerousHostInheritedEnvVarName("https_proxy")).toBe(false);
    expect(isDangerousHostInheritedEnvVarName("SSL_CERT_FILE")).toBe(false);
    expect(isDangerousHostInheritedEnvVarName("node_extra_ca_certs")).toBe(false);
    expect(isDangerousHostInheritedEnvVarName("HOME")).toBe(false);
    expect(isDangerousHostInheritedEnvVarName("FOO")).toBe(false);
  });
});

describe("sanitizeHostExecEnv", () => {
  it("removes dangerous inherited keys while preserving PATH", () => {
    const env = sanitizeHostExecEnv({
      baseEnv: {
        PATH: "/usr/bin:/bin",
        BASH_ENV: "/tmp/pwn.sh",
        BROWSER: "/tmp/pwn-browser",
        GIT_EDITOR: "/tmp/pwn-editor",
        GIT_EXTERNAL_DIFF: "/tmp/pwn.sh",
        GIT_DIR: "/tmp/evil-git-dir",
        GIT_WORK_TREE: "/tmp/evil-work-tree",
        GIT_COMMON_DIR: "/tmp/evil-common-dir",
        GIT_TEMPLATE_DIR: "/tmp/git-template",
        GIT_INDEX_FILE: "/tmp/evil-git-index",
        GIT_OBJECT_DIRECTORY: "/tmp/evil-git-objects",
        GIT_ALTERNATE_OBJECT_DIRECTORIES: "/tmp/evil-git-alt-objects",
        GIT_NAMESPACE: "evil-namespace",
        GIT_SEQUENCE_EDITOR: "/tmp/pwn-sequence-editor",
        HGRCPATH: "/tmp/evil-hgrc",
        CARGO_BUILD_RUSTC_WRAPPER: "/tmp/evil-rustc-wrapper",
        RUSTC_WRAPPER: "/tmp/evil-rustc-wrapper",
        JAVA_OPTS: "-javaagent:/tmp/evil.jar",
        MAKEFLAGS: "--eval=$(shell touch /tmp/pwned)",
        MFLAGS: "--eval=$(shell touch /tmp/pwned-too)",
        KUBECONFIG: "/tmp/kubeconfig",
        GOOGLE_APPLICATION_CREDENTIALS: "/tmp/gcp.json",
        AWS_SHARED_CREDENTIALS_FILE: "/tmp/aws-credentials",
        AWS_WEB_IDENTITY_TOKEN_FILE: "/tmp/aws-web-token",
        AZURE_AUTH_LOCATION: "/tmp/azure-auth.json",
        AWS_CONFIG_FILE: "/tmp/aws-config",
        SSH_AUTH_SOCK: "/tmp/trusted-ssh-agent.sock",
        CARGO_HOME: "/tmp/cargo",
        HELM_HOME: "/tmp/helm",
        HTTP_PROXY: "http://proxy.example.test:8080",
        HTTPS_PROXY: "http://proxy.example.test:8443",
        SSL_CERT_FILE: "/tmp/evil-cert.pem",
        SSL_CERT_DIR: "/tmp/evil-cert-dir",
        DOCKER_CONTEXT: "trusted-remote",
        DOCKER_HOST: "tcp://docker.example.test:2376",
        LD_PRELOAD: "/tmp/pwn.so",
        OK: "1",
      },
    });

    expect(env).toEqual({
      OPENCLAW_CLI: OPENCLAW_CLI_ENV_VALUE,
      PATH: "/usr/bin:/bin",
      AWS_CONFIG_FILE: "/tmp/aws-config",
      KUBECONFIG: "/tmp/kubeconfig",
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/gcp.json",
      AWS_SHARED_CREDENTIALS_FILE: "/tmp/aws-credentials",
      AWS_WEB_IDENTITY_TOKEN_FILE: "/tmp/aws-web-token",
      AZURE_AUTH_LOCATION: "/tmp/azure-auth.json",
      SSH_AUTH_SOCK: "/tmp/trusted-ssh-agent.sock",
      HTTP_PROXY: "http://proxy.example.test:8080",
      HTTPS_PROXY: "http://proxy.example.test:8443",
      SSL_CERT_FILE: "/tmp/evil-cert.pem",
      SSL_CERT_DIR: "/tmp/evil-cert-dir",
      DOCKER_CONTEXT: "trusted-remote",
      DOCKER_HOST: "tcp://docker.example.test:2376",
      OK: "1",
    });
  });

  it("blocks PATH and dangerous override values", () => {
    const env = sanitizeHostExecEnv({
      baseEnv: {
        PATH: "/usr/bin:/bin",
        HOME: "/tmp/trusted-home",
        ZDOTDIR: "/tmp/trusted-zdotdir",
        CARGO_REGISTRIES_CRATES_IO_INDEX: "https://trusted.example/crates.io-index",
        YARN_RC_FILENAME: ".trusted-yarnrc.yml",
      },
      overrides: {
        PATH: "/tmp/evil",
        HOME: "/tmp/evil-home",
        ZDOTDIR: "/tmp/evil-zdotdir",
        BASH_ENV: "/tmp/pwn.sh",
        BROWSER: "/tmp/browser",
        CC: "/tmp/evil-cc",
        CXX: "/tmp/evil-cxx",
        CARGO_BUILD_RUSTC: "/tmp/evil-rustc",
        CARGO_BUILD_RUSTC_WRAPPER: "/tmp/evil-rustc-wrapper",
        CMAKE_C_COMPILER: "/tmp/evil-c-compiler",
        CMAKE_CXX_COMPILER: "/tmp/evil-cxx-compiler",
        RUSTC_WRAPPER: "/tmp/evil-rustc-wrapper",
        HGRCPATH: "/tmp/evil-hgrc",
        GIT_SSH_COMMAND: "touch /tmp/pwned",
        GIT_EDITOR: "/tmp/git-editor",
        GIT_DIR: "/tmp/evil-git-dir",
        GIT_WORK_TREE: "/tmp/evil-work-tree",
        GIT_COMMON_DIR: "/tmp/evil-common-dir",
        GIT_EXEC_PATH: "/tmp/git-exec-path",
        GIT_INDEX_FILE: "/tmp/evil-git-index",
        GIT_OBJECT_DIRECTORY: "/tmp/evil-git-objects",
        GIT_ALTERNATE_OBJECT_DIRECTORIES: "/tmp/evil-git-alt-objects",
        GIT_NAMESPACE: "evil-namespace",
        GIT_SEQUENCE_EDITOR: "/tmp/git-sequence-editor",
        EDITOR: "/tmp/editor",
        NPM_CONFIG_USERCONFIG: "/tmp/npmrc",
        GIT_CONFIG_GLOBAL: "/tmp/gitconfig",
        CARGO_REGISTRIES_CRATES_IO_INDEX: "https://example.invalid/crates.io-index",
        AWS_CONFIG_FILE: "/tmp/override-aws-config",
        YARN_RC_FILENAME: ".evil-yarnrc.yml",
        KUBECONFIG: "/tmp/override-kubeconfig",
        GOOGLE_APPLICATION_CREDENTIALS: "/tmp/override-gcp.json",
        AWS_SHARED_CREDENTIALS_FILE: "/tmp/override-aws-credentials",
        AWS_WEB_IDENTITY_TOKEN_FILE: "/tmp/override-aws-web-token",
        AZURE_AUTH_LOCATION: "/tmp/override-azure-auth.json",
        PIP_INDEX_URL: "https://example.invalid/simple",
        PIP_PYPI_URL: "https://example.invalid/simple",
        PIP_EXTRA_INDEX_URL: "https://example.invalid/simple",
        PIP_CONFIG_FILE: "/tmp/evil-pip.conf",
        PIP_FIND_LINKS: "https://example.invalid/wheels",
        PIP_TRUSTED_HOST: "example.invalid",
        UV_INDEX: "https://example.invalid/simple",
        UV_INDEX_URL: "https://example.invalid/simple",
        UV_PYTHON: "/tmp/evil-uv-python",
        UV_DEFAULT_INDEX: "https://example.invalid/simple",
        UV_EXTRA_INDEX_URL: "https://example.invalid/simple",
        DOCKER_HOST: "tcp://example.invalid:2376",
        DOCKER_TLS_VERIFY: "1",
        DOCKER_CERT_PATH: "/tmp/evil-docker-certs",
        DOCKER_CONTEXT: "evil-remote",
        LIBRARY_PATH: "/tmp/evil-lib",
        CPATH: "/tmp/evil-headers",
        C_INCLUDE_PATH: "/tmp/evil-c-headers",
        CPLUS_INCLUDE_PATH: "/tmp/evil-cpp-headers",
        OBJC_INCLUDE_PATH: "/tmp/evil-objc-headers",
        HELM_HOME: "/tmp/override-helm",
        NODE_EXTRA_CA_CERTS: "/tmp/evil-ca.pem",
        SSL_CERT_FILE: "/tmp/evil-cert.pem",
        SSL_CERT_DIR: "/tmp/evil-cert-dir",
        REQUESTS_CA_BUNDLE: "/tmp/evil-requests-ca.pem",
        CURL_CA_BUNDLE: "/tmp/evil-curl-ca.pem",
        GIT_SSL_NO_VERIFY: "1",
        GIT_SSL_CAINFO: "/tmp/evil-git-ca.pem",
        GIT_SSL_CAPATH: "/tmp/evil-git-ca-dir",
        GOPROXY: "https://example.invalid/proxy",
        GONOSUMCHECK: "example.invalid/*",
        GONOSUMDB: "example.invalid/*",
        GONOPROXY: "example.invalid/*",
        GOPRIVATE: "example.invalid/*",
        GOENV: "/tmp/evil-goenv",
        GOPATH: "/tmp/evil-go",
        PYTHONUSERBASE: "/tmp/evil-python-userbase",
        VIRTUAL_ENV: "/tmp/evil-venv",
        SHELLOPTS: "xtrace",
        PS4: "$(touch /tmp/pwned)",
        CLASSPATH: "/tmp/evil-classpath",
        JAVA_OPTS: "-javaagent:/tmp/evil.jar",
        GOFLAGS: "-mod=mod",
        RUSTFLAGS: "-C link-args=-l/tmp/evil.so",
        MAKEFLAGS: "--eval=$(shell touch /tmp/pwned)",
        MFLAGS: "--eval=$(shell touch /tmp/pwned-too)",
        PHPRC: "/tmp/evil-php.ini",
        XDG_CONFIG_HOME: "/tmp/evil-config",
        SAFE: "ok",
      },
    });

    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.OPENCLAW_CLI).toBe(OPENCLAW_CLI_ENV_VALUE);
    expect(env.BASH_ENV).toBeUndefined();
    expect(env.BROWSER).toBeUndefined();
    expect(env.GIT_EDITOR).toBeUndefined();
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.GIT_COMMON_DIR).toBeUndefined();
    expect(env.CC).toBeUndefined();
    expect(env.CXX).toBeUndefined();
    expect(env.CARGO_BUILD_RUSTC).toBeUndefined();
    expect(env.CARGO_BUILD_RUSTC_WRAPPER).toBeUndefined();
    expect(env.CMAKE_C_COMPILER).toBeUndefined();
    expect(env.CMAKE_CXX_COMPILER).toBeUndefined();
    expect(env.RUSTC_WRAPPER).toBeUndefined();
    expect(env.HGRCPATH).toBeUndefined();
    expect(env.GIT_TEMPLATE_DIR).toBeUndefined();
    expect(env.GIT_INDEX_FILE).toBeUndefined();
    expect(env.GIT_OBJECT_DIRECTORY).toBeUndefined();
    expect(env.GIT_ALTERNATE_OBJECT_DIRECTORIES).toBeUndefined();
    expect(env.GIT_NAMESPACE).toBeUndefined();
    expect(env.GIT_SEQUENCE_EDITOR).toBeUndefined();
    expect(env.AWS_CONFIG_FILE).toBeUndefined();
    expect(env.KUBECONFIG).toBeUndefined();
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(env.AWS_SHARED_CREDENTIALS_FILE).toBeUndefined();
    expect(env.AWS_WEB_IDENTITY_TOKEN_FILE).toBeUndefined();
    expect(env.AZURE_AUTH_LOCATION).toBeUndefined();
    expect(env.GIT_SSH_COMMAND).toBeUndefined();
    expect(env.GIT_EXEC_PATH).toBeUndefined();
    expect(env.EDITOR).toBeUndefined();
    expect(env.NPM_CONFIG_USERCONFIG).toBeUndefined();
    expect(env.GIT_CONFIG_GLOBAL).toBeUndefined();
    expect(env.CARGO_REGISTRIES_CRATES_IO_INDEX).toBe("https://trusted.example/crates.io-index");
    expect(env.SHELLOPTS).toBeUndefined();
    expect(env.PS4).toBeUndefined();
    expect(env.CLASSPATH).toBeUndefined();
    expect(env.JAVA_OPTS).toBeUndefined();
    expect(env.GOFLAGS).toBeUndefined();
    expect(env.RUSTFLAGS).toBeUndefined();
    expect(env.MAKEFLAGS).toBeUndefined();
    expect(env.MFLAGS).toBeUndefined();
    expect(env.PHPRC).toBeUndefined();
    expect(env.XDG_CONFIG_HOME).toBeUndefined();
    expect(env.YARN_RC_FILENAME).toBeUndefined();
    expect(env.PIP_INDEX_URL).toBeUndefined();
    expect(env.PIP_PYPI_URL).toBeUndefined();
    expect(env.PIP_EXTRA_INDEX_URL).toBeUndefined();
    expect(env.PIP_CONFIG_FILE).toBeUndefined();
    expect(env.PIP_FIND_LINKS).toBeUndefined();
    expect(env.PIP_TRUSTED_HOST).toBeUndefined();
    expect(env.UV_INDEX).toBeUndefined();
    expect(env.UV_INDEX_URL).toBeUndefined();
    expect(env.UV_PYTHON).toBeUndefined();
    expect(env.UV_DEFAULT_INDEX).toBeUndefined();
    expect(env.UV_EXTRA_INDEX_URL).toBeUndefined();
    expect(env.DOCKER_HOST).toBeUndefined();
    expect(env.DOCKER_TLS_VERIFY).toBeUndefined();
    expect(env.DOCKER_CERT_PATH).toBeUndefined();
    expect(env.DOCKER_CONTEXT).toBeUndefined();
    expect(env.LIBRARY_PATH).toBeUndefined();
    expect(env.CPATH).toBeUndefined();
    expect(env.C_INCLUDE_PATH).toBeUndefined();
    expect(env.CPLUS_INCLUDE_PATH).toBeUndefined();
    expect(env.OBJC_INCLUDE_PATH).toBeUndefined();
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(env.SSL_CERT_FILE).toBeUndefined();
    expect(env.SSL_CERT_DIR).toBeUndefined();
    expect(env.REQUESTS_CA_BUNDLE).toBeUndefined();
    expect(env.CURL_CA_BUNDLE).toBeUndefined();
    expect(env.GOPROXY).toBeUndefined();
    expect(env.GONOSUMCHECK).toBeUndefined();
    expect(env.GONOSUMDB).toBeUndefined();
    expect(env.GONOPROXY).toBeUndefined();
    expect(env.GOPRIVATE).toBeUndefined();
    expect(env.GOENV).toBeUndefined();
    expect(env.GOPATH).toBeUndefined();
    expect(env.CARGO_HOME).toBeUndefined();
    expect(env.HELM_HOME).toBeUndefined();
    expect(env.PYTHONUSERBASE).toBeUndefined();
    expect(env.VIRTUAL_ENV).toBeUndefined();
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
        VIMINIT: ":!touch /tmp/pwned",
        EXINIT: "silent !touch /tmp/pwned",
        LUA_INIT_5_4: "os.execute('touch /tmp/pwned')",
        HOSTALIASES: "/tmp/evil-hostaliases",
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
    expect(env.VIMINIT).toBeUndefined();
    expect(env.EXINIT).toBeUndefined();
    expect(env.LUA_INIT_5_4).toBeUndefined();
    expect(env.HOSTALIASES).toBeUndefined();
    expect(env.HTTPS_PROXY).toBe("http://trusted-proxy.example.test:8443");
    expect(env.KUBECONFIG).toBe("/tmp/trusted-kubeconfig");
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBe("/tmp/trusted-gcp.json");
    expect(env.AWS_SHARED_CREDENTIALS_FILE).toBe("/tmp/trusted-aws-credentials");
    expect(env.AWS_WEB_IDENTITY_TOKEN_FILE).toBe("/tmp/trusted-aws-web-token");
    expect(env.AWS_CONFIG_FILE).toBe("/tmp/trusted-aws-config");
    expect(env.AZURE_AUTH_LOCATION).toBe("/tmp/trusted-azure-auth.json");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/trusted-ssh-agent.sock");
    expect(env.DOCKER_CONTEXT).toBe("trusted-remote");
    expect(env.AWS_CONTAINER_CREDENTIALS_FULL_URI).toBeUndefined();
    expect(env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI).toBeUndefined();
    expect(env.CONFIG_SITE).toBeUndefined();
    expect(env.ANSIBLE_CONFIG).toBeUndefined();
    expect(env.R_PROFILE_USER).toBeUndefined();
    expect(env.ERL_AFLAGS).toBeUndefined();
    expect(env.TF_CLI_CONFIG_FILE).toBeUndefined();
    expect(env.TF_VAR_admin_cidr).toBe("10.0.0.0/24");
    expect(env.SAFE).toBe("1");
  });

  it("drops newly blocked override credential and startup vars", () => {
    const env = sanitizeHostExecEnv({
      baseEnv: {
        PATH: "/usr/bin:/bin",
      },
      overrides: {
        VIMINIT: ":!touch /tmp/pwned",
        HOSTALIASES: "/tmp/evil-hostaliases",
        AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://attacker/credentials",
        AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/attacker-credentials",
        ANSIBLE_CONFIG: "/tmp/override-ansible.cfg",
        ANSIBLE_REMOTE_TEMP: "/tmp/evil-ansible-remote",
        R_LIBS_USER: "/tmp/evil-r-libs-user",
        TF_CLI_CONFIG_FILE: "/tmp/override-terraformrc",
        TF_PLUGIN_CACHE_DIR: "/tmp/evil-tf-plugin-cache",
        CFLAGS: "-I/attacker/include",
        LDFLAGS: "-L/attacker/lib",
        XDG_CONFIG_DIRS: "/tmp/evil-config-dirs",
        TF_VAR_admin_cidr: "10.0.0.0/24",
        GITHUB_TOKEN: "ghp-test",
        DATABASE_URL: "postgres://attacker",
        NPM_TOKEN: "npm-test",
        SSH_AUTH_SOCK: "/tmp/evil-agent.sock",
        SAFE: "ok",
      },
    });

    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.OPENCLAW_CLI).toBe(OPENCLAW_CLI_ENV_VALUE);
    expect(env.VIMINIT).toBeUndefined();
    expect(env.HOSTALIASES).toBeUndefined();
    expect(env.AWS_CONTAINER_CREDENTIALS_FULL_URI).toBeUndefined();
    expect(env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI).toBeUndefined();
    expect(env.ANSIBLE_CONFIG).toBeUndefined();
    expect(env.ANSIBLE_REMOTE_TEMP).toBeUndefined();
    expect(env.R_LIBS_USER).toBeUndefined();
    expect(env.TF_CLI_CONFIG_FILE).toBeUndefined();
    expect(env.TF_PLUGIN_CACHE_DIR).toBeUndefined();
    expect(env.CFLAGS).toBeUndefined();
    expect(env.LDFLAGS).toBeUndefined();
    expect(env.XDG_CONFIG_DIRS).toBeUndefined();
    expect(env.TF_VAR_admin_cidr).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.NPM_TOKEN).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.SAFE).toBe("ok");
  });

  it("keeps trusted inherited proxy and TLS env while blocking overrides", () => {
    const env = sanitizeHostExecEnv({
      baseEnv: {
        PATH: "/usr/bin:/bin",
        HTTP_PROXY: "http://trusted-proxy.example.test:8080",
        HTTPS_PROXY: "http://trusted-proxy.example.test:8443",
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
        SSL_CERT_DIR: "/etc/ssl/certs",
        CURL_CA_BUNDLE: "/etc/ssl/cert.pem",
        DOCKER_TLS_VERIFY: "1",
      },
      overrides: {
        HTTP_PROXY: "http://evil-proxy.example.test:8080",
        NODE_TLS_REJECT_UNAUTHORIZED: "1",
        DOCKER_TLS_VERIFY: "0",
      },
    });

    expect(env).toEqual({
      OPENCLAW_CLI: OPENCLAW_CLI_ENV_VALUE,
      PATH: "/usr/bin:/bin",
      HTTP_PROXY: "http://trusted-proxy.example.test:8080",
      HTTPS_PROXY: "http://trusted-proxy.example.test:8443",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      SSL_CERT_DIR: "/etc/ssl/certs",
      CURL_CA_BUNDLE: "/etc/ssl/cert.pem",
      DOCKER_TLS_VERIFY: "1",
    });
  });

  it("blocks proxy, TLS, and Docker override values explicitly", () => {
    expect(isDangerousHostEnvOverrideVarName("HTTPS_PROXY")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("https_proxy")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("HTTP_PROXY")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("http_proxy")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("ALL_PROXY")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("no_proxy")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("NODE_TLS_REJECT_UNAUTHORIZED")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("node_extra_ca_certs")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("SSL_CERT_FILE")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("SSL_CERT_DIR")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("requests_ca_bundle")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("CURL_CA_BUNDLE")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("DOCKER_HOST")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("docker_cert_path")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("DOCKER_TLS_VERIFY")).toBe(true);
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
    expect(env.SHELLOPTS).toBeUndefined();
    expect(env.PS4).toBeUndefined();
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
        BAD_NUMBER: 1 as any,
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
    expect(isDangerousHostEnvOverrideVarName("HOME")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("zdotdir")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("GIT_DIR")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("git_work_tree")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("GIT_COMMON_DIR")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("git_index_file")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("GIT_OBJECT_DIRECTORY")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("git_alternate_object_directories")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("git_namespace")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("GIT_SSH_COMMAND")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("editor")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("NPM_CONFIG_USERCONFIG")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("git_config_global")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("CARGO_REGISTRIES_CRATES_IO_INDEX")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("cargo_registries_internal_index")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("GRADLE_USER_HOME")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("gradle_user_home")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("PIP_INDEX_URL")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("pip_config_file")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("PIP_FIND_LINKS")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("pip_trusted_host")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("pip_pypi_url")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("PIP_EXTRA_INDEX_URL")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("UV_INDEX")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("UV_INDEX_URL")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("uv_python")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("uv_default_index")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("UV_EXTRA_INDEX_URL")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("DOCKER_HOST")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("docker_context")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("NODE_EXTRA_CA_CERTS")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("ssl_cert_file")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("REQUESTS_CA_BUNDLE")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("curl_ca_bundle")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("LIBRARY_PATH")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("c_include_path")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("GOPROXY")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("gonosumdb")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("GOPRIVATE")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("goenv")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("PYTHONUSERBASE")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("virtual_env")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("KUBECONFIG")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("google_application_credentials")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("AWS_SHARED_CREDENTIALS_FILE")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("aws_web_identity_token_file")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("AZURE_AUTH_LOCATION")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("cargo_home")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("HELM_HOME")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("CLASSPATH")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("classpath")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("MAKEFLAGS")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("makeflags")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("MFLAGS")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("mflags")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("GOFLAGS")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("goflags")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("HGRCPATH")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("hgrcpath")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("RUSTC_WRAPPER")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("rustc_wrapper")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("RUSTFLAGS")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("rustflags")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("CARGO_BUILD_RUSTC_WRAPPER")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("cargo_build_rustc_wrapper")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("CARGO_HOME")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("cargo_home")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("TF_VAR_admin_cidr")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("CORECLR_PROFILER_PATH")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("coreclr_profiler_path")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("XDG_CONFIG_HOME")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("xdg_config_home")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("XDG_CONFIG_DIRS")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("xdg_config_dirs")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("AWS_CONFIG_FILE")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("aws_config_file")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("yarn_rc_filename")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("BASH_ENV")).toBe(false);
    expect(isDangerousHostEnvOverrideVarName("FOO")).toBe(false);
  });

  it("blocks newly added credential and build influence keys", () => {
    const keys = [
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "GITLAB_TOKEN",
      "NPM_TOKEN",
      "NODE_AUTH_TOKEN",
      "AWS_ACCESS_KEY_ID",
      "AWS_CONTAINER_CREDENTIALS_FULL_URI",
      "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
      "ANSIBLE_CONFIG",
      "ANSIBLE_LIBRARY",
      "ANSIBLE_REMOTE_TEMP",
      "R_LIBS_USER",
      "TF_CLI_CONFIG_FILE",
      "TF_PLUGIN_CACHE_DIR",
      "CFLAGS",
      "LDFLAGS",
      "XDG_CONFIG_DIRS",
      "AWS_SECRET_ACCESS_KEY",
      "AZURE_CLIENT_SECRET",
      "DATABASE_URL",
      "REDIS_URL",
      "MONGODB_URI",
      "AMQP_URL",
      "SSH_AUTH_SOCK",
    ] as const;

    for (const key of keys) {
      expect(isDangerousHostEnvOverrideVarName(key)).toBe(true);
      expect(isDangerousHostEnvOverrideVarName(key.toLowerCase())).toBe(true);
    }
  });
});

describe("sanitizeHostExecEnvWithDiagnostics", () => {
  it("reports blocked and invalid requested overrides", () => {
    const result = sanitizeHostExecEnvWithDiagnostics({
      baseEnv: {
        PATH: "/usr/bin:/bin",
      },
      overrides: {
        PATH: "/tmp/evil",
        CXX: "/tmp/evil-cxx",
        CARGO_BUILD_RUSTC_WRAPPER: "/tmp/evil-rustc-wrapper",
        CARGO_REGISTRIES_CRATES_IO_INDEX: "https://example.invalid/crates.io-index",
        CMAKE_C_COMPILER: "/tmp/evil-c-compiler",
        KUBECONFIG: "/tmp/evil-kubeconfig",
        GOOGLE_APPLICATION_CREDENTIALS: "/tmp/evil-gcp.json",
        AWS_SHARED_CREDENTIALS_FILE: "/tmp/evil-aws-credentials",
        AWS_WEB_IDENTITY_TOKEN_FILE: "/tmp/evil-aws-web-token",
        AZURE_AUTH_LOCATION: "/tmp/evil-azure-auth.json",
        CLASSPATH: "/tmp/evil-classpath",
        PIP_INDEX_URL: "https://example.invalid/simple",
        PIP_PYPI_URL: "https://example.invalid/simple",
        PIP_EXTRA_INDEX_URL: "https://example.invalid/simple",
        PIP_CONFIG_FILE: "/tmp/evil-pip.conf",
        PIP_FIND_LINKS: "https://example.invalid/wheels",
        PIP_TRUSTED_HOST: "example.invalid",
        UV_INDEX: "https://example.invalid/simple",
        UV_INDEX_URL: "https://example.invalid/simple",
        UV_PYTHON: "/tmp/evil-uv-python",
        UV_DEFAULT_INDEX: "https://example.invalid/simple",
        UV_EXTRA_INDEX_URL: "https://example.invalid/simple",
        DOCKER_HOST: "tcp://example.invalid:2376",
        DOCKER_TLS_VERIFY: "1",
        DOCKER_CERT_PATH: "/tmp/evil-docker-certs",
        DOCKER_CONTEXT: "evil-remote",
        LIBRARY_PATH: "/tmp/evil-lib",
        CPATH: "/tmp/evil-headers",
        C_INCLUDE_PATH: "/tmp/evil-c-headers",
        CPLUS_INCLUDE_PATH: "/tmp/evil-cpp-headers",
        OBJC_INCLUDE_PATH: "/tmp/evil-objc-headers",
        NODE_EXTRA_CA_CERTS: "/tmp/evil-ca.pem",
        SSL_CERT_FILE: "/tmp/evil-cert.pem",
        SSL_CERT_DIR: "/tmp/evil-cert-dir",
        REQUESTS_CA_BUNDLE: "/tmp/evil-requests-ca.pem",
        CURL_CA_BUNDLE: "/tmp/evil-curl-ca.pem",
        GIT_DIR: "/tmp/evil-git-dir",
        GIT_WORK_TREE: "/tmp/evil-work-tree",
        GIT_COMMON_DIR: "/tmp/evil-common-dir",
        GIT_INDEX_FILE: "/tmp/evil-git-index",
        GIT_OBJECT_DIRECTORY: "/tmp/evil-git-objects",
        GIT_ALTERNATE_OBJECT_DIRECTORIES: "/tmp/evil-git-alt-objects",
        GIT_NAMESPACE: "evil-namespace",
        GOPROXY: "https://example.invalid/proxy",
        GONOSUMCHECK: "example.invalid/*",
        GONOSUMDB: "example.invalid/*",
        GONOPROXY: "example.invalid/*",
        GOPRIVATE: "example.invalid/*",
        GOENV: "/tmp/evil-goenv",
        GOPATH: "/tmp/evil-go",
        CARGO_HOME: "/tmp/evil-cargo",
        HGRCPATH: "/tmp/evil-hgrc",
        MAKEFLAGS: "--eval=$(shell touch /tmp/pwned)",
        MFLAGS: "--eval=$(shell touch /tmp/pwned-too)",
        HELM_HOME: "/tmp/evil-helm",
        PYTHONUSERBASE: "/tmp/evil-python-userbase",
        RUSTC_WRAPPER: "/tmp/evil-rustc-wrapper",
        RUSTFLAGS: "-C link-args=-l/tmp/evil.so",
        VIRTUAL_ENV: "/tmp/evil-venv",
        JAVA_OPTS: "-javaagent:/tmp/evil.jar",
        YARN_RC_FILENAME: ".evil-yarnrc.yml",
        HTTPS_PROXY: "http://proxy.example.test:8080",
        GIT_SSL_NO_VERIFY: "1",
        GIT_SSL_CAINFO: "/tmp/evil-git-ca.pem",
        GIT_SSL_CAPATH: "/tmp/evil-git-capath",
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
        SAFE_KEY: "ok",
        "BAD-KEY": "bad",
      },
    });

    expect(result.rejectedOverrideBlockedKeys).toEqual([
      "AWS_SHARED_CREDENTIALS_FILE",
      "AWS_WEB_IDENTITY_TOKEN_FILE",
      "AZURE_AUTH_LOCATION",
      "C_INCLUDE_PATH",
      "CARGO_BUILD_RUSTC_WRAPPER",
      "CARGO_HOME",
      "CARGO_REGISTRIES_CRATES_IO_INDEX",
      "CLASSPATH",
      "CMAKE_C_COMPILER",
      "CPATH",
      "CPLUS_INCLUDE_PATH",
      "CURL_CA_BUNDLE",
      "CXX",
      "DOCKER_CERT_PATH",
      "DOCKER_CONTEXT",
      "DOCKER_HOST",
      "DOCKER_TLS_VERIFY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_COMMON_DIR",
      "GIT_DIR",
      "GIT_INDEX_FILE",
      "GIT_NAMESPACE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_SSL_CAINFO",
      "GIT_SSL_CAPATH",
      "GIT_SSL_NO_VERIFY",
      "GIT_WORK_TREE",
      "GOENV",
      "GONOPROXY",
      "GONOSUMCHECK",
      "GONOSUMDB",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "GOPATH",
      "GOPRIVATE",
      "GOPROXY",
      "HELM_HOME",
      "HGRCPATH",
      "HTTPS_PROXY",
      "JAVA_OPTS",
      "KUBECONFIG",
      "LIBRARY_PATH",
      "MAKEFLAGS",
      "MFLAGS",
      "NODE_EXTRA_CA_CERTS",
      "NODE_TLS_REJECT_UNAUTHORIZED",
      "OBJC_INCLUDE_PATH",
      "PATH",
      "PIP_CONFIG_FILE",
      "PIP_EXTRA_INDEX_URL",
      "PIP_FIND_LINKS",
      "PIP_INDEX_URL",
      "PIP_PYPI_URL",
      "PIP_TRUSTED_HOST",
      "PYTHONUSERBASE",
      "REQUESTS_CA_BUNDLE",
      "RUSTC_WRAPPER",
      "RUSTFLAGS",
      "SSL_CERT_DIR",
      "SSL_CERT_FILE",
      "UV_DEFAULT_INDEX",
      "UV_EXTRA_INDEX_URL",
      "UV_INDEX",
      "UV_INDEX_URL",
      "UV_PYTHON",
      "VIRTUAL_ENV",
      "YARN_RC_FILENAME",
    ]);
    expect(result.rejectedOverrideInvalidKeys).toEqual(["BAD-KEY"]);
    expect(result.env.SAFE_KEY).toBe("ok");
    expect(result.env.PATH).toBe("/usr/bin:/bin");
    expect(result.env.CLASSPATH).toBeUndefined();
    expect(result.env.CXX).toBeUndefined();
    expect(result.env.CMAKE_C_COMPILER).toBeUndefined();
    expect(result.env.CARGO_BUILD_RUSTC_WRAPPER).toBeUndefined();
    expect(result.env.CARGO_REGISTRIES_CRATES_IO_INDEX).toBeUndefined();
    expect(result.env.PIP_INDEX_URL).toBeUndefined();
    expect(result.env.PIP_PYPI_URL).toBeUndefined();
    expect(result.env.PIP_EXTRA_INDEX_URL).toBeUndefined();
    expect(result.env.PIP_CONFIG_FILE).toBeUndefined();
    expect(result.env.PIP_FIND_LINKS).toBeUndefined();
    expect(result.env.PIP_TRUSTED_HOST).toBeUndefined();
    expect(result.env.UV_INDEX).toBeUndefined();
    expect(result.env.UV_INDEX_URL).toBeUndefined();
    expect(result.env.UV_PYTHON).toBeUndefined();
    expect(result.env.UV_DEFAULT_INDEX).toBeUndefined();
    expect(result.env.UV_EXTRA_INDEX_URL).toBeUndefined();
    expect(result.env.KUBECONFIG).toBeUndefined();
    expect(result.env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(result.env.AWS_SHARED_CREDENTIALS_FILE).toBeUndefined();
    expect(result.env.AWS_WEB_IDENTITY_TOKEN_FILE).toBeUndefined();
    expect(result.env.AZURE_AUTH_LOCATION).toBeUndefined();
    expect(result.env.GIT_SSL_NO_VERIFY).toBeUndefined();
    expect(result.env.GIT_SSL_CAINFO).toBeUndefined();
    expect(result.env.GIT_SSL_CAPATH).toBeUndefined();
    expect(result.env.DOCKER_HOST).toBeUndefined();
    expect(result.env.DOCKER_TLS_VERIFY).toBeUndefined();
    expect(result.env.DOCKER_CERT_PATH).toBeUndefined();
    expect(result.env.DOCKER_CONTEXT).toBeUndefined();
    expect(result.env.LIBRARY_PATH).toBeUndefined();
    expect(result.env.CPATH).toBeUndefined();
    expect(result.env.C_INCLUDE_PATH).toBeUndefined();
    expect(result.env.CPLUS_INCLUDE_PATH).toBeUndefined();
    expect(result.env.OBJC_INCLUDE_PATH).toBeUndefined();
    expect(result.env.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(result.env.SSL_CERT_FILE).toBeUndefined();
    expect(result.env.SSL_CERT_DIR).toBeUndefined();
    expect(result.env.REQUESTS_CA_BUNDLE).toBeUndefined();
    expect(result.env.CURL_CA_BUNDLE).toBeUndefined();
    expect(result.env.GIT_DIR).toBeUndefined();
    expect(result.env.GIT_WORK_TREE).toBeUndefined();
    expect(result.env.GIT_COMMON_DIR).toBeUndefined();
    expect(result.env.GIT_INDEX_FILE).toBeUndefined();
    expect(result.env.GIT_ALTERNATE_OBJECT_DIRECTORIES).toBeUndefined();
    expect(result.env.GIT_OBJECT_DIRECTORY).toBeUndefined();
    expect(result.env.GIT_NAMESPACE).toBeUndefined();
    expect(result.env.GOPROXY).toBeUndefined();
    expect(result.env.GONOSUMCHECK).toBeUndefined();
    expect(result.env.GONOSUMDB).toBeUndefined();
    expect(result.env.GONOPROXY).toBeUndefined();
    expect(result.env.GOPRIVATE).toBeUndefined();
    expect(result.env.GOENV).toBeUndefined();
    expect(result.env.GOPATH).toBeUndefined();
    expect(result.env.CARGO_HOME).toBeUndefined();
    expect(result.env.HGRCPATH).toBeUndefined();
    expect(result.env.HELM_HOME).toBeUndefined();
    expect(result.env.HTTPS_PROXY).toBeUndefined();
    expect(result.env.JAVA_OPTS).toBeUndefined();
    expect(result.env.MAKEFLAGS).toBeUndefined();
    expect(result.env.MFLAGS).toBeUndefined();
    expect(result.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
    expect(result.env.PYTHONUSERBASE).toBeUndefined();
    expect(result.env.RUSTC_WRAPPER).toBeUndefined();
    expect(result.env.RUSTFLAGS).toBeUndefined();
    expect(result.env.VIRTUAL_ENV).toBeUndefined();
    expect(result.env.YARN_RC_FILENAME).toBeUndefined();
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
        XDG_CONFIG_DIRS: "/tmp/evil-config-dirs",
        TF_VAR_admin_cidr: "10.0.0.0/24",
        SAFE_KEY: "ok",
      },
    });

    expect(result.rejectedOverrideBlockedKeys).toEqual([
      "ANSIBLE_CONFIG",
      "ANSIBLE_REMOTE_TEMP",
      "AWS_CONTAINER_CREDENTIALS_FULL_URI",
      "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
      "DATABASE_URL",
      "GITHUB_TOKEN",
      "HOSTALIASES",
      "LUA_INIT_5_4",
      "R_LIBS_USER",
      "R_PROFILE_USER",
      "TF_CLI_CONFIG_FILE",
      "TF_PLUGIN_CACHE_DIR",
      "TF_VAR_ADMIN_CIDR",
      "VIMINIT",
      "XDG_CONFIG_DIRS",
    ]);
    expect(result.rejectedOverrideInvalidKeys).toEqual([]);
    expect(result.env.SAFE_KEY).toBe("ok");
    expect(result.env.VIMINIT).toBeUndefined();
    expect(result.env.LUA_INIT_5_4).toBeUndefined();
    expect(result.env.HOSTALIASES).toBeUndefined();
    expect(result.env.ANSIBLE_CONFIG).toBeUndefined();
    expect(result.env.ANSIBLE_REMOTE_TEMP).toBeUndefined();
    expect(result.env.R_LIBS_USER).toBeUndefined();
    expect(result.env.TF_CLI_CONFIG_FILE).toBeUndefined();
    expect(result.env.TF_PLUGIN_CACHE_DIR).toBeUndefined();
    expect(result.env.GITHUB_TOKEN).toBeUndefined();
    expect(result.env.DATABASE_URL).toBeUndefined();
    expect(result.env.R_PROFILE_USER).toBeUndefined();
    expect(result.env.XDG_CONFIG_DIRS).toBeUndefined();
    expect(result.env.TF_VAR_admin_cidr).toBeUndefined();
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

    expect(result.rejectedOverrideBlockedKeys).toEqual([]);
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

  it("blocks GIT_SSH_COMMAND override so git cannot execute helper payloads", async () => {
    const gitPath = getSystemGitPath();
    if (!gitPath) {
      return;
    }

    const marker = path.join(os.tmpdir(), `openclaw-git-ssh-command-${process.pid}-${Date.now()}`);
    clearMarker(marker);

    const target = "ssh://127.0.0.1:1/does-not-matter";
    const exploitValue = `touch ${JSON.stringify(marker)}; false`;
    const baseEnv = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_TERMINAL_PROMPT: "0",
    };

    const unsafeEnv = {
      ...baseEnv,
      GIT_SSH_COMMAND: exploitValue,
    };

    await runGitLsRemote(gitPath, target, unsafeEnv);

    expect(fs.existsSync(marker)).toBe(true);
    clearMarker(marker);

    const safeEnv = sanitizeHostExecEnv({
      baseEnv,
      overrides: {
        GIT_SSH_COMMAND: exploitValue,
      },
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

      await runMakeCommand(makePath, tempDir, {
        ...baseEnv,
        CC: exploitPath,
      });

      expect(fs.existsSync(marker)).toBe(true);
      clearMarker(marker);

      const safeEnv = sanitizeHostExecEnv({
        baseEnv,
        overrides: {
          CC: exploitPath,
        },
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

      await runMakeCommand(makePath, tempDir, {
        ...baseEnv,
        MAKEFLAGS: exploitValue,
      });

      const baselineTriggered = fs.existsSync(marker);
      clearMarker(marker);

      const safeEnv = sanitizeHostExecEnv({
        baseEnv,
        overrides: {
          MAKEFLAGS: exploitValue,
        },
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
