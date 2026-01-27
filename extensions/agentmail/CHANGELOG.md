# Changelog

## 2026.1.26

### Features

- Initial AgentMail plugin release
- Email channel integration via AgentMail API
- Webhook-based inbound message handling
- Full thread context fetching for conversation history
- Sender allowFrom filtering (consistent with other channels)
- Attachment metadata in thread context
- Agent tool for fetching attachment download URLs on demand
- Interactive onboarding flow with inbox creation support
- Environment variable fallback for credentials (AGENTMAIL_TOKEN, AGENTMAIL_EMAIL_ADDRESS)

### Technical

- Uses AgentMail SDK v0.2.4
- Extracted text/HTML preference for cleaner message bodies
- Zod-based configuration schema
- Comprehensive test coverage for pure functions
