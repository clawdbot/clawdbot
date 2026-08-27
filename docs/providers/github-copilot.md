---
summary: "Sign in to GitHub Copilot from OpenClaw using the device flow or non-interactive token import"
read_when:
  - You want to use GitHub Copilot as a model provider
  - You need the `openclaw models auth login-github-copilot` flow
  - You are choosing between the built-in Copilot provider, Copilot SDK harness, and Copilot Proxy
title: "GitHub Copilot"
---

GitHub Copilot is GitHub's AI coding assistant. It provides access to Copilot
models for your GitHub account and plan. OpenClaw can use Copilot as a model
provider or agent runtime in three different ways.

## Three ways to use Copilot in OpenClaw

<Tabs>
  <Tab title="Built-in provider (github-copilot)">
    Use the native device-login flow to obtain and store a GitHub token. When
    OpenClaw runs, it validates Copilot access and resolves the account-specific
    Copilot API endpoint. This is the **default** and simplest path because it does
    not require VS Code.

    <Steps>
      <Step title="Run the login command">
        ```bash
        openclaw models auth login-github-copilot
        ```

        You will be prompted to visit a URL and enter a one-time code. Keep the
        terminal open until it completes.
      </Step>
      <Step title="Set a default model">
        ```bash
        openclaw models set github-copilot/claude-sonnet-5
        ```

        Or in config:

        ```json5
        {
          agents: {
            defaults: { model: { primary: "github-copilot/claude-sonnet-5" } },
          },
        }
        ```
      </Step>
    </Steps>

  </Tab>

  <Tab title="Copilot SDK harness plugin (copilot)">
    Install the external `@openclaw/copilot` plugin when you want GitHub's
    Copilot CLI and SDK to own the low-level agent loop for selected
    `github-copilot/*` models.

    ```bash
    openclaw plugins install @openclaw/copilot
    ```

    Then opt a model or provider into the runtime:

    ```json5
    {
      agents: {
        defaults: {
          model: "github-copilot/gpt-5.6-sol",
          models: {
            "github-copilot/gpt-5.6-sol": {
              agentRuntime: { id: "copilot" },
            },
          },
        },
      },
    }
    ```

    Choose this when you want native Copilot CLI sessions, SDK-managed thread
    state, and Copilot-owned compaction for those agent turns. Without the
    explicit `agentRuntime` opt-in, `github-copilot/*` models keep using the
    built-in provider. See [Copilot SDK harness](/plugins/copilot) for the full
    runtime contract.

  </Tab>

  <Tab title="Copilot Proxy plugin (copilot-proxy)">
    Use the **Copilot Proxy** VS Code extension as a local bridge. OpenClaw talks to
    the proxy's `/v1` endpoint (default `http://localhost:3000/v1`) and uses the
    model list you configure.

    The `copilot-proxy` plugin ships with OpenClaw and is enabled by default.
    Configure the base URL and model ids with:

    ```bash
    openclaw models auth login --provider copilot-proxy --set-default
    ```

    <Note>
    Choose this when you already run Copilot Proxy in VS Code or need to route
    through it. The VS Code extension must stay running.
    </Note>

  </Tab>
</Tabs>

## GitHub Enterprise (data residency)

If your organization uses a data-residency GitHub Enterprise tenant (a
`*.ghe.com` host such as `your-org.ghe.com`), Copilot lives on tenant-local
endpoints rather than public `github.com`. OpenClaw exposes this as a
first-class auth choice so you do not have to hand-edit URLs.

<Steps>
  <Step title="Pick the Enterprise auth choice">
    In onboarding or `openclaw models auth`, choose
    **GitHub Copilot (Enterprise / data residency)**. You will be prompted for
    your Enterprise domain (for example `your-org.ghe.com`), then the device
    login runs against that tenant.

    Enter the tenant root only (`your-org.ghe.com`). Derived service hosts such
    as `api.your-org.ghe.com` or `copilot-api.your-org.ghe.com` are not accepted;
    OpenClaw derives those endpoints from the tenant root automatically.

    ```bash
    openclaw models auth login --provider github-copilot --method device-enterprise
    ```

  </Step>
  <Step title="Domain is persisted to config">
    The chosen host is stored under the provider params so later account
    validation and completions target the tenant automatically:

    ```json5
    {
      models: {
        providers: {
          "github-copilot": { params: { githubDomain: "your-org.ghe.com" } },
        },
      },
    }
    ```

  </Step>
</Steps>

The device flow and account validation use the tenant's GitHub endpoints, and
Copilot requests use `https://copilot-api.your-org.ghe.com`. This keeps both
authentication and inference on the configured data-residency tenant instead of
the public endpoints.

