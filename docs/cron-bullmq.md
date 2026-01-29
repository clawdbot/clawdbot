# BullMQ Cron Backend

The cron system now uses BullMQ for job scheduling by default. This fixes:

- **Stalled jobs**: BullMQ has built-in stall detection (30s interval, fails after 2 stalls)
- **Jobs not running**: Redis-backed persistence survives process restarts
- **No logs**: BullMQ emits events for all job lifecycle stages

## Configuration

### Environment Variables

- `REDIS_URL`: Redis connection URL (default: `redis://localhost:6379`)
- `CLAWDBOT_CRON_BACKEND`: Set to `timer` to use the old setTimeout-based backend

### Config File

```yaml
cron:
  enabled: true
  redisUrl: redis://localhost:6379  # Optional, uses REDIS_URL env by default
  
  # Worker settings
  workerConcurrency: 3              # Parallel job processing (default: 3)
  
  # Retry settings
  jobRetryAttempts: 3               # Retry count on failure (default: 3)
  jobRetryDelayMs: 1000             # Base delay for exponential backoff (default: 1000)
  
  # Stall detection
  stalledIntervalMs: 30000          # Check interval in ms (default: 30000)
  maxStalledCount: 2                # Stalls before fail (default: 2)
  
  # Job retention
  completedJobsRetention: 100       # Keep last N completed (default: 100)
  failedJobsRetention: 500          # Keep last N failed (default: 500)
```

## How It Works

### Job Types

1. **Recurring jobs** (`kind: "every"` or `kind: "cron"`):
   - Uses BullMQ Job Schedulers with upsert pattern
   - Survives restarts, reschedules automatically
   - Scheduler key format: `cron:{jobId}`

2. **One-shot jobs** (`kind: "at"`):
   - Uses delayed jobs
   - Automatically disabled after successful run
   - Optional `deleteAfterRun` for auto-cleanup

### Queue Configuration (Defaults)

- **Queue name**: `moltbot-cron`
- **Concurrency**: 3 (configurable via `workerConcurrency`)
- **Retries**: 3 attempts with exponential backoff (configurable via `jobRetryAttempts`, `jobRetryDelayMs`)
- **Stall detection**: Every 30s, fails after 2 stalls (configurable via `stalledIntervalMs`, `maxStalledCount`)
- **Completed job retention**: Last 100 jobs (configurable via `completedJobsRetention`)
- **Failed job retention**: Last 500 jobs (configurable via `failedJobsRetention`)

## Monitoring

### Redis CLI

```bash
# Check queue status
redis-cli KEYS "bull:moltbot:cron:*"

# View job schedulers
redis-cli HGETALL "bull:moltbot:cron:repeat"

# Check waiting jobs
redis-cli LRANGE "bull:moltbot:cron:wait" 0 -1
```

### BullMQ Dashboard (optional)

You can use [Bull Board](https://github.com/felixmosh/bull-board) or similar tools to visualize the queue.

## Fallback

To revert to the old setTimeout-based backend:

```bash
export CLAWDBOT_CRON_BACKEND=timer
```

This is useful if Redis is unavailable, but you'll lose stall detection and restart resilience.

## Migration

Existing cron jobs are automatically synced to BullMQ on startup. The JSON store remains the source of truth for job definitions; BullMQ handles scheduling and execution.

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   JSON Store    │────▶│   BullMQ Queue  │────▶│    Worker       │
│  (job defs)     │     │  (scheduling)   │     │  (execution)    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                       │                       │
        │                       │ Redis                 │
        │                       ▼                       │
        │               ┌─────────────────┐             │
        │               │   Job Scheduler │             │
        │               │   (per job)     │             │
        │               └─────────────────┘             │
        │                                               │
        └───────────────────────────────────────────────┘
                        Sync on startup
```
