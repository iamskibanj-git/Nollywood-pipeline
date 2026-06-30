import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function resolveAnthropicApiKey({ logger = console } = {}) {
  loadLocalEnv();
  const envKey = firstNonEmpty(process.env.ANTHROPIC_API_KEY, process.env.CLAUDE_API_KEY);
  if (envKey) {
    logger?.info?.('[CREDS] Using Anthropic key from environment.');
    return envKey;
  }

  const appConfig = readExistingAppConfig();
  const appKey = firstNonEmpty(
    appConfig?.claudeApiKey,
    appConfig?.anthropicApiKey,
    appConfig?.anthropic_api_key,
    appConfig?.ANTHROPIC_API_KEY,
    appConfig?.CLAUDE_API_KEY
  );
  if (appKey) {
    logger?.info?.('[CREDS] Using Claude key from existing app config.');
    return appKey;
  }

  return '';
}

export function getExistingAppConfigPath() {
  return getExistingAppConfigPaths()[0];
}

export function getExistingAppConfigPaths() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return unique([
    path.join(appData, 'nollywood-ai-pipeline', 'config.json'),
    path.join(appData, 'Nollywood AI Pipeline', 'config.json'),
    path.join(appData, 'Electron', 'config.json'),
    path.join(appData, 'nollywood-ai-pipeline_draft', 'config.json'),
  ]);
}

function readExistingAppConfig() {
  for (const configPath of getExistingAppConfigPaths()) {
    try {
      if (!fs.existsSync(configPath)) continue;
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (_) {
      // Try the next known Electron-store location.
    }
  }
  return null;
}

function loadLocalEnv() {
  const candidates = [
    path.resolve('.env'),
    path.resolve('pipeline/.env'),
  ];
  for (const envPath of candidates) {
    try {
      if (!fs.existsSync(envPath)) continue;
      const text = fs.readFileSync(envPath, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!match) continue;
        const key = match[1];
        if (process.env[key]) continue;
        process.env[key] = stripEnvQuotes(match[2]);
      }
    } catch (_) {
      // Environment files are optional.
    }
  }
}

function firstNonEmpty(...values) {
  return values.map(value => String(value || '').trim()).find(Boolean) || '';
}

function stripEnvQuotes(value) {
  const text = String(value || '').trim();
  const quoted = text.match(/^(['"])([\s\S]*)\1$/);
  return quoted ? quoted[2] : text;
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}
