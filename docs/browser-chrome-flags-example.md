# Browser Chrome Flags Configuration

## Overview

You can add custom Chrome command-line flags to browser profiles via the `chromeFlags` configuration option. This is useful for:

- Bypassing automation detection when using browser extensions
- Enabling experimental Chrome features
- Adjusting performance or security settings
- Working around specific site compatibility issues

## Configuration

Add `chromeFlags` to any browser profile in your `moltbot.json`:

```json
{
  "browser": {
    "enabled": true,
    "profiles": {
      "stealth": {
        "chromeFlags": [
          "--disable-blink-features=AutomationControlled",
          "--disable-features=IsolateOrigins,site-per-process",
          "--disable-site-isolation-trials"
        ]
      }
    }
  }
}
```

## Common Use Cases

### 1. Stealth Mode (Bypass Automation Detection)

**Problem:** Some websites detect browser automation and block functionality or show CAPTCHAs.

**Solution:**
```json
{
  "browser": {
    "profiles": {
      "stealth": {
        "chromeFlags": [
          "--disable-blink-features=AutomationControlled",
          "--disable-features=IsolateOrigins,site-per-process",
          "--disable-site-isolation-trials"
        ]
      }
    }
  }
}
```

**Use with:** Sites that require browser extensions (password managers, auth extensions, web wallets)

### 2. Working with Browser Extensions

**Problem:** Browser extensions (password managers, SSO, etc.) may be blocked when Chrome detects automation.

**Solution:**
```json
{
  "browser": {
    "profiles": {
      "extensions": {
        "chromeFlags": [
          "--disable-blink-features=AutomationControlled"
        ]
      }
    }
  }
}
```

**Examples:**
- 1Password browser extension + automation
- Okta/Azure AD SSO extensions
- VPN browser extensions
- Development tools (React DevTools, Vue DevTools)

### 3. Performance Tuning

**Problem:** Chrome uses too much memory or CPU during automation.

**Solution:**
```json
{
  "browser": {
    "profiles": {
      "lightweight": {
        "chromeFlags": [
          "--disable-gpu",
          "--disable-software-rasterizer",
          "--disable-dev-shm-usage",
          "--disable-extensions"
        ]
      }
    }
  }
}
```

### 4. Development & Debugging

**Problem:** Need to enable Chrome flags for testing or development.

**Solution:**
```json
{
  "browser": {
    "profiles": {
      "dev": {
        "chromeFlags": [
          "--auto-open-devtools-for-tabs",
          "--enable-logging",
          "--v=1"
        ]
      }
    }
  }
}
```

## Security Considerations

⚠️ **Important:** Some Chrome flags reduce browser security protections.

**Flags that reduce security:**
- `--disable-blink-features=AutomationControlled` - Disables automation detection (makes browser more vulnerable to automated attacks)
- `--disable-features=IsolateOrigins,site-per-process` - Disables site isolation (reduces protection against malicious sites)
- `--disable-web-security` - **NEVER USE** - Completely disables web security
- `--no-sandbox` - **DANGEROUS** - Disables Chrome's security sandbox

**Best Practices:**
1. Only use flags you understand
2. Only enable stealth mode when necessary (e.g., when extensions are required)
3. Use separate profiles for sensitive work
4. Document why each flag is needed
5. Regularly review your configuration

## Complete Example

```json
{
  "browser": {
    "enabled": true,
    "defaultProfile": "normal",
    "profiles": {
      "normal": {
        "cdpPort": 9222,
        "color": "#FF4500"
      },
      "stealth": {
        "cdpPort": 9223,
        "color": "#00AA00",
        "chromeFlags": [
          "--disable-blink-features=AutomationControlled",
          "--disable-features=IsolateOrigins,site-per-process"
        ]
      },
      "dev": {
        "cdpPort": 9224,
        "color": "#0000FF",
        "chromeFlags": [
          "--auto-open-devtools-for-tabs",
          "--enable-logging"
        ]
      }
    }
  }
}
```

**Usage:**
```bash
# Use normal profile (default)
moltbot browser open https://example.com

# Use stealth profile for sites requiring extensions
moltbot browser open https://example.com --profile stealth

# Use dev profile for debugging
moltbot browser open https://example.com --profile dev
```

## Available Chrome Flags

Chrome supports hundreds of command-line flags. Here are some commonly useful ones:

### Automation & Detection
- `--disable-blink-features=AutomationControlled` - Hide automation detection
- `--disable-infobars` - Hide "Chrome is being controlled" banner

### Performance
- `--disable-gpu` - Disable GPU acceleration (useful in headless/containers)
- `--disable-dev-shm-usage` - Reduce shared memory usage (Linux containers)
- `--disk-cache-size=0` - Disable disk cache
- `--media-cache-size=0` - Disable media cache

### Features
- `--disable-features=Translate` - Disable Google Translate
- `--enable-features=NetworkService` - Enable network service
- `--disable-extensions` - Disable all extensions

### Debugging
- `--auto-open-devtools-for-tabs` - Auto-open DevTools
- `--enable-logging` - Enable Chrome logging
- `--v=1` - Verbose logging level

### Display
- `--window-size=1920,1080` - Set window size
- `--start-maximized` - Start maximized
- `--start-fullscreen` - Start in fullscreen

**Full list:** Run `chrome --help` or see [Chromium Command Line Switches](https://peter.sh/experiments/chromium-command-line-switches/)

## Troubleshooting

### Flags not working?
1. Check flag spelling (flags are case-sensitive)
2. Verify Chrome version supports the flag (some flags are version-specific)
3. Check logs for errors: `moltbot browser serve --verbose`
4. Try flags individually to isolate issues

### Chrome won't start?
1. Check for conflicting flags
2. Remove flags one by one to find the problematic one
3. Check Chrome version compatibility
4. Verify you're not using deprecated flags

### Still seeing "Chrome is being controlled"?
This is normal behavior. The `--disable-blink-features=AutomationControlled` flag prevents JavaScript detection, but the Chrome UI banner may still appear. Most sites only check JavaScript, so this is usually fine.

## Migration from Manual Chrome Launch

If you were previously launching Chrome manually with flags, you can now move them to the config:

**Before:**
```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --disable-blink-features=AutomationControlled \
  --user-data-dir="/path/to/profile"
```

**After:**
```json
{
  "browser": {
    "profiles": {
      "myprofile": {
        "chromeFlags": [
          "--disable-blink-features=AutomationControlled"
        ]
      }
    }
  }
}
```

Then use: `moltbot browser open --profile myprofile`

## Related Documentation

- [Browser Tool Documentation](https://docs.molt.bot/tools/browser)
- [Browser Configuration Reference](https://docs.molt.bot/gateway/configuration#browser)
- [Security Best Practices](https://docs.molt.bot/gateway/security)
