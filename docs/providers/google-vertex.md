---
summary: "Google Vertex AI setup (ADC auth with gcloud user credentials or a service account key)"
title: "Google (Vertex AI)"
read_when:
  - You want to use Gemini models through Google Cloud Vertex AI
  - You have a GCP project and want to authenticate with Application Default Credentials
  - You are running OpenClaw on a GCE VM or GKE
---

The `google-vertex` provider routes Gemini model requests through Google Cloud
Vertex AI. It is part of the bundled Google plugin, alongside the `google`
(AI Studio) and `google-gemini-cli` providers. This guide covers the
Application Default Credentials (ADC) setup path.

- Provider: `google-vertex`
- Auth: Application Default Credentials from a credentials file (gcloud user ADC or a service account key)
- Required env vars: `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`
- Models: Gemini models accessed with the `google-vertex/` prefix

<Note>
  Vertex AI does not have an onboarding wizard, but you can configure it
  manually using the steps below. A wizard flow exists only for the separate
  [Google (Gemini)](/providers/google) provider, which uses the Gemini API
  rather than Vertex AI.
</Note>

## Getting started

Vertex AI uses ADC, which needs a credentials **file** on disk plus a project and
location. Follow the steps below to authenticate with Google Cloud, configure your
project and model, and confirm Gemini responds through Vertex AI.

