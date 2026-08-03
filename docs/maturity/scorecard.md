---
title: "Maturity scorecard"
summary: "OpenClaw release readiness scores for product areas, integrations, and supported workflows."
---

# Maturity scorecard

<div className="maturity-hero">
  <p className="maturity-kicker">release readiness - generated from taxonomy + QA evidence</p>
  <p className="maturity-hero-title">A practical view of what is ready, what is proven, and what still needs work.</p>
  <p>50 surfaces - 281 capability areas - deterministic coverage plus human-reviewed quality and completeness.</p>
  <p className="maturity-jump-links"><a href="#surface-explorer">Browse surfaces</a> / <a href="#qa-evidence-summary">Inspect QA evidence</a> / <a href="/maturity/taxonomy">Read the taxonomy</a></p>
</div>

## What this page is for

Use this page to answer one question: which OpenClaw surfaces are credible choices for a release, and what evidence supports that judgment? Coverage comes from deterministic QA evidence; quality and completeness are maintained as reviewed maturity scores.

## At a glance

<div className="maturity-summary-grid">
  <div className="maturity-summary-item maturity-score-alpha">
    <div className="maturity-summary-heading">
      <span className="maturity-summary-value">68%</span>
      <span>Maturity score</span>
    </div>
    <div className="maturity-summary-bar" style={{ "--score": "68" }}><span /></div>
    <div className="maturity-summary-meta">
      <span className="maturity-level-pill maturity-level-alpha">Alpha</span>
      <span>Quality + completeness</span>
      <span>Coverage Experimental - 4%</span>
      <span>Quality Alpha - 64%</span>
      <span>Completeness Beta - 71%</span>
    </div>
  </div>
</div>

Coverage is deliberately evidence-led: an area does not become "ready" just because the implementation exists. It is not an input to the maturity score, but OpenClaw aims to keep end-to-end coverage above 90% for mature Stable-or-better features over time.

## Score bands

<div className="maturity-band-list">
  <div className="maturity-band maturity-band-experimental"><span className="maturity-band-title"><span className="maturity-level-pill maturity-level-experimental">Experimental</span></span><span>0-50%</span></div>
  <div className="maturity-band maturity-band-alpha"><span className="maturity-band-title"><span className="maturity-level-pill maturity-level-alpha">Alpha</span></span><span>50-70%</span></div>
  <div className="maturity-band maturity-band-beta"><span className="maturity-band-title"><span className="maturity-level-pill maturity-level-beta">Beta</span></span><span>70-80%</span></div>
  <div className="maturity-band maturity-band-stable"><span className="maturity-band-title"><span className="maturity-level-pill maturity-level-stable">Stable</span></span><span>80-95%</span></div>
  <div className="maturity-band maturity-band-clawesome"><span className="maturity-band-title"><span className="maturity-level-pill maturity-level-clawesome">Clawesome</span></span><span>95-100%</span></div>
</div>

## Surface explorer

<a id="surface-explorer" />

Surfaces are ordered by maturity level, completeness, and quality. LTS support is shown alongside each row so release-ready options are easy to compare.

