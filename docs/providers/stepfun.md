---
summary: "Use StepFun models with OpenClaw"
read_when:
  - You want StepFun models in OpenClaw
  - You need StepFun setup guidance
title: "StepFun"
---

StepFun ships as an external official plugin (`@openclaw/stepfun-provider`) with two provider ids:

- `stepfun` for the standard endpoint
- `stepfun-plan` for the Step Plan endpoint

<Warning>
Standard and Step Plan are **separate providers** with different endpoints and model ref prefixes (`stepfun/...` vs `stepfun-plan/...`). Use a China key with the `.com` endpoints and a global key with the `.ai` endpoints.
</Warning>

## Install plugin

```bash
openclaw plugins install @openclaw/stepfun-provider
openclaw gateway restart
```

## Region and endpoint overview

| Endpoint  | China (`.com`)                         | Global (`.ai`)                        |
| --------- | -------------------------------------- | ------------------------------------- |
| Standard  | `https://api.stepfun.com/v1`           | `https://api.stepfun.ai/v1`           |
| Step Plan | `https://api.stepfun.com/step_plan/v1` | `https://api.stepfun.ai/step_plan/v1` |

Auth env var: `STEPFUN_API_KEY`

## Built-in catalog

Standard (`stepfun`):

| Model ref                | Context | Max output | Notes                          |
| ------------------------ | ------- | ---------- | ------------------------------ |
| `stepfun/step-3.5-flash` | 262,144 | 65,536     | Default standard model         |
| `stepfun/step-3.7-flash` | 262,144 | 262,144    | Multimodal image input support |

Step Plan (`stepfun-plan`):

| Model ref                          | Context | Max output | Notes                          |
| ---------------------------------- | ------- | ---------- | ------------------------------ |
| `stepfun-plan/step-3.5-flash`      | 262,144 | 65,536     | Default Step Plan model        |
| `stepfun-plan/step-3.7-flash`      | 262,144 | 262,144    | Multimodal image input support |
| `stepfun-plan/step-3.5-flash-2603` | 262,144 | 65,536     | Additional Step Plan model     |

## Getting started

<Tabs>
  <Tab title="Standard">
    Best for general-purpose use via the standard StepFun endpoint.

    <Steps>
      <Step title="Choose your endpoint region">
        | Auth choice                    | Endpoint                     | Region        |
        | -------------------------------- | ----------------------------- | -------------- |
        | `stepfun-standard-api-key-intl` | `https://api.stepfun.ai/v1`  | International |
        | `stepfun-standard-api-key-cn`   | `https://api.stepfun.com/v1` | China          |
      </Step>
      <Step title="Run onboarding">
        ```bash
        openclaw onboard --auth-choice stepfun-standard-api-key-intl
        ```

        China endpoint:

        ```bash
        openclaw onboard --auth-choice stepfun-standard-api-key-cn
        ```
      </Step>
      <Step title="Non-interactive alternative">
        ```bash
        openclaw onboard --auth-choice stepfun-standard-api-key-intl \
          --stepfun-api-key "$STEPFUN_API_KEY"
        ```
      </Step>
      <Step title="Verify models are available">
        ```bash
        openclaw models list --provider stepfun
        ```
      </Step>
    </Steps>

    Default model: `stepfun/step-3.5-flash`
    Alternate model: `stepfun/step-3.7-flash`

  </Tab>

  <Tab title="Step Plan">
    Best for the Step Plan reasoning endpoint.

    <Steps>
      <Step title="Choose your endpoint region">
        | Auth choice                 | Endpoint                                | Region        |
        | ------------------------------ | ------------------------------------------ | -------------- |
        | `stepfun-plan-api-key-intl` | `https://api.stepfun.ai/step_plan/v1`  | International |
        | `stepfun-plan-api-key-cn`   | `https://api.stepfun.com/step_plan/v1` | China          |
      </Step>
      <Step title="Run onboarding">
        ```bash
        openclaw onboard --auth-choice stepfun-plan-api-key-intl
        ```

        China endpoint:

        ```bash
        openclaw onboard --auth-choice stepfun-plan-api-key-cn
        ```
      </Step>
      <Step title="Non-interactive alternative">
        ```bash
        openclaw onboard --auth-choice stepfun-plan-api-key-intl \
          --stepfun-api-key "$STEPFUN_API_KEY"
        ```
      </Step>
      <Step title="Verify models are available">
        ```bash
        openclaw models list --provider stepfun-plan
        ```
      </Step>
    </Steps>

    Default model: `stepfun-plan/step-3.5-flash`
    Alternate models: `stepfun-plan/step-3.7-flash`, `stepfun-plan/step-3.5-flash-2603`

  </Tab>
