/**
 * Stderr-only logger. The MCP stdio transport owns stdout — writing anything
 * else to it corrupts the JSON-RPC stream, so all logging goes to stderr.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function activeLevel(): LogLevel {
  const env = (process.env.CONTRAIL_LOG_LEVEL ?? 'info').toLowerCase();
  return (env in LEVEL_ORDER ? env : 'info') as LogLevel;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * An extra destination for log lines. The desktop app installs a file sink:
 * in a packaged GUI app stderr goes nowhere, so without this a crash leaves
 * the user nothing to send back. Never throws into the caller.
 */
export type LogSink = (line: string) => void;

let sink: LogSink | null = null;

export function setLogSink(next: LogSink | null): void {
  sink = next;
}

export function log(level: LogLevel, message: string, extra?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[activeLevel()]) return;
  const suffix = extra === undefined ? '' : ` ${safeJson(extra)}`;
  const line = `[contrail ${new Date().toISOString()}] ${level.toUpperCase()} ${message}${suffix}\n`;
  process.stderr.write(line);
  if (sink) {
    try {
      sink(line);
    } catch {
      // A failing log destination must never break the operation being logged.
    }
  }
}
