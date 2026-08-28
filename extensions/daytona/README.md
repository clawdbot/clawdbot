# OpenClaw Daytona Sandbox Plugin

Sandbox backend that runs OpenClaw agent tool execution (`exec`, `read`, `write`,
`edit`, `apply_patch`, media reads) inside [Daytona](https://www.daytona.io)
cloud sandboxes over the Daytona toolbox API. The Gateway, agent loop, model
calls, and channels stay on the host.

## Install

```bash
openclaw plugins install @openclaw/daytona-sandbox
```

## Configure

```jsonc
{
  "plugins": {
    "entries": {
      "daytona": {
        "enabled": true,
        "config": {
          "apiKey": { "source": "env", "provider": "default", "id": "DAYTONA_API_KEY" },
        },
      },
    },
  },
  "agents": {
    "defaults": {
      "sandbox": { "mode": "all", "backend": "daytona" },
    },
  },
}
```

`apiKey` accepts a plaintext string or a SecretRef and falls back to the
`DAYTONA_API_KEY` environment variable.

## Facts

- Package: `@openclaw/daytona-sandbox` (external official plugin).
- One Daytona sandbox per sandbox scope (`agent`, `session`, or `shared`),
  adopted across restarts through the OpenClaw sandbox registry.
- Remote-canonical workspace: the session workspace is seeded once into the
  sandbox at creation; `openclaw sandbox recreate` deletes the sandbox and
  re-seeds on next use.
- The sandbox image needs `sh`, `tar`, `base64`, `stat`, and `python3` on
  `PATH` (the Daytona default snapshot has all of them).

Docs: https://docs.openclaw.ai/gateway/daytona