<Note>
Switching domains always re-runs the device login. If you already have a stored
Copilot token and pick a different domain (public `github.com` ↔ a `*.ghe.com`
tenant, or one tenant to another), OpenClaw will not reuse the existing token —
it forces a fresh login so the token is scoped to the domain being written to
config. Re-running login for the *same* domain still offers to reuse the current
token. Switching back to public `github.com` clears the persisted
`githubDomain` so config returns to the default.
</Note>

<Note>
The `COPILOT_GITHUB_DOMAIN` environment variable overrides the resolved domain
for every Copilot path that resolves it — the Enterprise device login
(`--method device-enterprise`), the standalone
`openclaw models auth login-github-copilot` shortcut, account validation,
embeddings, and completions. Set it to your `*.ghe.com` host for fully headless
or CI setups. Leave it unset (and the config param absent) to use public `github.com`.
Logins persist the domain they minted the token for (and clear it when logging
in against public `github.com`), so routing stays correct even after the
environment variable is unset.
</Note>

### Tenant request identity

OpenClaw uses the `copilot-developer-cli` request identity by default, including
for data-residency tenants. First confirm that your enterprise permits Copilot
CLI and the selected model. A `*.ghe.com` hostname does not imply a different
integration policy.

If your tenant administrator or GitHub support requires a different identity,
use the existing provider header setting:

```json5
{
  models: {
    providers: {
      "github-copilot": {
        params: { githubDomain: "your-org.ghe.com" },
        headers: { "Copilot-Integration-Id": "vscode-chat" },
      },
    },
  },
}
```

The provider identity applies to model selection during setup, live model
discovery, inference, and embeddings. Header names are case-insensitive; `request.headers` takes precedence
over provider `headers`. Embedding-specific `memory.search.remote.headers` still
takes precedence for embedding discovery and requests. Unrelated provider headers
are not forwarded to the catalog or embedding endpoints. Changing the identity
does not grant access to models or clients disabled by your organization's policy.

## Optional flags

| Command                                                                | Flag            | Description                                          |
| ---------------------------------------------------------------------- | --------------- | ---------------------------------------------------- |
| `openclaw models auth login-github-copilot`                            | `--yes`         | Overwrite an existing auth profile without prompting |
| `openclaw models auth login --provider github-copilot --method device` | `--set-default` | Also apply the provider's recommended default model  |

```bash
# Skip the re-login confirmation
openclaw models auth login-github-copilot --yes

# Login and set the default model in one step
openclaw models auth login --provider github-copilot --method device --set-default
```

## Non-interactive onboarding

The device-login flow requires an interactive TTY. For headless setup, import
an existing GitHub OAuth access token with `openclaw onboard --non-interactive`:

```bash
openclaw onboard --non-interactive --accept-risk \
  --auth-choice github-copilot \
  --github-copilot-token "$COPILOT_GITHUB_TOKEN" \
  --skip-channels --skip-health
```

