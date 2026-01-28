# Changelog

## 2026.1.27-beta.1

### Changes
- Version alignment with core Moltbot release numbers.

## 2026.1.23

### Features

- Initial Twitch plugin release
- Twitch chat integration via @twurple (IRC connection)
- Multi-account support with per-channel configuration
- Access control via user ID allowlists and role-based restrictions
- Automatic token refresh with RefreshingAuthProvider
- Environment variable fallback for default account token
- Message actions support
- Status monitoring and probing
- Outbound message delivery with markdown stripping

### Improvements

- Added proper configuration schema with Zod validation
- Added plugin descriptor (moltbot.plugin.json)
- Added comprehensive README and documentation
