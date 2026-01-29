# Tooling Policy

To ensure consistency and reliability, agents and contributors should follow this tooling policy.

## Preferred Tools

### 1. Search & Exploration
- **Primary**: `ripgrep` (via `grep_search` or CLI).
- **Directory Listing**: `fd` or standard `ls`.
- **Outline**: `view_file_outline` for quick structural understanding.

### 2. File Editing
- **Primary**: `multi_replace_file_content` for non-contiguous edits.
- **Secondary**: `replace_file_content` for single blocks.
- **New Files**: `write_to_file`.

### 3. CI/CD & Build
- **Package Manager**: `pnpm`.
- **Runtime**: Node 22+ (Bun for local dev/testing).
- **Linter/Formatter**: Oxlint / Oxfmt.

## Agent Usage Guidelines

- **Conciseness**: Keep edits minimal and focused. Avoid broad refactors unless requested.
- **Verification**: Always run `pnpm lint` and `pnpm build` after making changes.
- **Safety**: Do not use `rm -rf` or other destructive commands without high confidence and explicit need.
- **Communication**: Use `notify_user` for blocking questions or artifact reviews.