<Steps>
  <Step title="Select your Google Cloud project">
    Set your active project so the commands below create resources in the
    correct project. Use this same project ID for `GOOGLE_CLOUD_PROJECT` later.

    ```bash
    gcloud config set project your-project-id
    ```

  </Step>
  <Step title="Authenticate with ADC">
    Choose the authentication source for your environment: **gcloud CLI** (your own
    Google account, simplest to set up) or a **service account key** (a dedicated
    identity, best for an always-on gateway host).

    <Tabs>
      <Tab title="gcloud CLI">
        Log in with Application Default Credentials:

        ```bash
        gcloud auth application-default login
        ```

        Once you complete the authentication flow, gcloud writes the ADC file to
        disk, which OpenClaw detects automatically.
      </Tab>

      <Tab title="Service account key">
        Create a service account with the **Vertex AI User** role
        (`roles/aiplatform.user`) and download a JSON key file:

        ```bash
        gcloud iam service-accounts create openclaw-vertex \
          --display-name="OpenClaw Vertex AI"

        gcloud projects add-iam-policy-binding your-project-id \
          --member="serviceAccount:openclaw-vertex@your-project-id.iam.gserviceaccount.com" \
          --role="roles/aiplatform.user"

        gcloud iam service-accounts keys create /path/to/openclaw-vertex-key.json \
          --iam-account="openclaw-vertex@your-project-id.iam.gserviceaccount.com"
        ```

        You will set `GOOGLE_APPLICATION_CREDENTIALS` in `~/.openclaw/.env` below.
      </Tab>
    </Tabs>

  </Step>
  <Step title="Enable the Vertex AI API">
    ```bash
    gcloud services enable aiplatform.googleapis.com
    ```
  </Step>
  <Step title="Set your default model">
    Set your agent's default model in `openclaw.json`:

    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "google-vertex/gemini-3.5-flash" },
        },
      },
    }
    ```

  </Step>
  <Step title="Set your environment variables">
    Set the required environment variables in `~/.openclaw/.env`:

    ```bash
    GOOGLE_CLOUD_PROJECT=your-project-id
    GOOGLE_CLOUD_LOCATION=global

    # If using a service account: uncomment and set the absolute key path
    # GOOGLE_APPLICATION_CREDENTIALS=/path/to/openclaw-vertex-key.json
    ```

  </Step>
  <Step title="Verify authentication">
    Confirm OpenClaw resolves your Vertex AI credentials:

    ```bash
    openclaw models status
    ```

    If everything is configured correctly, `google-vertex` shows as the default
    with resolved credentials (`source=gcloud adc`).

    If the credentials file is missing or the project or location is unset, it is
    flagged under Model route issues as `[indeterminate]` ("auth readiness could
    not be confirmed").

  </Step>
  <Step title="Provision the gateway">
    Running the agent requires a configured gateway. If you have not run
    `openclaw onboard` on this host, run it once to provision gateway auth.
    Passing `--auth-choice skip` sets up the gateway without changing your Vertex
    AI config:

    ```bash
    openclaw onboard --auth-choice skip
    ```

    Onboarding ends by opening your agent (in the terminal, or the Control UI in a
    browser). Send it a message to confirm Vertex AI responds end to end.

  </Step>
  <Step title="Use your agent">
    Chat with your agent anytime from the terminal:

    ```bash
    openclaw tui
    ```

    You can also use the Control UI in a browser or any connected messaging
    channel.

  </Step>
</Steps>

## Configuration

Set your default model in `openclaw.json` and your environment variables in
`~/.openclaw/.env`. The Google plugin ships a bundled Vertex AI model catalog, so
you do not need to declare `models.providers`, and you do not set an API key for
the ADC path.

<Note>
  Variables exported only in an interactive shell are not visible to a
  launchd/systemd Gateway daemon unless that environment is explicitly
  imported. Set them in the service environment, `~/.openclaw/.env`, or via
  `env.shellEnv`, in that order of precedence, then restart the gateway. See
  [Environment variables](/help/environment) for the full precedence order.
</Note>

## Environment variables

| Variable                         | Required    | Description                                                                                                       |
| :------------------------------- | :---------- | :---------------------------------------------------------------------------------------------------------------- |
| `GOOGLE_CLOUD_PROJECT`           | Yes         | GCP project ID. `GCLOUD_PROJECT` is also accepted.                                                                |
| `GOOGLE_CLOUD_LOCATION`          | Yes         | Vertex AI endpoint location: `global`, a multi-region (`us`, `eu`), or a region such as `us-central1`.            |
| `GOOGLE_APPLICATION_CREDENTIALS` | Conditional | Absolute path to a service-account key. Not needed for gcloud user ADC.                                           |
| `GOOGLE_CLOUD_QUOTA_PROJECT`     | No          | Billing/quota project sent as the `x-goog-user-project` header. Takes precedence over the ADC `quota_project_id`. |
| `CLOUDSDK_CONFIG`                | No          | Cloud SDK config directory. When set, it is the exclusive ADC directory override.                                 |

## Available models

Use the `google-vertex/` prefix when selecting a model:

| Model                  | ID                                     |
| :--------------------- | :------------------------------------- |
| Gemini 3.7 Flash       | `google-vertex/gemini-3.7-flash`       |
| Gemini 3.6 Flash       | `google-vertex/gemini-3.6-flash`       |
| Gemini 3.5 Flash       | `google-vertex/gemini-3.5-flash`       |
| Gemini 3.5 Flash-Lite  | `google-vertex/gemini-3.5-flash-lite`  |
| Gemini 3.1 Pro Preview | `google-vertex/gemini-3.1-pro-preview` |
| Gemini 3.1 Flash Lite  | `google-vertex/gemini-3.1-flash-lite`  |
| Gemini 3 Flash Preview | `google-vertex/gemini-3-flash-preview` |
| Gemini 2.5 Pro         | `google-vertex/gemini-2.5-pro`         |
| Gemini 2.5 Flash       | `google-vertex/gemini-2.5-flash`       |
| Gemini 2.5 Flash-Lite  | `google-vertex/gemini-2.5-flash-lite`  |

Run `openclaw models list --provider google-vertex` to see the bundled catalog.

## Troubleshooting

<AccordionGroup>
  <Accordion title="No API key found for provider google-vertex">
    OpenClaw could not resolve Vertex AI credentials. Confirm all three are present:

    1. A credentials file exists (`gcloud auth application-default login` was run,
       or `GOOGLE_APPLICATION_CREDENTIALS` points to a valid JSON key file).
    2. `GOOGLE_CLOUD_PROJECT` (or `GCLOUD_PROJECT`) is set.
    3. `GOOGLE_CLOUD_LOCATION` is set.

    On GCE or GKE using only the metadata server, no credentials file exists, so
    this error is expected until you create one with `gcloud auth
    application-default login` or a service account key.

  </Accordion>

  <Accordion title="Vertex AI requires a location">
    `GOOGLE_CLOUD_LOCATION` is not set. Add it to `~/.openclaw/.env` and restart
    the gateway.

  </Accordion>

  <Accordion title="403 or PERMISSION_DENIED">
    The service account or user lacks the required IAM role. Grant the **Vertex AI
    User** role (`roles/aiplatform.user`) to the account making requests. On GCE,
    also verify the VM has the **Cloud Platform** access scope.

  </Accordion>

  <Accordion title="404 or Model not found">
    Some model aliases are only available on the `global` endpoint. If you set a
    specific region and hit a 404, set `GOOGLE_CLOUD_LOCATION=global` in
    `~/.openclaw/.env`.

  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Google (Gemini)" href="/providers/google" icon="google">
    Gemini models via an API key from Google AI Studio.
  </Card>
  <Card title="Model providers" href="/concepts/model-providers" icon="layer-group">
    Provider configuration reference.
  </Card>
</CardGroup>
