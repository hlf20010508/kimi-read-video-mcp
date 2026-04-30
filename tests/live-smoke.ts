import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { analyzeLocalVideo, resolveApiConfig } from '../src/server.js';
import { writeTinyBlackVideo } from './live-fixtures.js';

function parseEnvFile(content: string) {
  const parsed: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) continue;

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

async function loadEnvFile(envPath: string) {
  if (!existsSync(envPath)) {
    throw new Error(`Missing env file: ${envPath}`);
  }
  return parseEnvFile(await readFile(envPath, 'utf8'));
}

async function main() {
  const envPath = resolve(process.cwd(), '.env');
  const envFile = await loadEnvFile(envPath);
  const config = resolveApiConfig({ ...process.env, ...envFile });
  const tempDir = await mkdtemp(join(tmpdir(), 'kimi-read-video-live-'));
  const videoPath = join(tempDir, 'tiny-black.mp4');

  try {
    await writeTinyBlackVideo(videoPath);
    const result = await analyzeLocalVideo(videoPath, {
      config,
      prompt: 'Describe this video in one short sentence.',
    });
    const passed = Boolean(result.text.trim())
      && Boolean(result.note.trim())
      && (config.provider !== 'coding' || result.note.includes('synthetic tool-result'));

    console.log(JSON.stringify({
      env: {
        provider: config.provider,
        baseUrl: config.baseUrl,
        model: config.model,
        apiKey: config.apiKey ? 'set' : 'missing',
      },
      video: {
        passed,
        text: result.text.slice(0, 400),
        note: result.note.slice(0, 400),
      },
    }, null, 2));

    process.exitCode = passed ? 0 : 1;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});