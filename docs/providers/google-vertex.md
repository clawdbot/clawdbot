---
summary: "Google Vertex AI / Agent Platform setup (ADC auth for GCE, GKE, gcloud CLI, service accounts)"
title: "Google Vertex AI"
read_when:
  - You want to use Gemini models through Google Cloud Vertex AI (Agent Platform)
  - You have a GCP project and want to use ADC for authentication
  - You are running OpenClaw on a GCE VM, GKE, or Cloud Run
---

The `google-vertex` provider routes Gemini model requests through Google Cloud's
Vertex AI (now Gemini Enterprise Agent Platform) using Application Default
Credentials (ADC).

- Provider: `google-vertex`
- Auth: Application Default Credentials (metadata server, gcloud CLI, service account key)
- Env vars: `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` (optional, defaults to `global`)
- Models: Gemini models accessed via `google-vertex/*` prefix

## Getting started

Choose the setup that matches your environment.

<Tabs>
  <Tab title="GCE / GKE / Cloud Run">
    **Best for:** running OpenClaw on Google Cloud infrastructure where the
    metadata server provides credentials automatically.

    <Steps>
      <Step title="Run onboarding">
        ```bash
        openclaw onboard --auth-choice google-vertex-adc
        ```

        The wizard auto-detects your GCP project from the metadata server. Confirm
        or change the detected project and location (defaults to `global`).
      </Step>
      <Step title="Enable the Vertex AI API">
        ```bash
        gcloud services enable aiplatform.googleapis.com
        ```
      </Step>
      <Step title="Verify">
        ```bash
        openclaw models list --provider google-vertex
        ```
      </Step>
    </Steps>

    <Tip>
      On GCE, make sure your VM has the **Cloud Platform** access scope enabled.
      You can check with:
      ```bash
      curl -s -H "Metadata-Flavor: Google" \
        http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/scopes
      ```
      Look for `https://www.googleapis.com/auth/cloud-platform` in the output.
    </Tip>

  </Tab>

  <Tab title="gcloud CLI">
    **Best for:** laptops or workstations with the `gcloud` CLI installed.

    <Steps>
      <Step title="Log in with ADC">
        ```bash
        gcloud auth application-default login
        ```
      </Step>
      <Step title="Run onboarding">
        ```bash
        openclaw onboard --auth-choice google-vertex-adc
        ```

        Enter your GCP project ID when prompted. Location defaults to `global`.
      </Step>
      <Step title="Enable the Vertex AI API">
        ```bash
        gcloud services enable aiplatform.googleapis.com
        ```
      </Step>
      <Step title="Verify">
        ```bash
        openclaw models list --provider google-vertex
        ```
      </Step>
    </Steps>

  </Tab>

  <Tab title="Service account key">
    **Best for:** CI/CD pipelines, VMs on other cloud providers, or environments
    without `gcloud`.

    <Steps>
      <Step title="Create a service account">
        In the Google Cloud Console, create a service account and grant it the
        **Vertex AI User** role (`roles/aiplatform.user`). Download the private
        key as a JSON file.
      </Step>
      <Step title="Set the credentials path">
        ```bash
        export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account-key.json"
        ```
      </Step>
      <Step title="Run onboarding">
        ```bash
        openclaw onboard --auth-choice google-vertex-adc
        ```
      </Step>
      <Step title="Enable the Vertex AI API">
        ```bash
        gcloud services enable aiplatform.googleapis.com
        ```
      </Step>
      <Step title="Verify">
        ```bash
        openclaw models list --provider google-vertex
        ```
      </Step>
    </Steps>

  </Tab>
</Tabs>

## Configuration

After onboarding, your `openclaw.json` will include:

```json5
{
  agents: {
    defaults: {
      model: { primary: "google-vertex/gemini-3.5-flash" },
    },
  },
  models: {
    providers: {
      "google-vertex": {
        models: [{ id: "gemini-3.5-flash", name: "Gemini 3.5 Flash" }],
      },
    },
  },
  env: {
    vars: {
      GOOGLE_CLOUD_PROJECT: "your-project-id",
      GOOGLE_CLOUD_LOCATION: "global",
    },
  },
}
```

## Environment variables

| Variable                         | Required                                         | Default  | Description                                    |
| :------------------------------- | :----------------------------------------------- | :------- | :--------------------------------------------- |
| `GOOGLE_CLOUD_PROJECT`           | Yes (auto-detected during onboarding on GCE/GKE) | None     | GCP project ID                                 |
| `GOOGLE_CLOUD_LOCATION`          | No                                               | `global` | Vertex AI endpoint region                      |
| `GOOGLE_APPLICATION_CREDENTIALS` | No                                               | None     | Path to service account key file               |
| `GOOGLE_CLOUD_API_KEY`           | No                                               | None     | Vertex AI Express API key (alternative to ADC) |

<Note>
  Environment variables can be set in your shell, in `openclaw.json` under the
  `env.vars` key, or in `~/.openclaw/.env`. When running the Gateway as a systemd
  service, use the `env.vars` key in `openclaw.json` since shell exports do not reach
  the service process.
</Note>

## Available models

Use the `google-vertex/` prefix with any Gemini model available on Vertex AI.
Onboarding sets `gemini-3.5-flash` as the default model.

| Model                 | ID                                    |
| :-------------------- | :------------------------------------ |
| Gemini 3.5 Flash      | `google-vertex/gemini-3.5-flash`      |
| Gemini 3.6 Flash      | `google-vertex/gemini-3.6-flash`      |
| Gemini 3.5 Flash-Lite | `google-vertex/gemini-3.5-flash-lite` |
| Gemini 3.1 Pro        | `google-vertex/gemini-3.1-pro`        |

## Troubleshooting

<AccordionGroup>
  <Accordion title="No API key found for provider google-vertex">
    This error should not appear if you completed onboarding with the Google Vertex AI
    provider. If it does, try running `openclaw onboard --auth-choice google-vertex-adc`
    again. For manual configurations, check:

    1. `GOOGLE_CLOUD_PROJECT` is set (in env or `openclaw.json` `env.vars` section).
    2. On GCE/GKE: the metadata server is reachable.
    3. With gcloud CLI: you have run `gcloud auth application-default login`.
    4. With a service account: `GOOGLE_APPLICATION_CREDENTIALS` points to a valid JSON key file.

  </Accordion>

  <Accordion title="Vertex AI requires a project ID">
    Set `GOOGLE_CLOUD_PROJECT` in the `env.vars` section of `openclaw.json`:

    ```json5
    { env: { vars: { GOOGLE_CLOUD_PROJECT: "your-project-id" } } }
    ```

    Then restart the gateway: `openclaw gateway restart` or
    `systemctl --user restart openclaw-gateway`.

  </Accordion>

  <Accordion title="403 / PERMISSION_DENIED">
    The service account or user does not have the required IAM role. Grant the
    **Vertex AI User** role (`roles/aiplatform.user`) to the account making
    requests.

    On GCE, also verify that the VM has the **Cloud Platform** access scope.

  </Accordion>

  <Accordion title="404 / Model not found">
    Some model aliases are only available on the `global` endpoint. If you set a
    specific region (e.g. `us-central1`), try switching to `global`:

    ```json5
    { env: { vars: { GOOGLE_CLOUD_LOCATION: "global" } } }
    ```

  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Google (Gemini)" href="/providers/google" icon="google">
    Gemini models via API key in Google AI Studio.
  </Card>
  <Card title="Model providers" href="/concepts/model-providers" icon="layer-group">
    Provider configuration reference.
  </Card>
</CardGroup>
