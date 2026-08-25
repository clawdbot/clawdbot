# Privacy Configuration

OpenClaw provides opt-in privacy controls that limit what data leaves
your machine in LLM inference payloads. All privacy features are
**disabled by default**.

## Quick start

Add to your `openclaw.yml`:

```yaml
privacy:
  enabled: true
```

This enables PII redaction in system prompts and tool outputs. User
message redaction is off by default to avoid corrupting developer input.

## Configuration reference

```yaml
privacy:
  enabled: true # Master switch (default: false)

  pii:
    enabled: true # Defaults to true when privacy.enabled=true
    systemPrompt: true # Redact PII in system prompt context files
    userMessages: false # Redact PII in user input (off by default)
    toolOutputs: true # Redact PII in tool call outputs
    categories:
      email: { redact: true, placeholder: "[EMAIL]" }
      phone: { redact: true, placeholder: "[PHONE]" }
      ssn: { redact: true, placeholder: "[SSN]" }
      creditCard: { redact: true, placeholder: "[CARD]" }
      ipv4: { redact: false } # Disable IPv4 redaction
      uuid: { redact: false } # Disable UUID redaction

  media:
    blockAttachments: false # Drop image/audio/video before LLM
    warnOnBlock: true # Log when attachments are dropped

  systemPrompt:
    maskHostname: false # Strip host= from Runtime line
    maskRepoPath: false # Replace repo path with basename
    maskOs: false # Strip OS name/version
    maskShell: false # Strip shell field
    suppressContextFiles: false # Skip workspace context file injection
```

## What gets redacted

| Category    | Pattern                               | Default placeholder |
| ----------- | ------------------------------------- | ------------------- |
| SSN         | `123-45-6789`                         | `[SSN]`             |
| Credit card | Visa/MC/Amex/Discover/JCB             | `[CARD]`            |
| Email       | `user@example.com`                    | `[EMAIL]`           |
| Phone       | US formats with optional country code | `[PHONE]`           |
| IPv4        | `192.168.1.1` (not followed by `/`)   | `[IPv4]`            |
| UUID        | v1-v5 UUIDs                           | `[UUID]`            |

## Session encryption

AES-256-GCM session transcript encryption is available as a
programmatic API (`encryptSessionFile` / `encryptSessionDirectory`)
but is not yet exposed as a config-driven feature. A future
`openclaw session encrypt` command will provide the enablement path.
