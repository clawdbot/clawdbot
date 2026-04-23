---
summary: "Cloudflare AI Gateway setup (auth + model selection)"
title: "Cloudflare AI gateway"
read_when:
  - You want to use Cloudflare AI Gateway with OpenClaw
  - You need the account ID, gateway ID, or API key env var
---

Cloudflare AI Gateway sits in front of provider APIs and lets you add analytics, caching, and controls. For Anthropic, OpenClaw uses the Anthropic Messages API through your Gateway endpoint.

| Property      | Value                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------- |
| Provider      | `cloudflare-ai-gateway`                                                                  |
| Base URL      | `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic`               |
| Default model | `cloudflare-ai-gateway/claude-sonnet-4-5`                                                |
| API key       | `CLOUDFLARE_AI_GATEWAY_API_KEY` (your provider API key for requests through the Gateway) |

<Note>
For Anthropic models routed through Cloudflare AI Gateway, use your **Anthropic API key** as the provider key.
</Note>

## Getting started

<Steps>
  <Step title="Set the provider API key and Gateway details">
    Run onboarding and choose the Cloudflare AI Gateway auth option:

    ```bash
    openclaw onboard --auth-choice cloudflare-ai-gateway-api-key
    ```

    This prompts for your account ID, gateway ID, and API key.

  </Step>
  <Step title="Set a default model">
    Add the model to your OpenClaw config:

    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "cloudflare-ai-gateway/claude-sonnet-4-5" },
        },
      },
    }
    ```

  </Step>
  <Step title="Verify the model is available">
    ```bash
    openclaw models list --provider cloudflare-ai-gateway
    ```
  </Step>
</Steps>

## Non-interactive example

For scripted or CI setups, pass all values on the command line:

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice cloudflare-ai-gateway-api-key \
  --cloudflare-ai-gateway-account-id "your-account-id" \
  --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
  --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY"
```

## Advanced configuration

<AccordionGroup>
  <Accordion title="Authenticated gateways">
    If you enabled Gateway authentication in Cloudflare, add the `cf-aig-authorization` header. This is **in addition to** your provider API key.

    ```json5
    {
      models: {
        providers: {
          "cloudflare-ai-gateway": {
            headers: {
              "cf-aig-authorization": "Bearer <cloudflare-ai-gateway-token>",
            },
          },
        },
      },
    }
    ```

    <Tip>
    The `cf-aig-authorization` header authenticates with the Cloudflare Gateway itself, while the provider API key (for example, your Anthropic key) authenticates with the upstream provider.
    </Tip>

  </Accordion>

  <Accordion title="Environment note">
    If the Gateway runs as a daemon (launchd/systemd), make sure `CLOUDFLARE_AI_GATEWAY_API_KEY` is available to that process.

    <Warning>
    A key sitting only in `~/.profile` will not help a launchd/systemd daemon unless that environment is imported there as well. Set the key in `~/.openclaw/.env` or via `env.shellEnv` to ensure the gateway process can read it.
    </Warning>

  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Troubleshooting" href="/help/troubleshooting" icon="wrench">
    General troubleshooting and FAQ.
  </Card>
</CardGroup>
