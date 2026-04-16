# Bundled plugin skill runtime

```yaml qa-scenario
id: bundled-plugin-skill-runtime
title: Bundled plugin skill runtime
surface: skills
objective: Verify packaged bundled plugin skills load from dist-runtime instead of being skipped by path-containment checks.
successCriteria:
  - The runtime-packaged bundled plugin tree is used as OPENCLAW_BUNDLED_PLUGINS_DIR.
  - The enabled bundled plugin skill is reported as eligible by the skills CLI.
  - The check fails on SKILL.md symlink escapes and passes when runtime staging copies SKILL.md as a real file.
docsRefs:
  - docs/tools/skills.md
  - docs/plugins/manifest.md
codeRefs:
  - scripts/stage-bundled-plugin-runtime.mjs
  - src/agents/skills/workspace.ts
  - src/agents/skills/plugin-skills.ts
execution:
  kind: flow
  summary: Force the packaged dist-runtime plugin tree and verify an enabled bundled plugin skill survives discovery.
  config:
    pluginId: open-prose
    expectedSkillName: prose
```

```yaml qa-flow
steps:
  - name: loads a bundled plugin skill from dist-runtime
    actions:
      - set: skillCheck
        value:
          expr: |-
            (async () => {
              const { spawnSync } = await qaImport("node:child_process");
              const fsSync = await qaImport("node:fs");
              const distRuntimeExtensions = path.join(env.repoRoot, "dist-runtime", "extensions");
              const skillPath = path.join(
                distRuntimeExtensions,
                config.pluginId,
                "skills",
                config.expectedSkillName,
                "SKILL.md",
              );
              const tempRoot = await fs.mkdtemp(path.join(env.gateway.tempRoot, "bundled-skill-runtime-"));
              const homeDir = path.join(tempRoot, "home");
              const stateDir = path.join(tempRoot, "state");
              const workspaceDir = path.join(tempRoot, "workspace");
              const xdgConfigHome = path.join(tempRoot, "xdg-config");
              const xdgDataHome = path.join(tempRoot, "xdg-data");
              const xdgCacheHome = path.join(tempRoot, "xdg-cache");
              await Promise.all(
                [homeDir, stateDir, workspaceDir, xdgConfigHome, xdgDataHome, xdgCacheHome].map((dir) =>
                  fs.mkdir(dir, { recursive: true }),
                ),
              );
              const configPath = path.join(tempRoot, "openclaw.json");
              await fs.writeFile(
                configPath,
                `${JSON.stringify(
                  {
                    agents: { defaults: { workspace: workspaceDir } },
                    plugins: {
                      allow: [config.pluginId],
                      entries: { [config.pluginId]: { enabled: true } },
                    },
                  },
                  null,
                  2,
                )}\n`,
                "utf8",
              );
              const cliEnv = {
                ...env.gateway.runtimeEnv,
                HOME: homeDir,
                OPENCLAW_HOME: homeDir,
                OPENCLAW_CONFIG_PATH: configPath,
                OPENCLAW_STATE_DIR: stateDir,
                OPENCLAW_OAUTH_DIR: path.join(stateDir, "credentials"),
                OPENCLAW_BUNDLED_PLUGINS_DIR: distRuntimeExtensions,
                XDG_CONFIG_HOME: xdgConfigHome,
                XDG_DATA_HOME: xdgDataHome,
                XDG_CACHE_HOME: xdgCacheHome,
              };
              const result = spawnSync(
                process.execPath,
                [path.join(env.repoRoot, "dist", "index.js"), "skills", "list", "--json", "--eligible"],
                {
                  cwd: tempRoot,
                  env: cliEnv,
                  encoding: "utf8",
                  timeout: 60000,
                },
              );
              let parsed = null;
              let parseError = null;
              try {
                parsed = result.stdout ? JSON.parse(result.stdout) : null;
              } catch (error) {
                parseError = formatErrorMessage(error);
              }
              const skills = Array.isArray(parsed?.skills) ? parsed.skills : [];
              const skill = skills.find((entry) => entry?.name === config.expectedSkillName);
              return {
                exitCode: result.status,
                signal: result.signal,
                parseError,
                skill,
                skillNames: skills.map((entry) => entry?.name).filter(Boolean).sort(),
                skillPath: path.relative(env.repoRoot, skillPath),
                skillMdSymlink: fsSync.existsSync(skillPath) ? fsSync.lstatSync(skillPath).isSymbolicLink() : null,
                stderr: String(result.stderr ?? "").replaceAll(env.repoRoot, "<repo>").trim().slice(0, 1200),
              };
            })()
      - assert:
          expr: "skillCheck.exitCode === 0 && skillCheck.skill?.eligible === true && !skillCheck.skill?.disabled && !skillCheck.skill?.blockedByAllowlist"
          message:
            expr: |-
              `expected bundled plugin skill "${config.expectedSkillName}" from "${config.pluginId}" to load from dist-runtime; got ${JSON.stringify(skillCheck.skill)}; SKILL.md symlink=${skillCheck.skillMdSymlink}; stderr=${skillCheck.stderr || "(empty)"}`
    detailsExpr: skillCheck
```
