---
summary: "Run OpenClaw in a Docker Sandbox with proxy-managed credentials and sandboxed tool calls"
read_when:
  - You want to run OpenClaw somewhere isolated without managing a VPS
  - You want the provider credential stored outside the sandbox the agent runs in
title: "Docker Sandboxes"
---

Run OpenClaw in a [Docker Sandbox](https://docs.docker.com/ai/sandboxes/): an
isolated environment on your own machine. The credential you store never has to
be written inside it: the sandbox receives a placeholder value, and the sandbox
proxy substitutes the real one on requests leaving for the provider host. Egress
is limited to a declared allowlist, and the agent's own tool calls run in a
second sandbox inside the first.

How far that substitution isolates the credential from code running in the
sandbox is a property of Docker Sandboxes and the kit, not of OpenClaw. Treat it
as the placeholder-substitution mechanism described above rather than a
guarantee this page can make.

The environment ships as a kit, so this is two commands: store a credential,
then start.

<Note>
The `openclaw` kit is community maintained in
[docker/sbx-kits-contrib](https://github.com/docker/sbx-kits-contrib/tree/main/openclaw).
Report kit issues and contribute there. This page describes the kit at
[`cc502cd`](https://github.com/docker/sbx-kits-contrib/commit/cc502cd); the
`:latest` artifact moves, so behavior can change ahead of this page.
</Note>

## What you need

- The `sbx` CLI. It ships its own `sandboxd` daemon and does not need Docker
  Desktop. See the [Docker Sandboxes docs](https://docs.docker.com/ai/sandboxes/)
  for install steps.
- A Docker login, so kit and template images can be pulled: `sbx login`.
- An Anthropic API key, or a token from `claude setup-token` on a machine with
  Claude Code.

## Store the credential first

Credentials are wired when a sandbox is created, so store yours before starting
one. Both commands prompt with `Enter secret:` and read the value from stdin, so
it never becomes a shell argument.

An API key goes in as a service secret:

```bash
sbx secret set anthropic
```

A Claude subscription token goes in as a custom secret, with a placeholder
shaped like an OAuth token:

```bash
sbx secret set-custom \
  --host api.anthropic.com \
  --env ANTHROPIC_OAUTH_TOKEN \
  --placeholder 'sk-ant-oat01-{rand}'
```

`{rand}` is expanded when the secret is stored, so the sandbox receives an
OAuth-shaped value. The shape decides the request: OpenClaw sends a token
containing `sk-ant-oat` as a bearer token and anything else as `x-api-key`, and
Anthropic rejects either one sent in the wrong header. A subscription token
stored as a service secret fails for exactly that reason.

Bind one credential, not both. A service secret makes the proxy set `x-api-key`
on every request to `api.anthropic.com`, so a bearer credential alongside it
sends two auth headers and Anthropic rejects the request.

<Warning>
Do not authenticate from inside the sandbox. OpenClaw's own auth commands write
a real credential to the agent's auth store in the container, where the agent
and anything it runs can read it, which defeats the whole proxy-managed model.
</Warning>

## Start OpenClaw

```bash
sbx run --kit "docker.io/sbx/openclaw-kit:latest" openclaw
```

This lands you in `openclaw chat`. Say hello: a reply means the Gateway, its
token, and your provider credential are all wired correctly.

The kit has already done the parts that are easy to get wrong. The Gateway
starts with the container rather than on attach, so its published port answers
before anyone attaches. It generates its own token on first boot, because it
binds to the container's external interface for port publishing and refuses a
non-loopback bind without one. And it enables
[Docker-backed sandboxing](/gateway/sandboxing#docker-backend) for tool
execution, pulling the image it needs on first boot, so the agent's shell never
shares a filesystem with the Gateway's credential state:

```bash
sbx exec <sandbox-name> -- openclaw sandbox list
```

Tool calls land in a container named `openclaw-sbx-<session>` as an unprivileged
user, with the agent workspace at `/workspace`. That inner Docker daemon is the
sandbox's own, separate from the one on your machine, so the
[Docker-out-of-Docker constraints](/gateway/sandboxing#docker-backend) do not
apply.

## Open the Control UI

The dashboard is on the published port:

```bash
sbx ports <sandbox-name>
```

Open `http://127.0.0.1:<published-port>/` and paste the Gateway token when
asked. Read it from the config file, since `openclaw config get
gateway.auth.token` returns a redaction placeholder rather than the value:

```bash
sbx exec <sandbox-name> -- sh -lc 'jq -r .gateway.auth.token ~/.openclaw/openclaw.json'
```

## Drive it from scripts

`sbx exec` reaches the same Gateway without attaching:

```bash
sbx exec <sandbox-name> -- openclaw agent --agent main --message "what version are you running"
```

Wait for `~/.openclaw/gateway-ready` first if you run this right after starting a
sandbox. Startup commands do not block `sbx exec`, and that sentinel is what the
kit writes once the Gateway is serving.

## Change the credential or the kit

Both are applied at create time, so neither takes effect in a running sandbox.
Store the new secret or pull the new kit, then start a fresh one:

```bash
sbx rm -f <sandbox-name>
sbx run --kit "docker.io/sbx/openclaw-kit:latest" openclaw
```

The OpenClaw version is pinned by the kit image, so a newer OpenClaw arrives
with a newer kit rather than through an in-place update.

## Troubleshooting

| Symptom | Cause |
| ------- | ----- |
| `No API key found for provider "anthropic"` | No credential bound on the host. Store one, then start a fresh sandbox. |
| `authentication_error: API key is invalid` | The credential reached Anthropic in the wrong shape, usually a subscription token bound as a service secret, or a stale service secret still setting `x-api-key`. |
| `authentication_error: OAuth access token is invalid` | The bearer placeholder went out unswapped, so no matching credential is bound for that host. |
| `auth flow failed (exit 1)` after `/auth` | Interactive login needs a TTY the TUI's subprocess does not get. Credentials belong on the host. |
| `Sandbox image not found: docker/sandbox-templates:shell-docker. Build or pull it first.` | The kit's first-boot image pull has not finished. Check `~/.openclaw/sandbox-image-pull.log` in the sandbox. |
| A new secret changes nothing | Credentials are wired at create time. Start a fresh sandbox. |

## Related

- [Channels](/channels) -- connect Telegram, Discord, WhatsApp, or Slack
- [Gateway configuration](/gateway/configuration)
- [Sandboxing](/gateway/sandboxing) -- the tool-execution sandbox the kit turns on
- [Security](/gateway/security)
