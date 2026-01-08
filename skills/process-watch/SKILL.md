---
name: process-watch
description: Monitor system processes - CPU, memory, disk I/O, network, open files, ports. Find resource hogs, kill runaway processes, track what's consuming your machine.
metadata:
  clawdhub:
    emoji: "📊"
    requires:
      bins: ["python3"]
---

# Process Watch

Comprehensive system process monitoring. Goes beyond basic `top` to show:
- CPU & memory usage
- Disk I/O per process
- Network connections
- Open files & handles
- Port bindings
- Process trees

## Commands

### List processes
```bash
process-watch list [--sort cpu|mem|disk|name] [--limit 20]
```

### Top resource consumers
```bash
process-watch top [--type cpu|mem|disk|net] [--limit 10]
```

### Process details
```bash
process-watch info <pid>
# Shows: CPU, memory, open files, network connections, children, environment
```

### Find by name
```bash
process-watch find <name>
# e.g., process-watch find chrome
```

### Port bindings
```bash
process-watch ports [--port 3000]
# What's listening on which port?
```

### Network connections
```bash
process-watch net [--pid <pid>] [--established]
```

### Kill process
```bash
process-watch kill <pid> [--force]
process-watch kill --name "chrome" [--force]
```

### Watch mode
```bash
process-watch watch [--interval 2] [--alert-cpu 80] [--alert-mem 90]
# Continuous monitoring with threshold alerts
```

### System summary
```bash
process-watch summary
# Quick overview: load, memory, disk, top processes
```

## Examples

```bash
# What's eating my CPU?
process-watch top --type cpu

# What's on port 3000?
process-watch ports --port 3000

# Details on a specific process
process-watch info 1234

# Kill all Chrome processes
process-watch kill --name chrome

# Watch with alerts
process-watch watch --alert-cpu 90 --alert-mem 85
```

## Platform Support

- **macOS**: Full support
- **Linux**: Full support  
- **Windows**: Partial (basic process list, no lsof equivalent)
