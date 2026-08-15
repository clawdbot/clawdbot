# Excalidraw Patterns

Envelope:

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "openclaw/diagram-maker",
  "elements": [],
  "appState": { "viewBackgroundColor": "#ffffff" }
}
```

Labeled rounded rectangle:

```json
{
  "type": "rectangle",
  "id": "svc",
  "x": 100,
  "y": 100,
  "width": 180,
  "height": 72,
  "roundness": { "type": 3 },
  "backgroundColor": "#a5d8ff",
  "fillStyle": "solid",
  "strokeWidth": 2,
  "roughness": 1,
  "opacity": 100,
  "boundElements": [{ "id": "svc_text", "type": "text" }]
}
```

Bound text:

```json
{
  "type": "text",
  "id": "svc_text",
  "x": 112,
  "y": 124,
  "width": 156,
  "height": 24,
  "text": "API service",
  "originalText": "API service",
  "fontSize": 20,
  "fontFamily": 1,
  "strokeColor": "#1e1e1e",
  "textAlign": "center",
  "verticalAlign": "middle",
  "containerId": "svc",
  "autoResize": true
}
```

Bound arrow:

```json
{
  "type": "arrow",
  "id": "a1",
  "x": 280,
  "y": 136,
  "width": 140,
  "height": 0,
  "points": [
    [0, 0],
    [140, 0]
  ],
  "endArrowhead": "arrow",
  "startBinding": { "elementId": "svc", "fixedPoint": [1, 0.5] },
  "endBinding": { "elementId": "db", "fixedPoint": [0, 0.5] }
}
```

Palette:

- Primary/input: `#a5d8ff`
- Process: `#d0bfff`
- Success/output: `#b2f2bb`
- Storage/data: `#c3fae8`
- External/warning: `#ffd8a8`
- Error/risk: `#ffc9c9`
- Note/decision: `#fff3bf`
