---
summary: "Migration guide for hierarchical memory structure (flat → YYYY/MM/)"
read_when:
  - Upgrading from older Moltbot versions
  - Understanding memory file format changes
---

# Memory Migration Guide

## Overview

Moltbot now uses a **hierarchical memory structure** for better scalability:

**Before (flat):**
```
memory/2025-01-27.md
memory/2025-01-26-conversation.md
...365+ files in one directory per year
```

**After (hierarchical):**
```
memory/2025/01/2025-01-27.md
memory/2025/01/2025-01-26-conversation.md
...max 31 files per directory
```

## Why This Change?

The flat structure worked well for small memory sets, but caused issues over time:

- **Filesystem performance**: 1000+ files in one directory slows down filesystem operations
- **Navigation difficulty**: Hard to find files manually
- **No natural segmentation**: Cannot easily archive by month/year

The hierarchical structure solves all these issues.

---

## Backward Compatibility

**Good news:** Moltbot automatically migrates old-format files.

### How It Works

When Moltbot encounters an old-format file (`memory/YYYY-MM-DD.md`):

1. **Detects** the old format
2. **Creates** the new directory structure (`memory/YYYY/MM/`)
3. **Copies** the file to the new location
4. **Logs** the migration
5. **Uses** the new file going forward

The old file is kept as a backup (not deleted automatically).

### What You Need to Do

**Nothing.** Migration is automatic and transparent.

When you:
- Search memory → old files are migrated automatically
- Read memory → migrated files are used
- Write memory → new format is used

---

## Migration Examples

### Example 1: Automatic Migration

You have a file at `memory/2025-01-27.md`.

When Moltbot reads memory:
```
[memory] Migrated old-format memory file: 2025-01-27.md -> memory/2025/01/2025-01-27.md
```

File is now at: `memory/2025/01/2025-01-27.md`

### Example 2: Slug Files

You have `memory/2025-01-27-discussion.md`.

Migration creates:
```
memory/2025/01/2025-01-27-discussion.md
```

### Example 3: Existing New-Format Files

If `memory/2025/01/2025-01-27.md` already exists:
- Migration skips the old file
- New file is kept (no overwrite)
- Warning logged

---

## Rolling Back

If you need to revert to the old format:

1. **Stop** Moltbot
2. **Delete** the `memory/YYYY/` directories
3. **Restore** from backup (if you kept one)
4. **Restart** Moltbot

**Note:** Old-format files are not deleted during migration, so you may have both formats present temporarily.

---

## Troubleshooting

### Migration Fails

If migration fails for a file:
- Check file permissions
- Ensure workspace directory is writable
- Check logs for specific error messages

### Files Not Found After Migration

If memory files seem missing:
- Check new location: `memory/YYYY/MM/`
- Old files still exist in `memory/` (backup)
- Memory search works across both formats

### Performance Issues After Migration

If you still see performance issues:
- Run `moltbot memory status` to check index
- Rebuild index: `moltbot memory index --force`
- Check disk space

---

## Timeline

| Version | Status |
|---------|--------|
| **Current** | Both formats supported, automatic migration |
| **Future +1** | Warning: old format deprecated |
| **Future +2** | Error: old format not supported |
| **Future +3** | Old format removed |

**Recommendation:** No immediate action needed. Migration is automatic.

---

## FAQ

**Q: Will my old memory files be deleted?**
A: No. Old files are kept as backup.

**Q: Do I need to update my scripts?**
A: No. Moltbot handles both formats transparently.

**Q: What if I have both formats?**
A: New format takes precedence. Old format is ignored if new exists.

**Q: Can I keep using the old format?**
A: Yes, for now. Old format will be deprecated in future versions.

**Q: How do I know if migration happened?**
A: Check logs for `[memory] Migrated old-format memory file` messages.

---

## See Also

- [Memory](/concepts/memory) - Memory system overview
- [`moltbot memory`](/cli/memory) - CLI commands for memory management
- [Agent Workspace](/concepts/agent-workspace) - Workspace structure