</Tabs>

A single auth flow writes region-matched profiles for both `stepfun` and `stepfun-plan`, so both surfaces are discovered together after one onboarding run.

## Advanced configuration

<AccordionGroup>
  <Accordion title="Full config: Standard provider">
    ```json5
    {
      env: { STEPFUN_API_KEY: "your-key" },
      agents: { defaults: { model: { primary: "stepfun/step-3.5-flash" } } },
      models: {
        mode: "merge",
        providers: {
          stepfun: {
            baseUrl: "https://api.stepfun.ai/v1",
            api: "openai-completions",
            apiKey: "${STEPFUN_API_KEY}",
            models: [
              {
                id: "step-3.7-flash",
                name: "Step 3.7 Flash",
                reasoning: true,
                input: ["text", "image"],
                thinkingLevelMap: { off: "low", minimal: "low", xhigh: "high", max: "high" },
                cost: { input: 0.2, output: 1.15, cacheRead: 0.04, cacheWrite: 0 },
                contextWindow: 262144,
                maxTokens: 262144,
              },
              {
                id: "step-3.5-flash",
                name: "Step 3.5 Flash",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 262144,
                maxTokens: 65536,
              },
            ],
          },
        },
      },
    }
    ```
  </Accordion>

  <Accordion title="Full config: Step Plan provider">
    ```json5
    {
      env: { STEPFUN_API_KEY: "your-key" },
      agents: { defaults: { model: { primary: "stepfun-plan/step-3.5-flash" } } },
      models: {
        mode: "merge",
        providers: {
          "stepfun-plan": {
            baseUrl: "https://api.stepfun.ai/step_plan/v1",
            api: "openai-completions",
            apiKey: "${STEPFUN_API_KEY}",
            models: [
              {
                id: "step-3.7-flash",
                name: "Step 3.7 Flash",
                reasoning: true,
                input: ["text", "image"],
                thinkingLevelMap: { off: "low", minimal: "low", xhigh: "high", max: "high" },
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 262144,
                maxTokens: 262144,
              },
              {
                id: "step-3.5-flash",
                name: "Step 3.5 Flash",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 262144,
                maxTokens: 65536,
              },
              {
                id: "step-3.5-flash-2603",
                name: "Step 3.5 Flash 2603",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 262144,
                maxTokens: 65536,
              },
            ],
          },
        },
      },
    }
    ```
  </Accordion>

  <Accordion title="Notes">
    - `step-3.7-flash` accepts text and image input through OpenClaw. StepFun's API also supports video, which is not yet a model input modality in OpenClaw.
    - Step 3.7 supports `low`, `medium`, and `high` reasoning effort. Because the model has no non-reasoning mode, `/think off` maps to `low`.
    - `step-3.5-flash-2603` is currently exposed only on `stepfun-plan`.
    - Use `openclaw models list` and `openclaw models set <provider/model>` to inspect or switch models.

  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Model providers" href="/concepts/model-providers" icon="layers">
    Overview of all providers, model refs, and failover behavior.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full config schema for providers, models, and plugins.
  </Card>
  <Card title="Models CLI" href="/concepts/models" icon="brain">
    How to choose and configure models.
  </Card>
  <Card title="StepFun Platform" href="https://platform.stepfun.com" icon="globe">
    StepFun API key management and documentation.
  </Card>
</CardGroup>
