# SVG HTML Template

Copy this to a `.html` file and replace `<!-- SVG -->`.

```html
<!doctype html>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Diagram</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f8fafc;
    --fg: #172033;
    --muted: #5b6475;
    --line: #64748b;
    --neutral: #e2e8f0;
    --input: #bfdbfe;
    --process: #c7d2fe;
    --storage: #99f6e4;
    --external: #fde68a;
    --risk: #fecaca;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f172a;
      --fg: #e5e7eb;
      --muted: #a3adbd;
      --line: #94a3b8;
      --neutral: #334155;
      --input: #1d4ed8;
      --process: #4338ca;
      --storage: #0f766e;
      --external: #92400e;
      --risk: #991b1b;
    }
  }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font:
      14px/1.4 ui-sans-serif,
      system-ui,
      -apple-system,
      BlinkMacSystemFont,
      "Segoe UI",
      sans-serif;
  }
  main {
    max-width: 980px;
    margin: 32px auto;
    padding: 0 20px;
  }
  svg {
    width: 100%;
    height: auto;
    display: block;
  }
  .title {
    font-size: 20px;
    font-weight: 650;
    fill: var(--fg);
  }
  .label {
    font-size: 14px;
    font-weight: 600;
    fill: var(--fg);
  }
  .small {
    font-size: 12px;
    fill: var(--muted);
  }
  .node {
    stroke: var(--line);
    stroke-width: 1;
  }
  .neutral {
    fill: var(--neutral);
  }
  .input {
    fill: var(--input);
  }
  .process {
    fill: var(--process);
  }
  .storage {
    fill: var(--storage);
  }
  .external {
    fill: var(--external);
  }
  .risk {
    fill: var(--risk);
  }
  .edge {
    stroke: var(--line);
    stroke-width: 1.5;
    fill: none;
  }
  .zone {
    fill: none;
    stroke: var(--line);
    stroke-width: 1;
    stroke-dasharray: 6 5;
    opacity: 0.8;
  }
</style>
<main>
  <!-- SVG -->
</main>
```
