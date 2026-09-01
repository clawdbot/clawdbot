# OpenClaw Amazon Bedrock Mantle Provider

Official OpenClaw provider plugin for routing Amazon Bedrock Mantle models through OpenAI-compatible provider flows.

Install from OpenClaw:

```bash
openclaw plugins install @openclaw/amazon-bedrock-mantle-provider
```

Use this plugin when your Bedrock deployment exposes Mantle-compatible model routing and you want OpenClaw agents to address those models through the Bedrock Mantle provider.

GPT-5.6 models resolved through Mantle's OpenAI Responses route opt into OpenClaw's shared Responses explicit caching: OpenClaw marks the stable system-prompt prefix as the cache boundary and leaves dynamic runtime additions uncached. Set the model's `cacheRetention` parameter to `none` to disable prompt-cache writes.

Mantle uses its provider-managed cache lifetime; `cacheRetention: "long"` does not send OpenAI's 24-hour retention field.

For GPT-5.6, a cache breakpoint needs at least 1,024 tokens. Amazon Bedrock keeps eligible cached prefixes available for at least 30 minutes and reports cache reads and writes in the Responses usage object. See [Prompt caching for faster model inference](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html).
