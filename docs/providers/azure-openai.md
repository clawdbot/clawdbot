# Azure OpenAI Provider

Configure Moltbot to use Azure OpenAI Service as a model provider.

## Overview

Azure OpenAI exposes OpenAI models deployed in your Azure subscription (for example `gpt-5` or `gpt-5-codex`) behind Azure endpoints and authentication.

## Prerequisites

1. An Azure subscription
2. An Azure OpenAI resource created in Azure Portal
3. At least one model deployment (e.g., `gpt-5` or `gpt-5-codex`)
4. API key from the Azure OpenAI resource

## Configuration

### Environment Variables

Set the following environment variables to configure Azure OpenAI:

| Variable | Required | Description |
|----------|----------|-------------|
| `AZURE_OPENAI_API_KEY` | Yes | Your Azure OpenAI API key |
| `AZURE_OPENAI_RESOURCE_NAME` | Yes* | Azure OpenAI resource name (e.g., `my-openai-resource`) |
| `AZURE_OPENAI_DEPLOYMENT_NAME` | Yes | Model deployment name (e.g., `gpt-5`) |
| `AZURE_OPENAI_API_VERSION` | No | API version (defaults to `2024-08-01-preview`) |
| `AZURE_OPENAI_ENDPOINT` | No | Full endpoint URL (alternative to resource name) |

\* Either `AZURE_OPENAI_RESOURCE_NAME` or `AZURE_OPENAI_ENDPOINT` is required.

### Example .env Configuration

```bash
# Azure OpenAI Configuration
AZURE_OPENAI_API_KEY=your_azure_openai_api_key_here
AZURE_OPENAI_RESOURCE_NAME=my-openai-resource
AZURE_OPENAI_DEPLOYMENT_NAME=gpt-5
AZURE_OPENAI_API_VERSION=2024-08-01-preview

# Alternative: provide full endpoint URL
# AZURE_OPENAI_ENDPOINT=https://my-openai-resource.openai.azure.com
```

## Docker Deployment

A dedicated Docker Compose file (`docker-compose.azure.yml`) is provided for Azure OpenAI deployments.

### Quick Start

1. Copy `.env.example` to `.env` and fill in your Azure OpenAI credentials:

```bash
cp .env.example .env
# Edit .env with your Azure OpenAI configuration
```

2. Build the Docker image:

```bash
docker compose -f docker-compose.azure.yml build
```

3. Run the gateway:

```bash
docker compose -f docker-compose.azure.yml up -d moltbot-azure-gateway
```

4. Or run the CLI interactively:

```bash
docker compose -f docker-compose.azure.yml run --rm moltbot-azure-cli
```

### Services

The `docker-compose.azure.yml` includes a gateway service, an interactive CLI service, and an optional test profile.

### Testing Connection

Verify your Azure OpenAI connection:

```bash
docker compose -f docker-compose.azure.yml --profile test run --rm moltbot-azure-test
```

## API Endpoint Format

Azure OpenAI uses a different URL format than OpenAI:

```
https://{resourceName}.openai.azure.com/openai/deployments/{deploymentName}/chat/completions?api-version={apiVersion}
```

The provider automatically handles:
- Building the correct endpoint URL from resource and deployment names
- Adding the `api-version` query parameter via a global fetch wrapper
- Using the `api-key` header instead of Bearer token authentication

## Supported Models

Moltbot treats Azure deployments as model IDs. Use your deployment name as `AZURE_OPENAI_DEPLOYMENT_NAME`.

Recommended (newer) deployment names to use in docs/examples:

- `gpt-5`
- `gpt-5-mini`
- `gpt-5-nano`
- `gpt-5-codex`

## Troubleshooting

### Common Issues

**401 Unauthorized**
- Verify your `AZURE_OPENAI_API_KEY` is correct
- Check that the API key has access to the specified deployment

**404 Not Found**
- Verify `AZURE_OPENAI_RESOURCE_NAME` matches your Azure resource
- Verify `AZURE_OPENAI_DEPLOYMENT_NAME` matches an existing deployment
- Check that the deployment is in a "Succeeded" state in Azure Portal

**API Version Errors**
- Try updating `AZURE_OPENAI_API_VERSION` to a supported version
- Check [Azure OpenAI API versions](https://learn.microsoft.com/en-us/azure/ai-services/openai/reference) for the latest

### Verifying Configuration

List available models to verify your configuration:

```bash
moltbot models list
```

The Azure OpenAI deployment should appear as `azure-openai/{deployment-name}`.

## Security Considerations

- Store API keys securely using environment variables or a secrets manager
- Consider using Azure Managed Identity for production deployments
- Review Azure OpenAI content filtering policies for your use case
- Ensure your Azure resource has appropriate network access controls

## Related Documentation

- [Azure OpenAI Service Documentation](https://learn.microsoft.com/en-us/azure/ai-services/openai/)
- [Azure OpenAI API Reference](https://learn.microsoft.com/en-us/azure/ai-services/openai/reference)
- [Moltbot Configuration](/configuration)
