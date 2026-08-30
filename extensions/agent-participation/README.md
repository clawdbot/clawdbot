# Agent Participation

This optional plugin chooses one respondent when several accounts managed by the
same Gateway would otherwise answer an eligible channel message. Core owns
admission, access checks, explicit targeting, and dispatch; the plugin supplies
only the participation decision.

Enable the bundled plugin with the existing plugin switch, then restart the Gateway:

```sh
openclaw config set plugins.entries.agent-participation.enabled true
openclaw gateway restart
```

If `plugins.allow` is configured, include `agent-participation` in that allowlist.
The plugin is disabled by default and has no plugin-specific configuration options.

The classifier sees only the bounded current message and candidate account IDs,
agent IDs, and public names. It does not read conversation history, workspaces,
agent instructions, skills, tools, or private memory. Names do not establish
expertise: ambiguous requests and requests for several respondents preserve normal
activation. Explicit targeting, commands, and single-agent messages bypass the
classifier in core.

Each classified message adds one model round-trip before agent execution. The
plugin uses the existing completion API and its default model selection, with no
model override or guaranteed fast-model route. Normal model usage charges apply.
The request has a five-second abort signal. Invalid output, unavailable completion,
or timeout leaves core's ordinary activation behavior in place.

This plugin does not change agent runtimes, tools, streaming, or previews. It does
not hold, rewrite, or discard completed answers. Channel adapters must use the
shared participation admission contract before this policy applies.
