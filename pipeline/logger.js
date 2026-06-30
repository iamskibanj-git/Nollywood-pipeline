import fs from 'node:fs';
import path from 'node:path';

export function createRunLogger({ logsDir = 'logs', date = new Date() } = {}) {
  fs.mkdirSync(logsDir, { recursive: true });
  const dateStamp = toDateStamp(date);
  const logPath = path.join(logsDir, `run_${dateStamp}.log`);

  const write = (level, message, details = null) => {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${level}] ${message}${details ? ` ${formatDetails(details)}` : ''}`;
    if (level === 'ERROR') console.error(line);
    else if (level === 'WARN') console.warn(line);
    else console.log(line);
    fs.appendFileSync(logPath, `${line}\n`, 'utf8');
  };

  return {
    logPath,
    info: (message, details) => write('INFO', message, details),
    warn: (message, details) => write('WARN', message, details),
    error: (message, details) => write('ERROR', message, details),
    stageStart: (stage) => write('INFO', `Stage start: ${stage}`),
    stageEnd: (stage, details) => write('INFO', `Stage end: ${stage}`, details),
  };
}

function toDateStamp(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function formatDetails(details) {
  if (details instanceof Error) return details.stack || details.message;
  if (typeof details === 'string') return details;
  try {
    return JSON.stringify(details);
  } catch (_) {
    return String(details);
  }
}