You can also omit `--auth-choice`; passing `--github-copilot-token` infers the
GitHub Copilot provider auth choice. If the flag is omitted, onboarding falls
back to `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, then `GITHUB_TOKEN`. Use
`--secret-input-mode ref` with `COPILOT_GITHUB_TOKEN` set to store an env-backed
`tokenRef` instead of plaintext in the auth profile store.

Fresh non-interactive setup validates the token before saving it. When setup
must choose a default, it also checks the live Copilot model catalog. OpenClaw
prefers the provider's current general-purpose model when that model is
enabled for the account; otherwise it chooses a deterministic eligible fallback.
Setup fails without writing a new auth profile if the account has no
picker-visible model that supports streaming and tool calls. An explicitly
configured default model is never replaced.

<AccordionGroup>
  <Accordion title="Interactive TTY required">
    The device-login flow requires an interactive TTY. Run it directly in a
    terminal, not in a non-interactive script or CI pipeline.
  </Accordion>

  <Accordion title="Model availability depends on your plan">
    Copilot model availability depends on your GitHub plan and organization
    policy. Interactive onboarding uses the live catalog for its model picker,
    while non-interactive onboarding selects an eligible model automatically. See
    GitHub's [supported models per Copilot plan](https://docs.github.com/en/copilot/reference/ai-models/supported-models#supported-ai-models-per-copilot-plan)
    for the current model list.
  </Accordion>

  <Accordion title="Live catalog refresh from the Copilot API">
    Once the device-login (or env-var) auth path has resolved a GitHub token,
    OpenClaw refreshes the model catalog on demand from `${baseUrl}/models`
    (the same endpoint VS Code Copilot uses) so the runtime tracks
    per-account entitlement and accurate context windows without manifest
    churn. The visible live catalog excludes models hidden from GitHub's picker
    or disabled by account policy. Automatic setup defaults additionally require
    streaming and tool-call support.
    Newly published Copilot models become visible without an OpenClaw upgrade,
    and context windows reflect the real per-model limits
    (e.g. 400k for the gpt-5.x series, 1M for the internal
    `claude-opus-*-1m` variants).

    The bundled static catalog stays as the visible fallback when discovery
    is disabled, the user has no GitHub auth profile, runtime authentication
    fails, or the `/models` HTTPS call errors. To opt out and rely entirely
    on the static manifest catalog (offline / air-gapped scenarios):

    ```json5
    {
      plugins: {
        entries: {
          "github-copilot": {
            config: { discovery: { enabled: false } },
          },
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="Transport selection">
    Claude model IDs use the Anthropic Messages transport automatically.
    Gemini models use the OpenAI Chat Completions transport; GPT and o-series
    models keep the OpenAI Responses transport. The bundled static catalog
    includes these transports and request compatibility settings, so Gemini
    keeps using Chat Completions when live discovery is disabled or unavailable.
  </Accordion>

  <Accordion title="Thinking levels">
    Use `/think xhigh` or `/think max` when the selected model exposes that
    level. Copilot's live catalog determines the supported efforts for your
    account, and OpenClaw preserves those efforts in Responses requests.
    When a Responses model starts its native effort range at `low`, `minimal`
    maps to `low` instead of sending an unsupported value.
    Explicit live limits take precedence over the bundled catalog. Gemini's
    Chat Completions transport does not expose `max`.
    See [Thinking levels](/tools/thinking) for session and per-message controls.
  </Accordion>

  <Accordion title="Request compatibility">
    OpenClaw sends Copilot-compatible request headers with a Copilot CLI request
    identity, marks tool-result follow-up turns as agent-initiated, and sets the
    Copilot vision header when a turn carries image input.
  </Accordion>

  <Accordion title="Environment variable resolution order">
    OpenClaw resolves Copilot auth from environment variables in the following
    priority order:

    | Priority | Variable              | Notes                            |
    | -------- | --------------------- | -------------------------------- |
    | 1        | `COPILOT_GITHUB_TOKEN` | Highest priority, Copilot-specific |
    | 2        | `GH_TOKEN`            | GitHub CLI token (fallback)      |
    | 3        | `GITHUB_TOKEN`        | Standard GitHub token (lowest)   |

    When multiple variables are set, OpenClaw uses the highest-priority one.
    The device-login flow (`openclaw models auth login-github-copilot`) stores
    its token in the auth profile store and takes precedence over all environment
    variables.

  </Accordion>

  <Accordion title="Token storage">
    The login stores a GitHub token in the auth profile store (profile id
    `github-copilot:github`). At runtime, OpenClaw validates Copilot access,
    resolves the account-specific API endpoint, and uses the stored GitHub token
    for Copilot requests. You do not need to manage runtime authentication
    manually.

    Usage checks also use the selected profile's GitHub token. For OAuth profiles
    that carry a tenant domain, usage follows that domain before the provider's
    configured domain. `COPILOT_GITHUB_DOMAIN` still takes precedence.

  </Accordion>
</AccordionGroup>

## Memory search embeddings

GitHub Copilot can also serve as an embedding provider for
[memory search](/concepts/memory-search). If you have a Copilot subscription and
have logged in, OpenClaw can use it for embeddings without a separate API key.

### Config

Set `memory.search.provider` explicitly to use GitHub Copilot embeddings. If a
GitHub token is available, OpenClaw discovers available embedding models from
the Copilot API and picks the best one automatically.

```json5
{
  memory: {
    search: {
      provider: "github-copilot",
      // Optional: override the auto-discovered model
      model: "text-embedding-3-small",
    },
  },
}
```

### How it works

1. OpenClaw resolves your GitHub token (from env vars or auth profile).
2. Validates Copilot access and resolves the account-specific API endpoint.
3. Queries the Copilot `/models` endpoint to discover available embedding models,
   with a 10-second deadline that includes reading the response body.
4. Picks the best model (preference order: `text-embedding-3-small`,
   `text-embedding-3-large`, `text-embedding-ada-002`).
5. Sends embedding requests to the Copilot `/embeddings` endpoint.

Model availability depends on your GitHub plan. If discovery fails or no
embedding models are available, OpenClaw uses `memory.search.fallback` only
when you explicitly configure another provider. Otherwise, setup reports the
error instead of silently selecting a different provider.

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="OAuth and auth" href="/gateway/authentication" icon="key">
    Auth details and credential reuse rules.
  </Card>
</CardGroup>
