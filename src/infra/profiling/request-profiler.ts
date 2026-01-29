/**
 * Request profiling utilities for measuring latency across the message pipeline.
 * 
 * Usage:
 *   const profiler = createRequestProfiler();
 *   profiler.mark("telegram_received");
 *   // ... download media ...
 *   profiler.mark("media_downloaded");
 *   // ... invoke agent ...
 *   profiler.mark("agent_invoked");
 *   // ... get response ...
 *   profiler.mark("response_ready");
 *   profiler.mark("response_sent");
 *   
 *   const report = profiler.getReport();
 *   // { totalMs: 2500, segments: [...], marks: [...] }
 */

export interface ProfileMark {
  name: string;
  timestamp: number;
  delta?: number; // ms since previous mark
}

export interface ProfileSegment {
  from: string;
  to: string;
  durationMs: number;
  percentage: number;
}

export interface ProfileReport {
  requestId: string;
  startTime: number;
  endTime: number;
  totalMs: number;
  marks: ProfileMark[];
  segments: ProfileSegment[];
}

export interface RequestProfiler {
  mark(name: string): void;
  getReport(): ProfileReport;
  toLogString(): string;
}

let requestCounter = 0;

export function createRequestProfiler(requestId?: string): RequestProfiler {
  const id = requestId ?? `req_${Date.now()}_${++requestCounter}`;
  const marks: ProfileMark[] = [];
  const startTime = Date.now();

  return {
    mark(name: string) {
      const timestamp = Date.now();
      const prevMark = marks[marks.length - 1];
      const delta = prevMark ? timestamp - prevMark.timestamp : 0;
      marks.push({ name, timestamp, delta });
    },

    getReport(): ProfileReport {
      const endTime = marks[marks.length - 1]?.timestamp ?? startTime;
      const totalMs = endTime - startTime;

      const segments: ProfileSegment[] = [];
      for (let i = 1; i < marks.length; i++) {
        const from = marks[i - 1]!;
        const to = marks[i]!;
        const durationMs = to.timestamp - from.timestamp;
        segments.push({
          from: from.name,
          to: to.name,
          durationMs,
          percentage: totalMs > 0 ? Math.round((durationMs / totalMs) * 100) : 0,
        });
      }

      return {
        requestId: id,
        startTime,
        endTime,
        totalMs,
        marks,
        segments,
      };
    },

    toLogString(): string {
      const report = this.getReport();
      const lines = [
        `[profiler] ${report.requestId} total=${report.totalMs}ms`,
        ...report.segments.map(
          (s) => `  ${s.from} → ${s.to}: ${s.durationMs}ms (${s.percentage}%)`
        ),
      ];
      return lines.join("\n");
    },
  };
}

/**
 * Global profiling configuration
 */
export interface ProfilingConfig {
  enabled: boolean;
  logThresholdMs: number; // Only log if total exceeds this
  includeInResponse: boolean; // Include timing in response metadata
}

const defaultConfig: ProfilingConfig = {
  enabled: false,
  logThresholdMs: 1000,
  includeInResponse: false,
};

let globalConfig: ProfilingConfig = { ...defaultConfig };

export function setProfilingConfig(config: Partial<ProfilingConfig>): void {
  globalConfig = { ...globalConfig, ...config };
}

export function getProfilingConfig(): ProfilingConfig {
  return { ...globalConfig };
}

export function isProfilingEnabled(): boolean {
  return globalConfig.enabled;
}
