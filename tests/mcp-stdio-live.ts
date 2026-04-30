import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { join, resolve } from 'node:path';
import process from 'node:process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolveApiConfig } from '../src/server.js';
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

function extractText(content: unknown) {
  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .filter(part => part && typeof part === 'object' && (part as { type?: string; }).type === 'text')
    .map(part => String((part as { text?: unknown; }).text || ''))
    .join('\n');
}

async function main() {
  const envPath = resolve(process.cwd(), '.env');
  const envFile = await loadEnvFile(envPath);
  const config = resolveApiConfig({ ...process.env, ...envFile });
  const tempDir = await mkdtemp(join(tmpdir(), 'kimi-read-video-mcp-live-'));
  const videoPath = join(tempDir, 'tiny-black.mp4');
  const client = new Client({ name: 'kimi-read-video-mcp-live', version: '0.0.0' });
  let stderr = '';

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve(process.cwd(), 'bin/kimi-read-video-mcp')],
    cwd: process.cwd(),
    env: { ...process.env, ...envFile },
    stderr: 'pipe',
  });

  transport.stderr?.on('data', chunk => {
    stderr += chunk.toString();
  });

  try {
    await writeTinyBlackVideo(videoPath);
    await client.connect(transport);

    const listed = await client.listTools();
    const hasOnlyReadVideo = listed.tools.length === 1 && listed.tools[0]?.name === 'kimi_read_video';
    const result = await client.callTool({
      name: 'kimi_read_video',
      arguments: {
        path: videoPath,
        prompt: 'Describe this video in one short sentence.',
      },
    });
    const text = extractText(result.content);
    const passed = hasOnlyReadVideo
      && !result.isError
      && Boolean(text.trim());

    console.log(JSON.stringify({
      env: {
        provider: config.provider,
        baseUrl: config.baseUrl,
        model: config.model,
        apiKey: config.apiKey ? 'set' : 'missing',
      },
      mcp: {
        serverName: client.getServerVersion()?.name,
        serverVersion: client.getServerVersion()?.version,
        hasOnlyReadVideo,
        passed,
        text: text.slice(0, 400),
        stderr: stderr.slice(0, 400),
      },
    }, null, 2));

    process.exitCode = passed ? 0 : 1;
  } finally {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});