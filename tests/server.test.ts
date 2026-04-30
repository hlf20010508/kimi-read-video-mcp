import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import {
  analyzeLocalVideo,
  buildApiHeaders,
  buildChatRequestBody,
  createServer,
  detectProviderFromBaseUrl,
  resolveApiConfig,
  type ApiConfig,
} from '../src/server.js';

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number; } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

async function tmpVideoFile() {
  const filePath = join(tmpdir(), `kimi-read-video-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`);
  await writeFile(filePath, 'fake video bytes', 'utf8');
  return filePath;
}

function testConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    apiKey: 'test-key',
    provider: 'moonshot',
    baseUrl: 'https://api.moonshot.ai/v1',
    model: 'kimi-k2.6',
    ...overrides,
  };
}

describe('config helpers', () => {
  it('defaults to moonshot when base url is omitted', () => {
    expect(resolveApiConfig({ KIMI_API_KEY: 'key' })).toEqual({
      apiKey: 'key',
      provider: 'moonshot',
      baseUrl: 'https://api.moonshot.ai/v1',
      model: 'kimi-k2.6',
    });
  });

  it('infers coding from the base url', () => {
    expect(detectProviderFromBaseUrl('https://api.kimi.com/coding/v1')).toBe('coding');
    expect(resolveApiConfig({
      KIMI_API_KEY: 'key',
      KIMI_API_BASE_URL: 'https://api.kimi.com/coding/v1',
      KIMI_API_MODEL: 'kimi-for-coding',
    })).toEqual({
      apiKey: 'key',
      provider: 'coding',
      baseUrl: 'https://api.kimi.com/coding/v1',
      model: 'kimi-for-coding',
    });
  });

  it('accepts an optional provider override when base url is omitted', () => {
    expect(resolveApiConfig({
      KIMI_API_KEY: 'key',
      KIMI_API_PROVIDER: 'coding',
    })).toEqual({
      apiKey: 'key',
      provider: 'coding',
      baseUrl: 'https://api.kimi.com/coding/v1',
      model: 'kimi-for-coding',
    });
  });

  it('adds the coding user agent automatically', () => {
    expect(buildApiHeaders(testConfig({
      provider: 'coding',
      baseUrl: 'https://api.kimi.com/coding/v1',
      model: 'kimi-for-coding',
    }), { jsonBody: {} })).toMatchObject({
      Authorization: 'Bearer test-key',
      'Content-Type': 'application/json',
      'User-Agent': 'KimiCLI/1.39.0',
    });
  });
});

describe('chat body normalization', () => {
  it('omits empty assistant content when tool calls are present', () => {
    const body = buildChatRequestBody([
      {
        role: 'assistant',
        content: [],
        tool_calls: [{
          id: 'read-video-input',
          type: 'function',
          function: {
            name: 'ReadVideoFile',
            arguments: '{"path":"/tmp/video.mp4"}',
          },
        }],
      },
      {
        role: 'tool',
        tool_call_id: 'read-video-input',
        content: [
          { type: 'text', text: '<video path="/tmp/video.mp4">' },
          { type: 'video_url', video_url: { url: 'ms://file-1', id: null } },
          { type: 'text', text: '</video> Loaded video file.' },
        ],
      },
      { role: 'user', content: 'Describe this video.' },
    ], { config: testConfig({ provider: 'coding', baseUrl: 'https://api.kimi.com/coding/v1', model: 'kimi-for-coding' }) });

    expect(body.messages[0]).toEqual({
      role: 'assistant',
      tool_calls: [{
        id: 'read-video-input',
        type: 'function',
        function: {
          name: 'ReadVideoFile',
          arguments: '{"path":"/tmp/video.mp4"}',
        },
      }],
    });
  });
});

describe('video analysis flow', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('routes coding video through a synthetic tool-result conversation', async () => {
    const filePath = await tmpVideoFile();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'file-123' }))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { role: 'assistant', content: 'A black screen.' } }] }));

    const result = await analyzeLocalVideo(filePath, {
      prompt: 'Describe this video in one short sentence.',
      config: testConfig({ provider: 'coding', baseUrl: 'https://api.kimi.com/coding/v1', model: 'kimi-for-coding' }),
    });

    const [, chatInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(String(chatInit.body));

    expect(body.messages[0]).toEqual({
      role: 'assistant',
      tool_calls: [{
        id: 'read-video-input',
        type: 'function',
        function: {
          name: 'ReadVideoFile',
          arguments: JSON.stringify({ path: filePath }),
        },
      }],
    });
    expect(body.messages[1].content[1]).toEqual({
      type: 'video_url',
      video_url: { url: 'ms://file-123', id: null },
    });
    expect(result.note).toContain('synthetic tool-result');
  });

  it('routes moonshot video through a direct user video_url part', async () => {
    const filePath = await tmpVideoFile();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'file-456' }))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { role: 'assistant', content: 'A black screen.' } }] }));

    const result = await analyzeLocalVideo(filePath, {
      config: testConfig(),
    });

    const [, chatInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(String(chatInit.body));

    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content[0]).toEqual({
      type: 'video_url',
      video_url: { url: 'ms://file-456', id: null },
    });
    expect(result.note).toContain('Uploaded file_id: file-456');
    expect(result.note).not.toContain('synthetic tool-result');
  });

  it('returns only analysis text from the MCP tool output', async () => {
    const filePath = await tmpVideoFile();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'file-789' }))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { role: 'assistant', content: 'A black screen.' } }] }));

    vi.stubEnv('KIMI_API_KEY', 'test-key');
    vi.stubEnv('KIMI_API_BASE_URL', 'https://api.kimi.com/coding/v1');
    vi.stubEnv('KIMI_API_MODEL', 'kimi-for-coding');

    const server = createServer() as unknown as {
      _registeredTools: Record<string, {
        handler: (args: { path: string; prompt?: string; }, extra?: unknown) => Promise<{
          content: Array<{ type: string; text: string; }>;
          isError?: boolean;
        }>;
      }>;
    };
    const result = await server._registeredTools.kimi_read_video.handler({
      path: filePath,
      prompt: 'Describe this video in one short sentence.',
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: 'text', text: 'A black screen.' }]);
  });
});