<Tabs>
  <Tab title="All surfaces">
    <div className="maturity-surface-table">
      <div className="maturity-surface-row maturity-surface-row-header"><span>Surface</span><span>Coverage</span><span>Quality</span><span>Completeness</span><span>Support</span></div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#cli"><span className="maturity-surface-title">CLI</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-stable"><span className="maturity-level-code">M4</span><span>Stable</span></span><span>7 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>4%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "4%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-stable"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-stable">Stable</span><span>83%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "83%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-stable"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-stable">Stable</span><span>90%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "90%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-partial">Partial - 6</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#gateway-runtime"><span className="maturity-surface-title">Gateway runtime</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-stable"><span className="maturity-level-code">M4</span><span>Stable</span></span><span>13 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>6%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "6%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-stable"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-stable">Stable</span><span>81%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "81%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-stable"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-stable">Stable</span><span>89%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "89%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-partial">Partial - 12</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#linux-gateway-host"><span className="maturity-surface-title">Linux Gateway host</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-stable"><span className="maturity-level-code">M4</span><span>Stable</span></span><span>5 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>75%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "75%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-stable"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-stable">Stable</span><span>89%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "89%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-partial">Partial - 4</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#macos-gateway-host"><span className="maturity-surface-title">macOS Gateway host</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-stable"><span className="maturity-level-code">M4</span><span>Stable</span></span><span>7 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>74%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "74%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-stable"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-stable">Stable</span><span>88%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "88%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#discord"><span className="maturity-surface-title">Discord</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-stable"><span className="maturity-level-code">M4</span><span>Stable</span></span><span>6 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>73%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "73%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-stable"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-stable">Stable</span><span>87%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "87%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-partial">Partial - 4</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#android-app"><span className="maturity-surface-title">Android app</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-stable"><span className="maturity-level-code">M4</span><span>Stable</span></span><span>7 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-stable"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-stable">Stable</span><span>80%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "80%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-stable"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-stable">Stable</span><span>80%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "80%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#ios-app"><span className="maturity-surface-title">iOS app</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-stable"><span className="maturity-level-code">M4</span><span>Stable</span></span><span>8 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-stable"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-stable">Stable</span><span>80%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "80%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-stable"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-stable">Stable</span><span>80%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "80%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#agent-runtime"><span className="maturity-surface-title">Agent Runtime</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>9 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>33%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "33%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>78%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "78%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>79%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "79%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-partial">Partial - 6</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#session-memory-and-context-engine"><span className="maturity-surface-title">Session, memory, and context engine</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>9 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>30%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "30%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>77%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "77%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>79%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "79%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-partial">Partial - 6</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#channel-framework"><span className="maturity-surface-title">Channel framework</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>8 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>13%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "13%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>76%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "76%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>79%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "79%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-partial">Partial - 5</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#browser-automation-exec-and-sandbox-tools"><span className="maturity-surface-title">Browser automation, exec, and sandbox tools</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>3 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>21%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "21%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>75%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "75%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>79%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "79%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-partial">Partial - 2</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#observability"><span className="maturity-surface-title">Observability</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>5 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>18%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "18%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>75%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "75%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>79%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "79%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-partial">Partial - 3</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#openai-and-codex-provider-path"><span className="maturity-surface-title">OpenAI and Codex provider path</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>5 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>26%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "26%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>74%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "74%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>79%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "79%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-partial">Partial - 3</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#gateway-web-app"><span className="maturity-surface-title">Gateway Web App</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>6 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>4%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "4%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>74%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "74%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>79%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "79%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#web-search-tools"><span className="maturity-surface-title">Web search tools</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>4 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>9%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "9%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>74%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "74%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>79%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "79%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#plugins"><span className="maturity-surface-title">Plugins</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>9 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>12%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "12%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>72%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "72%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>79%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "79%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-partial">Partial - 7</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#security-auth-pairing-and-secrets"><span className="maturity-surface-title">Security, auth, pairing, and secrets</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>6 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>16%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "16%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>72%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "72%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>79%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "79%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-partial">Partial - 5</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#automation-cron-hooks-tasks-polling"><span className="maturity-surface-title">Automation: cron, hooks, tasks, polling</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>6 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>2%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "2%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>72%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "72%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>79%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "79%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#docker-and-podman-hosting"><span className="maturity-surface-title">Docker and Podman hosting</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>4 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>7%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "7%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>71%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "71%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>79%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "79%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#windows-via-wsl2"><span className="maturity-surface-title">Windows via WSL2</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>6 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>6%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "6%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>69%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "69%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>79%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "79%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-partial">Partial - 5</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#raspberry-pi-and-small-linux-devices"><span className="maturity-surface-title">Raspberry Pi and small Linux devices</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>4 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>67%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "67%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>79%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "79%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#anthropic-provider-path"><span className="maturity-surface-title">Anthropic provider path</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>5 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>71%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "71%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>78%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "78%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#telegram"><span className="maturity-surface-title">Telegram</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>5 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>68%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "68%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>78%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "78%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-full">Full - 5</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#slack"><span className="maturity-surface-title">Slack</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>5 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>66%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "66%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>78%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "78%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-full">Full - 5</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#google-provider-path"><span className="maturity-surface-title">Google provider path</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>5 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>66%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "66%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>78%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "78%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#imessage-and-bluebubbles"><span className="maturity-surface-title">iMessage and BlueBubbles</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>5 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>66%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "66%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>78%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "78%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#macos-companion-app"><span className="maturity-surface-title">macOS companion app</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>8 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>66%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "66%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>78%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "78%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#openrouter-provider-path"><span className="maturity-surface-title">OpenRouter provider path</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>4 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>66%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "66%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>78%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "78%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#whatsapp"><span className="maturity-surface-title">WhatsApp</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>5 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>66%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "66%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>78%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "78%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#media-understanding-and-media-generation"><span className="maturity-surface-title">Media understanding and media generation</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-alpha"><span className="maturity-level-code">M2</span><span>Alpha</span></span><span>6 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>2%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "2%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>64%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "64%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>68%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "68%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#image-video-and-music-generation-tools"><span className="maturity-surface-title">Image, video, and music generation tools</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-alpha"><span className="maturity-level-code">M2</span><span>Alpha</span></span><span>5 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>61%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "61%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>68%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "68%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#local-model-providers-ollama-vllm-sglang-lm-studio"><span className="maturity-surface-title">Local model providers: Ollama, vLLM, SGLang, LM Studio</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-alpha"><span className="maturity-level-code">M2</span><span>Alpha</span></span><span>5 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>61%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "61%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>68%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "68%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#long-tail-hosted-providers"><span className="maturity-surface-title">Long-tail hosted providers</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-alpha"><span className="maturity-level-code">M2</span><span>Alpha</span></span><span>3 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>61%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "61%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>68%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "68%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#voice-and-realtime-talk"><span className="maturity-surface-title">Voice and realtime talk</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-alpha"><span className="maturity-level-code">M2</span><span>Alpha</span></span><span>6 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>61%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "61%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>68%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "68%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#matrix"><span className="maturity-surface-title">Matrix</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-alpha"><span className="maturity-level-code">M2</span><span>Alpha</span></span><span>6 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>60%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "60%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>67%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "67%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#google-chat"><span className="maturity-surface-title">Google Chat</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-alpha"><span className="maturity-level-code">M2</span><span>Alpha</span></span><span>5 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>59%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "59%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>66%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "66%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#microsoft-teams"><span className="maturity-surface-title">Microsoft Teams</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-alpha"><span className="maturity-level-code">M2</span><span>Alpha</span></span><span>5 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>59%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "59%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>66%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "66%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#signal"><span className="maturity-surface-title">Signal</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-alpha"><span className="maturity-level-code">M2</span><span>Alpha</span></span><span>5 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>59%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "59%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>66%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "66%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#tui"><span className="maturity-surface-title">TUI</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-alpha"><span className="maturity-level-code">M2</span><span>Alpha</span></span><span>5 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>59%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "59%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>66%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "66%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#native-windows"><span className="maturity-surface-title">Native Windows</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-alpha"><span className="maturity-level-code">M2</span><span>Alpha</span></span><span>4 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>58%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "58%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>66%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "66%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-partial">Partial - 1</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#clawhub"><span className="maturity-surface-title">ClawHub</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-alpha"><span className="maturity-level-code">M2</span><span>Alpha</span></span><span>4 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>58%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "58%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>62%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "62%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#kubernetes-hosting"><span className="maturity-surface-title">Kubernetes hosting</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-alpha"><span className="maturity-level-code">M2</span><span>Alpha</span></span><span>4 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>55%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "55%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>61%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "61%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#feishu-qq-bot-wechat-yuanbao-zalo-zalo-personal-regional-channels"><span className="maturity-surface-title">Feishu, QQ Bot, WeChat, Yuanbao, Zalo, Zalo Personal, regional channels</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-alpha"><span className="maturity-level-code">M2</span><span>Alpha</span></span><span>4 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>55%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "55%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>58%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "58%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#mattermost-line-irc-nextcloud-talk-nostr-twitch-tlon-synology-chat"><span className="maturity-surface-title">Mattermost, LINE, IRC, Nextcloud Talk, Nostr, Twitch, Tlon, Synology Chat</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-alpha"><span className="maturity-level-code">M2</span><span>Alpha</span></span><span>4 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>53%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "53%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>54%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "54%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#openclaw-app-sdk"><span className="maturity-surface-title">OpenClaw App SDK</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-alpha"><span className="maturity-level-code">M2</span><span>Alpha</span></span><span>6 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>3%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "3%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>54%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "54%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>53%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "53%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#nix-install-path"><span className="maturity-surface-title">Nix install path</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-experimental"><span className="maturity-level-code">M1</span><span>Experimental</span></span><span>5 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>41%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "41%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>44%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "44%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#voice-call-channel"><span className="maturity-surface-title">Voice Call channel</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-experimental"><span className="maturity-level-code">M1</span><span>Experimental</span></span><span>5 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>41%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "41%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>44%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "44%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#watchos-companion-surfaces"><span className="maturity-surface-title">watchOS companion surfaces</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-experimental"><span className="maturity-level-code">M1</span><span>Experimental</span></span><span>5 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>41%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "41%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>44%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "44%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#linux-companion-app"><span className="maturity-surface-title">Linux companion app</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-experimental"><span className="maturity-level-code">M0</span><span>Planned</span></span><span>5 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>19%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "19%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>21%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "21%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#native-windows-companion-app"><span className="maturity-surface-title">Native Windows companion app</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-experimental"><span className="maturity-level-code">M0</span><span>Planned</span></span><span>5 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>19%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "19%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>21%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "21%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
    </div>
  </Tab>
  <Tab title="Core">
    <div className="maturity-surface-table">
      <div className="maturity-surface-row maturity-surface-row-header"><span>Surface</span><span>Coverage</span><span>Quality</span><span>Completeness</span><span>Support</span></div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#cli"><span className="maturity-surface-title">CLI</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-stable"><span className="maturity-level-code">M4</span><span>Stable</span></span><span>7 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>4%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "4%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-stable"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-stable">Stable</span><span>83%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "83%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-stable"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-stable">Stable</span><span>90%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "90%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-partial">Partial - 6</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#gateway-runtime"><span className="maturity-surface-title">Gateway runtime</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-stable"><span className="maturity-level-code">M4</span><span>Stable</span></span><span>13 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>6%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "6%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-stable"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-stable">Stable</span><span>81%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "81%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-stable"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-stable">Stable</span><span>89%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "89%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-partial">Partial - 12</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#agent-runtime"><span className="maturity-surface-title">Agent Runtime</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>9 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>33%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "33%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>78%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "78%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>79%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "79%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-partial">Partial - 6</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#session-memory-and-context-engine"><span className="maturity-surface-title">Session, memory, and context engine</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>9 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>30%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "30%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>77%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "77%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>79%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "79%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-partial">Partial - 6</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#channel-framework"><span className="maturity-surface-title">Channel framework</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>8 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>13%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "13%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>76%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "76%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>79%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "79%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-partial">Partial - 5</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#observability"><span className="maturity-surface-title">Observability</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>5 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>18%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "18%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>75%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "75%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>79%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "79%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-partial">Partial - 3</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#gateway-web-app"><span className="maturity-surface-title">Gateway Web App</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>6 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>4%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "4%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>74%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "74%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>79%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "79%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#plugins"><span className="maturity-surface-title">Plugins</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>9 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>12%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "12%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>72%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "72%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>79%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "79%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-partial">Partial - 7</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#security-auth-pairing-and-secrets"><span className="maturity-surface-title">Security, auth, pairing, and secrets</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>6 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>16%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "16%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>72%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "72%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>79%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "79%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-partial">Partial - 5</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#automation-cron-hooks-tasks-polling"><span className="maturity-surface-title">Automation: cron, hooks, tasks, polling</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>6 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>2%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "2%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>72%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "72%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>79%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "79%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#media-understanding-and-media-generation"><span className="maturity-surface-title">Media understanding and media generation</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-alpha"><span className="maturity-level-code">M2</span><span>Alpha</span></span><span>6 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>2%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "2%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>64%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "64%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>68%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "68%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#voice-and-realtime-talk"><span className="maturity-surface-title">Voice and realtime talk</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-alpha"><span className="maturity-level-code">M2</span><span>Alpha</span></span><span>6 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>61%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "61%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>68%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "68%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#tui"><span className="maturity-surface-title">TUI</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-alpha"><span className="maturity-level-code">M2</span><span>Alpha</span></span><span>5 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>59%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "59%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>66%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "66%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#clawhub"><span className="maturity-surface-title">ClawHub</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-alpha"><span className="maturity-level-code">M2</span><span>Alpha</span></span><span>4 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>58%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "58%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>62%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "62%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#openclaw-app-sdk"><span className="maturity-surface-title">OpenClaw App SDK</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-alpha"><span className="maturity-level-code">M2</span><span>Alpha</span></span><span>6 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>3%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "3%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>54%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "54%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>53%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "53%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
    </div>
  </Tab>
  <Tab title="Platform">
    <div className="maturity-surface-table">
      <div className="maturity-surface-row maturity-surface-row-header"><span>Surface</span><span>Coverage</span><span>Quality</span><span>Completeness</span><span>Support</span></div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#linux-gateway-host"><span className="maturity-surface-title">Linux Gateway host</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-stable"><span className="maturity-level-code">M4</span><span>Stable</span></span><span>5 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>75%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "75%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-stable"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-stable">Stable</span><span>89%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "89%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-partial">Partial - 4</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#macos-gateway-host"><span className="maturity-surface-title">macOS Gateway host</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-stable"><span className="maturity-level-code">M4</span><span>Stable</span></span><span>7 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>74%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "74%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-stable"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-stable">Stable</span><span>88%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "88%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#android-app"><span className="maturity-surface-title">Android app</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-stable"><span className="maturity-level-code">M4</span><span>Stable</span></span><span>7 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-stable"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-stable">Stable</span><span>80%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "80%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-stable"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-stable">Stable</span><span>80%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "80%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#ios-app"><span className="maturity-surface-title">iOS app</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-stable"><span className="maturity-level-code">M4</span><span>Stable</span></span><span>8 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-stable"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-stable">Stable</span><span>80%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "80%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-stable"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-stable">Stable</span><span>80%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "80%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#docker-and-podman-hosting"><span className="maturity-surface-title">Docker and Podman hosting</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>4 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>7%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "7%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>71%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "71%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>79%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "79%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#windows-via-wsl2"><span className="maturity-surface-title">Windows via WSL2</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>6 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>6%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "6%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>69%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "69%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>79%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "79%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-partial">Partial - 5</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#raspberry-pi-and-small-linux-devices"><span className="maturity-surface-title">Raspberry Pi and small Linux devices</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>4 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>67%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "67%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>79%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "79%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#macos-companion-app"><span className="maturity-surface-title">macOS companion app</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>8 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>66%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "66%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>78%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "78%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#native-windows"><span className="maturity-surface-title">Native Windows</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-alpha"><span className="maturity-level-code">M2</span><span>Alpha</span></span><span>4 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>58%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "58%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>66%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "66%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-partial">Partial - 1</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#kubernetes-hosting"><span className="maturity-surface-title">Kubernetes hosting</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-alpha"><span className="maturity-level-code">M2</span><span>Alpha</span></span><span>4 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>55%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "55%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>61%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "61%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#nix-install-path"><span className="maturity-surface-title">Nix install path</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-experimental"><span className="maturity-level-code">M1</span><span>Experimental</span></span><span>5 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>41%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "41%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>44%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "44%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#watchos-companion-surfaces"><span className="maturity-surface-title">watchOS companion surfaces</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-experimental"><span className="maturity-level-code">M1</span><span>Experimental</span></span><span>5 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>41%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "41%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>44%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "44%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#linux-companion-app"><span className="maturity-surface-title">Linux companion app</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-experimental"><span className="maturity-level-code">M0</span><span>Planned</span></span><span>5 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>19%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "19%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>21%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "21%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#native-windows-companion-app"><span className="maturity-surface-title">Native Windows companion app</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-experimental"><span className="maturity-level-code">M0</span><span>Planned</span></span><span>5 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>19%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "19%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>21%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "21%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
    </div>
  </Tab>
  <Tab title="Channel">
    <div className="maturity-surface-table">
      <div className="maturity-surface-row maturity-surface-row-header"><span>Surface</span><span>Coverage</span><span>Quality</span><span>Completeness</span><span>Support</span></div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#discord"><span className="maturity-surface-title">Discord</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-stable"><span className="maturity-level-code">M4</span><span>Stable</span></span><span>6 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>73%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "73%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-stable"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-stable">Stable</span><span>87%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "87%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-partial">Partial - 4</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#telegram"><span className="maturity-surface-title">Telegram</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>5 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>68%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "68%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>78%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "78%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-full">Full - 5</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#slack"><span className="maturity-surface-title">Slack</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>5 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>66%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "66%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>78%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "78%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-full">Full - 5</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#imessage-and-bluebubbles"><span className="maturity-surface-title">iMessage and BlueBubbles</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>5 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>66%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "66%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>78%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "78%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#whatsapp"><span className="maturity-surface-title">WhatsApp</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>5 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>66%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "66%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>78%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "78%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#matrix"><span className="maturity-surface-title">Matrix</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-alpha"><span className="maturity-level-code">M2</span><span>Alpha</span></span><span>6 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>60%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "60%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>67%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "67%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#google-chat"><span className="maturity-surface-title">Google Chat</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-alpha"><span className="maturity-level-code">M2</span><span>Alpha</span></span><span>5 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>59%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "59%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>66%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "66%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#microsoft-teams"><span className="maturity-surface-title">Microsoft Teams</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-alpha"><span className="maturity-level-code">M2</span><span>Alpha</span></span><span>5 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>59%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "59%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>66%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "66%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#signal"><span className="maturity-surface-title">Signal</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-alpha"><span className="maturity-level-code">M2</span><span>Alpha</span></span><span>5 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>59%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "59%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>66%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "66%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#feishu-qq-bot-wechat-yuanbao-zalo-zalo-personal-regional-channels"><span className="maturity-surface-title">Feishu, QQ Bot, WeChat, Yuanbao, Zalo, Zalo Personal, regional channels</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-alpha"><span className="maturity-level-code">M2</span><span>Alpha</span></span><span>4 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>55%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "55%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>58%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "58%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#mattermost-line-irc-nextcloud-talk-nostr-twitch-tlon-synology-chat"><span className="maturity-surface-title">Mattermost, LINE, IRC, Nextcloud Talk, Nostr, Twitch, Tlon, Synology Chat</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-alpha"><span className="maturity-level-code">M2</span><span>Alpha</span></span><span>4 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>53%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "53%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>54%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "54%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#voice-call-channel"><span className="maturity-surface-title">Voice Call channel</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-experimental"><span className="maturity-level-code">M1</span><span>Experimental</span></span><span>5 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>41%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "41%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>44%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "44%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
    </div>
  </Tab>
  <Tab title="Provider and tool">
    <div className="maturity-surface-table">
      <div className="maturity-surface-row maturity-surface-row-header"><span>Surface</span><span>Coverage</span><span>Quality</span><span>Completeness</span><span>Support</span></div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#browser-automation-exec-and-sandbox-tools"><span className="maturity-surface-title">Browser automation, exec, and sandbox tools</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>3 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>21%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "21%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>75%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "75%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>79%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "79%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-partial">Partial - 2</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#openai-and-codex-provider-path"><span className="maturity-surface-title">OpenAI and Codex provider path</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>5 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>26%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "26%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>74%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "74%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>79%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "79%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-partial">Partial - 3</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#web-search-tools"><span className="maturity-surface-title">Web search tools</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>4 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>9%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "9%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>74%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "74%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>79%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "79%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#anthropic-provider-path"><span className="maturity-surface-title">Anthropic provider path</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>5 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>71%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "71%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>78%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "78%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#google-provider-path"><span className="maturity-surface-title">Google provider path</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>5 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>66%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "66%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>78%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "78%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#openrouter-provider-path"><span className="maturity-surface-title">OpenRouter provider path</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-beta"><span className="maturity-level-code">M3</span><span>Beta</span></span><span>4 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>66%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "66%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-beta"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-beta">Beta</span><span>78%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "78%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#image-video-and-music-generation-tools"><span className="maturity-surface-title">Image, video, and music generation tools</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-alpha"><span className="maturity-level-code">M2</span><span>Alpha</span></span><span>5 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>61%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "61%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>68%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "68%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#local-model-providers-ollama-vllm-sglang-lm-studio"><span className="maturity-surface-title">Local model providers: Ollama, vLLM, SGLang, LM Studio</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-alpha"><span className="maturity-level-code">M2</span><span>Alpha</span></span><span>5 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>61%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "61%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>68%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "68%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
      <div className="maturity-surface-row">
        <a className="maturity-surface-name" href="/maturity/taxonomy#long-tail-hosted-providers"><span className="maturity-surface-title">Long-tail hosted providers</span><span className="maturity-surface-meta"><span className="maturity-level-pill maturity-level-alpha"><span className="maturity-level-code">M2</span><span>Alpha</span></span><span>3 areas</span></span></a>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span><span className="maturity-score maturity-score-experimental"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-experimental">Experimental</span><span>0%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "0%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>61%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "61%" }} /></span></span></div>
        <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span><span className="maturity-score maturity-score-alpha"><span className="maturity-score-label"><span className="maturity-level-pill maturity-level-alpha">Alpha</span><span>68%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "68%" }} /></span></span></div>
        <div className="maturity-surface-support"><span className="maturity-lts maturity-lts-none">None</span></div>
      </div>
    </div>
  </Tab>
