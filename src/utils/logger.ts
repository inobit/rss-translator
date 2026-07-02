import type { WorkerEnv } from '../types';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function getLevel(env?: WorkerEnv): LogLevel {
  const raw = env?.LOG_LEVEL ?? 'info';
  return raw in LEVEL_ORDER ? (raw as LogLevel) : 'info';
}

function prefix(level: LogLevel): string {
  const now = new Date().toISOString();
  return `[${now}] [${level.toUpperCase()}]`;
}

export function createLogger(env?: WorkerEnv) {
  const currentLevel = LEVEL_ORDER[getLevel(env)];

  return {
    debug(msg: string, data?: unknown) {
      if (currentLevel <= LEVEL_ORDER.debug) {
        console.log(`${prefix('debug')} ${msg}`, data ?? '');
      }
    },
    info(msg: string, data?: unknown) {
      if (currentLevel <= LEVEL_ORDER.info) {
        console.log(`${prefix('info')} ${msg}`, data ?? '');
      }
    },
    warn(msg: string, data?: unknown) {
      if (currentLevel <= LEVEL_ORDER.warn) {
        console.warn(`${prefix('warn')} ${msg}`, data ?? '');
      }
    },
    error(msg: string, data?: unknown) {
      if (currentLevel <= LEVEL_ORDER.error) {
        console.error(`${prefix('error')} ${msg}`, data ?? '');
      }
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;