</Tabs>

## QA evidence summary

The checks below show which scorecard areas were exercised by QA profile evidence.

<div className="maturity-evidence-grid">
  <div className="maturity-evidence-card">
    <span className="maturity-evidence-title">Full taxonomy validation</span>
    <span>2026-06-23T07:24:36.128Z</span>
    <span>96 checks - 94 passed, 2 blocked</span>
    <span>0 of 281 (0%) areas - 20 of 1675 (1.2%) features - 77 of 1665 (4.6%) coverage IDs</span>
  </div>
</div>

### Readiness by area

Open a surface to inspect the evidence state of each category. The list stays collapsed so the page remains useful at a glance.

<AccordionGroup>
  <Accordion title="Agent Runtime - 9 areas">
    <p className="maturity-readiness-summary">8 partially reviewed / 1 needs review</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Agent Turn Execution</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>0 of 3 (0%) / 7 of 24 (29.2%)</span>
        <span>17 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">External Runtimes and Subagents</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>0 of 4 (0%) / 3 of 10 (30%)</span>
        <span>7 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Hosted Provider Execution</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>1 of 5 (20%) / 1 of 5 (20%)</span>
        <span>4 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Local and Self-hosted Providers</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Model and Runtime Selection</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>0 of 4 (0%) / 2 of 8 (25%)</span>
        <span>6 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Provider Auth</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>0 of 10 (0%) / 4 of 17 (23.5%)</span>
        <span>13 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Streaming and Progress</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>0 of 2 (0%) / 5 of 9 (55.6%)</span>
        <span>4 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Tool Calls and Response Handling</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>0 of 3 (0%) / 15 of 23 (65.2%)</span>
        <span>8 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Tool Execution Controls</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>0 of 6 (0%) / 6 of 12 (50%)</span>
        <span>6 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="Android app - 7 areas">
    <p className="maturity-readiness-summary">7 needs review</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Connection Setup</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 1 (0%) / 0 of 1 (0%)</span>
        <span>1 capability gap</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Device Runtime</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 2 (0%) / 0 of 2 (0%)</span>
        <span>2 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Distribution</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 3 (0%) / 0 of 3 (0%)</span>
        <span>3 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Media Capture</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 1 (0%) / 0 of 1 (0%)</span>
        <span>1 capability gap</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Mobile Chat</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 1 (0%) / 0 of 1 (0%)</span>
        <span>1 capability gap</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Settings</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 1 (0%) / 0 of 1 (0%)</span>
        <span>1 capability gap</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Voice</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 1 (0%) / 0 of 1 (0%)</span>
        <span>1 capability gap</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="Anthropic provider path - 5 areas">
    <p className="maturity-readiness-summary">5 needs review</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Media Inputs</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 4 (0%) / 0 of 4 (0%)</span>
        <span>4 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Model and Runtime Selection</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 10 (0%) / 0 of 12 (0%)</span>
        <span>12 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Prompt Cache and Context</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Provider Auth and Recovery</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 9 (0%) / 0 of 9 (0%)</span>
        <span>9 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Request Transport and Turn Semantics</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 10 (0%) / 0 of 10 (0%)</span>
        <span>10 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="Automation: cron, hooks, tasks, polling - 6 areas">
    <p className="maturity-readiness-summary">5 needs review / 1 partially reviewed</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Automation Hooks</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 11 (0%) / 0 of 11 (0%)</span>
        <span>11 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Background Tasks and Flows</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 10 (0%) / 0 of 10 (0%)</span>
        <span>10 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Cron Jobs</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 15 (0%) / 0 of 15 (0%)</span>
        <span>15 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Event Ingress</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 15 (0%) / 0 of 15 (0%)</span>
        <span>15 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Heartbeat</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 1 of 7 (14.3%)</span>
        <span>6 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Polling Controls</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 10 (0%) / 0 of 10 (0%)</span>
        <span>10 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="Browser automation, exec, and sandbox tools - 3 areas">
    <p className="maturity-readiness-summary">2 partially reviewed / 1 needs review</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Browser Automation</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>1 of 8 (12.5%) / 1 of 8 (12.5%)</span>
        <span>7 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Sandbox and Tool Policy</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 6 (0%) / 0 of 6 (0%)</span>
        <span>6 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Tool Invocation and Execution</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>2 of 6 (33.3%) / 4 of 8 (50%)</span>
        <span>4 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="Gateway Web App - 6 areas">
    <p className="maturity-readiness-summary">3 needs review / 3 partially reviewed</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Browser Access and Trust</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Browser Realtime Talk</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Browser UI</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>0 of 10 (0%) / 1 of 12 (8.3%)</span>
        <span>11 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Configuration</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Operator Console</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>0 of 10 (0%) / 1 of 12 (8.3%)</span>
        <span>11 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">WebChat Conversations</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>0 of 15 (0%) / 2 of 20 (10%)</span>
        <span>18 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="Channel framework - 8 areas">
    <p className="maturity-readiness-summary">4 needs review / 4 partially reviewed</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Channel Actions Commands and Approvals</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Channel Setup</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 1 of 7 (14.3%)</span>
        <span>6 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Conversation Routing and Delivery</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>0 of 10 (0%) / 5 of 27 (18.5%)</span>
        <span>22 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Group Thread and Ambient Room Behavior</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 4 of 11 (36.4%)</span>
        <span>7 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Inbound Access and Identity Gates</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Media Attachments and Rich Channel Data</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 4 (0%) / 0 of 4 (0%)</span>
        <span>4 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Outbound Delivery and Reply Pipeline</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>0 of 4 (0%) / 8 of 21 (38.1%)</span>
        <span>13 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Status Health and Operator Controls</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 4 (0%) / 0 of 6 (0%)</span>
        <span>6 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="ClawHub - 4 areas">
    <p className="maturity-readiness-summary">4 needs review</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Catalog Discovery</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Compatibility and Trust</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 12 (0%) / 0 of 12 (0%)</span>
        <span>12 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Plugin Lifecycle and Health</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 26 (0%) / 0 of 26 (0%)</span>
        <span>26 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Publishing</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 7 (0%) / 0 of 7 (0%)</span>
        <span>7 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="CLI - 7 areas">
    <p className="maturity-readiness-summary">5 needs review / 2 partially reviewed</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">CLI Observability</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">CLI Setup</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>1 of 6 (16.7%) / 1 of 6 (16.7%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Doctor</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 10 (0%) / 0 of 10 (0%)</span>
        <span>10 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Gateway Service Management</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 1 of 7 (14.3%)</span>
        <span>6 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Onboarding and Auth Setup</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Plugin and Channel Setup</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Updates and Upgrades</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="Discord - 6 areas">
    <p className="maturity-readiness-summary">6 needs review</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Access and Identity</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 6 (0%) / 0 of 6 (0%)</span>
        <span>6 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Channel Setup and Operations</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 10 (0%) / 0 of 10 (0%)</span>
        <span>10 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Conversation Routing and Delivery</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 12 (0%) / 0 of 12 (0%)</span>
        <span>12 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Media and Rich Content</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 1 (0%) / 0 of 1 (0%)</span>
        <span>1 capability gap</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Native Controls and Approvals</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Realtime Voice and Calls</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="Docker and Podman hosting - 4 areas">
    <p className="maturity-readiness-summary">3 needs review / 1 partially reviewed</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Agent Sandbox and Tooling</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 3 (0%) / 0 of 3 (0%)</span>
        <span>3 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Container Operations</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 11 (0%) / 0 of 11 (0%)</span>
        <span>11 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Container Setup</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 6 (0%) / 0 of 6 (0%)</span>
        <span>6 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Image Release and Validation</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>1 of 5 (20%) / 2 of 7 (28.6%)</span>
        <span>5 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="Feishu, QQ Bot, WeChat, Yuanbao, Zalo, Zalo Personal, regional channels - 4 areas">
    <p className="maturity-readiness-summary">4 needs review</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Access and Identity</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 1 (0%) / 0 of 1 (0%)</span>
        <span>1 capability gap</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Channel Setup and Operations</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 6 (0%) / 0 of 6 (0%)</span>
        <span>6 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Conversation Routing and Delivery</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 1 (0%) / 0 of 1 (0%)</span>
        <span>1 capability gap</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Media and Rich Content</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 1 (0%) / 0 of 1 (0%)</span>
        <span>1 capability gap</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="Gateway runtime - 13 areas">
    <p className="maturity-readiness-summary">9 needs review / 4 partially reviewed</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Approvals and Remote Execution</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 6 (0%) / 0 of 6 (0%)</span>
        <span>6 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Device Auth and Pairing</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 10 (0%) / 0 of 10 (0%)</span>
        <span>10 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Gateway Lifecycle</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>0 of 7 (0%) / 4 of 12 (33.3%)</span>
        <span>8 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Gateway RPC APIs and Events</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>0 of 20 (0%) / 2 of 22 (9.1%)</span>
        <span>20 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Health, Diagnostics, and Repair</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 7 (0%) / 0 of 7 (0%)</span>
        <span>7 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Hosted Web Surface</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 4 (0%) / 0 of 4 (0%)</span>
        <span>4 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">HTTP APIs</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>1 of 4 (25%) / 1 of 4 (25%)</span>
        <span>3 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Network Access and Discovery</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 6 (0%) / 0 of 6 (0%)</span>
        <span>6 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Nodes and Remote Capabilities</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 8 (0%) / 0 of 8 (0%)</span>
        <span>8 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Protocol Compatibility</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 7 (0%) / 0 of 7 (0%)</span>
        <span>7 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Roles and Permissions</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Security Controls</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 6 (0%) / 0 of 6 (0%)</span>
        <span>6 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">WebSocket Connection</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>1 of 8 (12.5%) / 1 of 8 (12.5%)</span>
        <span>7 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="Google Chat - 5 areas">
    <p className="maturity-readiness-summary">5 needs review</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Access and Identity</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 11 (0%) / 0 of 11 (0%)</span>
        <span>11 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Channel Setup and Operations</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 16 (0%) / 0 of 16 (0%)</span>
        <span>16 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Conversation Routing and Delivery</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 1 (0%) / 0 of 1 (0%)</span>
        <span>1 capability gap</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Media and Rich Content</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 1 (0%) / 0 of 1 (0%)</span>
        <span>1 capability gap</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Native Controls and Approvals</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 16 (0%) / 0 of 16 (0%)</span>
        <span>16 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="Google provider path - 5 areas">
    <p className="maturity-readiness-summary">5 needs review</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Direct Gemini Runtime</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 9 (0%) / 0 of 9 (0%)</span>
        <span>9 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Media, Search, and Realtime</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 10 (0%) / 0 of 10 (0%)</span>
        <span>10 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Model Routing and Endpoints</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 10 (0%) / 0 of 10 (0%)</span>
        <span>10 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Prompt Caching</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Provider Setup and Credentials</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 10 (0%) / 0 of 10 (0%)</span>
        <span>10 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="Image, video, and music generation tools - 5 areas">
    <p className="maturity-readiness-summary">5 needs review</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Image Generation</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 9 (0%) / 0 of 9 (0%)</span>
        <span>9 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Media Routing and Discovery</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 4 (0%) / 0 of 4 (0%)</span>
        <span>4 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Music Generation</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 6 (0%) / 0 of 6 (0%)</span>
        <span>6 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Task Lifecycle and Delivery</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 12 (0%) / 0 of 12 (0%)</span>
        <span>12 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Video Generation</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 11 (0%) / 0 of 11 (0%)</span>
        <span>11 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="iMessage and BlueBubbles - 5 areas">
    <p className="maturity-readiness-summary">5 needs review</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Access and Identity</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 6 (0%) / 0 of 6 (0%)</span>
        <span>6 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Channel Setup and Operations</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 11 (0%) / 0 of 11 (0%)</span>
        <span>11 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Conversation Routing and Delivery</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 4 (0%) / 0 of 4 (0%)</span>
        <span>4 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Media and Rich Content</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 7 (0%) / 0 of 7 (0%)</span>
        <span>7 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Native Controls and Approvals</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 3 (0%) / 0 of 3 (0%)</span>
        <span>3 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="iOS app - 8 areas">
    <p className="maturity-readiness-summary">8 needs review</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Canvas and Screen</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 1 (0%) / 0 of 1 (0%)</span>
        <span>1 capability gap</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Chat and Sessions</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 1 (0%) / 0 of 1 (0%)</span>
        <span>1 capability gap</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Device Commands</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 2 (0%) / 0 of 2 (0%)</span>
        <span>2 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Distribution</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 1 (0%) / 0 of 1 (0%)</span>
        <span>1 capability gap</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Gateway Setup and Diagnostics</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 7 (0%) / 0 of 7 (0%)</span>
        <span>7 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Media and Sharing</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 1 (0%) / 0 of 1 (0%)</span>
        <span>1 capability gap</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Notifications and Background</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 1 (0%) / 0 of 1 (0%)</span>
        <span>1 capability gap</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Voice</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 1 (0%) / 0 of 1 (0%)</span>
        <span>1 capability gap</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="Kubernetes hosting - 4 areas">
    <p className="maturity-readiness-summary">4 needs review</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Access and Exposure</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Cluster Lifecycle</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Configuration and Secrets</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Deployment Setup</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="Linux companion app - 5 areas">
    <p className="maturity-readiness-summary">5 needs review</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">App Distribution</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 3 (0%) / 0 of 3 (0%)</span>
        <span>3 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Chat and Sessions</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 3 (0%) / 0 of 3 (0%)</span>
        <span>3 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Desktop Capabilities</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 9 (0%) / 0 of 9 (0%)</span>
        <span>9 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Gateway Connectivity</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 4 (0%) / 0 of 4 (0%)</span>
        <span>4 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Status and Diagnostics</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 7 (0%) / 0 of 7 (0%)</span>
        <span>7 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="Linux Gateway host - 5 areas">
    <p className="maturity-readiness-summary">5 needs review</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Deployment Targets</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 3 (0%) / 0 of 3 (0%)</span>
        <span>3 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Diagnostics and Repair</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 4 (0%) / 0 of 4 (0%)</span>
        <span>4 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Gateway Runtime and Service Control</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 6 (0%) / 0 of 6 (0%)</span>
        <span>6 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Host Setup and Updates</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 4 (0%) / 0 of 4 (0%)</span>
        <span>4 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Remote Access and Security</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 6 (0%) / 0 of 6 (0%)</span>
        <span>6 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="Local model providers: Ollama, vLLM, SGLang, LM Studio - 5 areas">
    <p className="maturity-readiness-summary">5 needs review</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Local Memory and Embeddings</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Native Provider Plugins</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 10 (0%) / 0 of 10 (0%)</span>
        <span>10 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Network Safety and Prompt Controls</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 2 (0%) / 0 of 2 (0%)</span>
        <span>2 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">OpenAI-Compatible Runtime Compatibility</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 8 (0%) / 0 of 8 (0%)</span>
        <span>8 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Provider Setup, Lifecycle, and Diagnostics</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 12 (0%) / 0 of 12 (0%)</span>
        <span>12 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="Long-tail hosted providers - 3 areas">
    <p className="maturity-readiness-summary">3 needs review</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Hosted LLM Providers</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 12 (0%) / 0 of 12 (0%)</span>
        <span>12 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Hosted Media Providers</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 8 (0%) / 0 of 8 (0%)</span>
        <span>8 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Provider Operations</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 12 (0%) / 0 of 12 (0%)</span>
        <span>12 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="macOS companion app - 8 areas">
    <p className="maturity-readiness-summary">8 needs review</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Canvas</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 4 (0%) / 0 of 4 (0%)</span>
        <span>4 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Local Setup</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 7 (0%) / 0 of 7 (0%)</span>
        <span>7 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Native Capabilities</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Remote Connections</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 3 (0%) / 0 of 3 (0%)</span>
        <span>3 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Remote WebChat</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Status and Settings</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Voice and Talk</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 3 (0%) / 0 of 3 (0%)</span>
        <span>3 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">WebChat</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 3 (0%) / 0 of 3 (0%)</span>
        <span>3 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="macOS Gateway host - 7 areas">
    <p className="maturity-readiness-summary">7 needs review</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">CLI Setup</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 4 (0%) / 0 of 4 (0%)</span>
        <span>4 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Diagnostics and Observability</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 4 (0%) / 0 of 4 (0%)</span>
        <span>4 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Gateway Service Lifecycle</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 10 (0%) / 0 of 10 (0%)</span>
        <span>10 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Local Gateway Integration</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 9 (0%) / 0 of 9 (0%)</span>
        <span>9 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Permissions and Native Capabilities</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 4 (0%) / 0 of 4 (0%)</span>
        <span>4 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Profiles and Isolation</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Remote Gateway Mode</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="Matrix - 6 areas">
    <p className="maturity-readiness-summary">6 needs review</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Access and Identity</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 7 (0%) / 0 of 7 (0%)</span>
        <span>7 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Channel Setup and Operations</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Conversation Routing and Delivery</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 1 (0%) / 0 of 1 (0%)</span>
        <span>1 capability gap</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Encryption and Verification</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 3 (0%) / 0 of 3 (0%)</span>
        <span>3 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Media and Rich Content</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 1 (0%) / 0 of 1 (0%)</span>
        <span>1 capability gap</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Native Controls and Approvals</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 6 (0%) / 0 of 6 (0%)</span>
        <span>6 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="Mattermost, LINE, IRC, Nextcloud Talk, Nostr, Twitch, Tlon, Synology Chat - 4 areas">
    <p className="maturity-readiness-summary">4 needs review</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Access and Identity</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 1 (0%) / 0 of 1 (0%)</span>
        <span>1 capability gap</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Channel Setup and Operations</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 1 (0%) / 0 of 1 (0%)</span>
        <span>1 capability gap</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Conversation Routing and Delivery</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 1 (0%) / 0 of 1 (0%)</span>
        <span>1 capability gap</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Media and Rich Content</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 1 (0%) / 0 of 1 (0%)</span>
        <span>1 capability gap</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="Media understanding and media generation - 6 areas">
    <p className="maturity-readiness-summary">4 needs review / 2 partially reviewed</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Channel Media Handling</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Media Configuration</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 1 (0%) / 0 of 1 (0%)</span>
        <span>1 capability gap</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Media Generation</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>1 of 17 (5.9%) / 1 of 19 (5.3%)</span>
        <span>18 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Media Intake and Access</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 8 (0%) / 0 of 8 (0%)</span>
        <span>8 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Media Understanding</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>0 of 12 (0%) / 1 of 14 (7.1%)</span>
        <span>13 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Text-to-Speech Delivery</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 2 (0%) / 0 of 2 (0%)</span>
        <span>2 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="Microsoft Teams - 5 areas">
    <p className="maturity-readiness-summary">5 needs review</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Access and Identity</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 9 (0%) / 0 of 9 (0%)</span>
        <span>9 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Channel Setup and Operations</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 9 (0%) / 0 of 9 (0%)</span>
        <span>9 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Conversation Routing and Delivery</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Media and Rich Content</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Native Controls and Approvals</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="Native Windows - 4 areas">
    <p className="maturity-readiness-summary">4 needs review</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">CLI</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 9 (0%) / 0 of 9 (0%)</span>
        <span>9 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Gateway Management</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 11 (0%) / 0 of 11 (0%)</span>
        <span>11 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Networking</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 4 (0%) / 0 of 4 (0%)</span>
        <span>4 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Updates</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 4 (0%) / 0 of 4 (0%)</span>
        <span>4 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="Native Windows companion app - 5 areas">
    <p className="maturity-readiness-summary">5 needs review</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Chat Sessions</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 2 (0%) / 0 of 2 (0%)</span>
        <span>2 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Desktop Tools and Permissions</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 10 (0%) / 0 of 10 (0%)</span>
        <span>10 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Gateway Connection</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 3 (0%) / 0 of 3 (0%)</span>
        <span>3 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Installation and Updates</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 4 (0%) / 0 of 4 (0%)</span>
        <span>4 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Status and Repair</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="Nix install path - 5 areas">
    <p className="maturity-readiness-summary">5 needs review</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Activation and App UX</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 7 (0%) / 0 of 7 (0%)</span>
        <span>7 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Config and State</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 7 (0%) / 0 of 7 (0%)</span>
        <span>7 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Install Handoff</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 4 (0%) / 0 of 4 (0%)</span>
        <span>4 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Plugin Lifecycle</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 4 (0%) / 0 of 4 (0%)</span>
        <span>4 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Service Runtime and Guards</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 8 (0%) / 0 of 8 (0%)</span>
        <span>8 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="OpenAI and Codex provider path - 5 areas">
    <p className="maturity-readiness-summary">2 needs review / 3 partially reviewed</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Image and Multimodal Input</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 2 (0%) / 0 of 2 (0%)</span>
        <span>2 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Model and Auth</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>1 of 6 (16.7%) / 4 of 9 (44.4%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Native Codex Harness</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>0 of 2 (0%) / 4 of 9 (44.4%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Responses and Tool Compatibility</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>1 of 4 (25%) / 2 of 5 (40%)</span>
        <span>3 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Voice and Realtime Audio</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 2 (0%) / 0 of 2 (0%)</span>
        <span>2 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="OpenClaw App SDK - 6 areas">
    <p className="maturity-readiness-summary">5 needs review / 1 partially reviewed</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Agent Conversations</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 6 (0%) / 0 of 6 (0%)</span>
        <span>6 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Client API</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 4 (0%) / 0 of 4 (0%)</span>
        <span>4 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Compatibility</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Events and Approvals</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Gateway Access</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Resource Helpers</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 1 of 6 (16.7%)</span>
        <span>5 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="OpenRouter provider path - 4 areas">
    <p className="maturity-readiness-summary">4 needs review</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Chat Runtime and Normalization</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 15 (0%) / 0 of 15 (0%)</span>
        <span>15 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Media Generation and Speech</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 7 (0%) / 0 of 7 (0%)</span>
        <span>7 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Provider Recovery and Diagnostics</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Provider Setup and Auth</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 14 (0%) / 0 of 14 (0%)</span>
        <span>14 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="Plugins - 9 areas">
    <p className="maturity-readiness-summary">6 needs review / 3 partially reviewed</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Authoring and Packaging plugins</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 8 (0%) / 0 of 8 (0%)</span>
        <span>8 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Bundled plugins</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Canvas plugin</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 6 (0%) / 0 of 6 (0%)</span>
        <span>6 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Channel plugins</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Installing and running plugins</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>0 of 6 (0%) / 7 of 20 (35%)</span>
        <span>13 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Plugin approvals</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 6 (0%) / 0 of 6 (0%)</span>
        <span>6 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Provider and tool plugins</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>1 of 6 (16.7%) / 9 of 21 (42.9%)</span>
        <span>12 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Publishing plugins</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 6 (0%) / 0 of 6 (0%)</span>
        <span>6 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Testing plugins</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>0 of 6 (0%) / 3 of 11 (27.3%)</span>
        <span>8 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="Raspberry Pi and small Linux devices - 4 areas">
    <p className="maturity-readiness-summary">4 needs review</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Gateway Runtime</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 10 (0%) / 0 of 10 (0%)</span>
        <span>10 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Performance and Diagnostics</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Remote Access and Auth</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 9 (0%) / 0 of 9 (0%)</span>
        <span>9 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Setup and Compatibility</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 12 (0%) / 0 of 12 (0%)</span>
        <span>12 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="Security, auth, pairing, and secrets - 6 areas">
    <p className="maturity-readiness-summary">2 partially reviewed / 4 needs review</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Approval Policy and Tool Safeguards</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>0 of 2 (0%) / 3 of 6 (50%)</span>
        <span>3 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Channel Access Control</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 3 (0%) / 0 of 3 (0%)</span>
        <span>3 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Credential and Secret Hygiene</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 5 of 11 (45.5%)</span>
        <span>6 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Device and Node Pairing</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 11 (0%) / 0 of 11 (0%)</span>
        <span>11 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Gateway Auth and Remote Access</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 9 (0%) / 0 of 9 (0%)</span>
        <span>9 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Plugin Trust</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 2 (0%) / 0 of 2 (0%)</span>
        <span>2 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="Session, memory, and context engine - 9 areas">
    <p className="maturity-readiness-summary">2 needs review / 7 partially reviewed</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">CLI Session and Transcript Management</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 2 (0%) / 0 of 2 (0%)</span>
        <span>2 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Context Engine</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>0 of 2 (0%) / 4 of 7 (57.1%)</span>
        <span>3 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Core Prompts and Context</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>0 of 2 (0%) / 3 of 8 (37.5%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Cross-client History and Session Parity</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>0 of 2 (0%) / 2 of 5 (40%)</span>
        <span>3 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Diagnostics, Maintenance, and Recovery</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>0 of 3 (0%) / 4 of 10 (40%)</span>
        <span>6 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Memory</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 6 of 13 (46.2%)</span>
        <span>7 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Session Routing</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>0 of 2 (0%) / 1 of 4 (25%)</span>
        <span>3 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Token Management</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>0 of 3 (0%) / 2 of 10 (20%)</span>
        <span>8 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Transcript Persistence</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 2 (0%) / 0 of 2 (0%)</span>
        <span>2 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="Signal - 5 areas">
    <p className="maturity-readiness-summary">5 needs review</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Access and Identity</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 6 (0%) / 0 of 6 (0%)</span>
        <span>6 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Channel Setup and Operations</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 7 (0%) / 0 of 7 (0%)</span>
        <span>7 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Conversation Routing and Delivery</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 1 (0%) / 0 of 1 (0%)</span>
        <span>1 capability gap</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Media and Rich Content</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 7 (0%) / 0 of 7 (0%)</span>
        <span>7 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Native Controls and Approvals</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 3 (0%) / 0 of 3 (0%)</span>
        <span>3 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="Slack - 5 areas">
    <p className="maturity-readiness-summary">5 needs review</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Access and Identity</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 1 (0%) / 0 of 1 (0%)</span>
        <span>1 capability gap</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Channel Setup and Operations</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 10 (0%) / 0 of 10 (0%)</span>
        <span>10 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Conversation Routing and Delivery</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Media and Rich Content</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 1 (0%) / 0 of 1 (0%)</span>
        <span>1 capability gap</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Native Controls and Approvals</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 8 (0%) / 0 of 8 (0%)</span>
        <span>8 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="Telegram - 5 areas">
    <p className="maturity-readiness-summary">5 needs review</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Access and Identity</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 10 (0%) / 0 of 10 (0%)</span>
        <span>10 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Channel Setup and Operations</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 10 (0%) / 0 of 10 (0%)</span>
        <span>10 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Conversation Routing and Delivery</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 1 (0%) / 0 of 1 (0%)</span>
        <span>1 capability gap</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Media and Rich Content</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 1 (0%) / 0 of 1 (0%)</span>
        <span>1 capability gap</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Native Controls and Approvals</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 9 (0%) / 0 of 9 (0%)</span>
        <span>9 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="Observability - 5 areas">
    <p className="maturity-readiness-summary">3 partially reviewed / 2 needs review</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Diagnostic Collection</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>1 of 8 (12.5%) / 3 of 10 (30%)</span>
        <span>7 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Health and Repair</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>1 of 12 (8.3%) / 5 of 18 (27.8%)</span>
        <span>13 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Logging</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Session Diagnostics</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 4 (0%) / 0 of 4 (0%)</span>
        <span>4 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Telemetry Export</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>1 of 13 (7.7%) / 7 of 21 (33.3%)</span>
        <span>14 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="TUI - 5 areas">
    <p className="maturity-readiness-summary">5 needs review</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Input and Commands</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 8 (0%) / 0 of 8 (0%)</span>
        <span>8 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Local Shell Execution</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 4 (0%) / 0 of 4 (0%)</span>
        <span>4 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Rendering and Output Safety</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 4 (0%) / 0 of 4 (0%)</span>
        <span>4 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Runtime Modes</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 14 (0%) / 0 of 14 (0%)</span>
        <span>14 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Session Management</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 3 (0%) / 0 of 3 (0%)</span>
        <span>3 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="Voice and realtime talk - 6 areas">
    <p className="maturity-readiness-summary">6 needs review</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Native App Talk</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 4 (0%) / 0 of 4 (0%)</span>
        <span>4 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Realtime Talk Sessions</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 11 (0%) / 0 of 11 (0%)</span>
        <span>11 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Speech and Transcription</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Talk Observability</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Talk Providers</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 7 (0%) / 0 of 7 (0%)</span>
        <span>7 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Voice Wake and Routing</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 4 (0%) / 0 of 4 (0%)</span>
        <span>4 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="Voice Call channel - 5 areas">
    <p className="maturity-readiness-summary">5 needs review</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Access and Identity</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 1 (0%) / 0 of 1 (0%)</span>
        <span>1 capability gap</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Channel Setup and Operations</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 2 (0%) / 0 of 2 (0%)</span>
        <span>2 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Conversation Routing and Delivery</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 1 (0%) / 0 of 1 (0%)</span>
        <span>1 capability gap</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Media and Rich Content</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 2 (0%) / 0 of 2 (0%)</span>
        <span>2 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Realtime Voice and Calls</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 2 (0%) / 0 of 2 (0%)</span>
        <span>2 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="watchOS companion surfaces - 5 areas">
    <p className="maturity-readiness-summary">5 needs review</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Delivery and Recovery</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 7 (0%) / 0 of 7 (0%)</span>
        <span>7 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Distribution and Support</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 6 (0%) / 0 of 6 (0%)</span>
        <span>6 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Exec Approvals</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 3 (0%) / 0 of 3 (0%)</span>
        <span>3 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Notifications and Replies</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 7 (0%) / 0 of 7 (0%)</span>
        <span>7 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Watch App UI</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 3 (0%) / 0 of 3 (0%)</span>
        <span>3 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="Web search tools - 4 areas">
    <p className="maturity-readiness-summary">2 needs review / 2 partially reviewed</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Network Safety</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 4 (0%) / 0 of 4 (0%)</span>
        <span>4 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Search Providers</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>2 of 19 (10.5%) / 2 of 19 (10.5%)</span>
        <span>17 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Setup and Diagnostics</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 9 (0%) / 0 of 9 (0%)</span>
        <span>9 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Tool Availability and Fetch</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>2 of 11 (18.2%) / 3 of 12 (25%)</span>
        <span>9 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="WhatsApp - 5 areas">
    <p className="maturity-readiness-summary">5 needs review</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Access and Identity</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 7 (0%) / 0 of 7 (0%)</span>
        <span>7 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Channel Setup and Operations</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 5 (0%) / 0 of 5 (0%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Conversation Routing and Delivery</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 4 (0%) / 0 of 4 (0%)</span>
        <span>4 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Media and Rich Content</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 2 (0%) / 0 of 2 (0%)</span>
        <span>2 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Native Controls and Approvals</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 2 (0%) / 0 of 2 (0%)</span>
        <span>2 capability gaps</span>
      </div>
    </div>
  </Accordion>

  <Accordion title="Windows via WSL2 - 6 areas">
    <p className="maturity-readiness-summary">5 needs review / 1 partially reviewed</p>
    <div className="maturity-readiness-list">
      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Browser and Control UI</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 6 (0%) / 0 of 6 (0%)</span>
        <span>6 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">CLI</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 8 (0%) / 0 of 8 (0%)</span>
        <span>8 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Diagnostics and Repair</span>
          <span className="maturity-readiness-status maturity-readiness-status-partially-reviewed">Partially reviewed - Full taxonomy validation</span>
        </div>
        <span>1 of 6 (16.7%) / 3 of 8 (37.5%)</span>
        <span>5 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Gateway Access and Exposure</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 11 (0%) / 0 of 11 (0%)</span>
        <span>11 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">Gateway Service Lifecycle</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 10 (0%) / 0 of 10 (0%)</span>
        <span>10 capability gaps</span>
      </div>
      <div className="maturity-readiness-row">
        <div className="maturity-readiness-area">
          <span className="maturity-readiness-title">WSL Setup</span>
          <span className="maturity-readiness-status maturity-readiness-status-needs-review">Needs review - Full taxonomy validation</span>
        </div>
        <span>0 of 6 (0%) / 0 of 6 (0%)</span>
        <span>6 capability gaps</span>
      </div>
    </div>
  </Accordion>

</AccordionGroup>

> Last updated: 2026-06-22
