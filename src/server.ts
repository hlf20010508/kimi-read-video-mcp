import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export type Provider = 'moonshot' | 'coding';

export interface ApiConfig {
  apiKey: string | null;
  provider: Provider;
  baseUrl: string;
  model: string;
}

interface ChatToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface ChatMessage {
  role: 'assistant' | 'tool' | 'user' | 'system';
  content?: unknown;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

interface VideoAnalysisResult {
  text: string;
  note: string;
}

const DEFAULT_PROVIDER: Provider = 'moonshot';
const DEFAULT_PROVIDER_CONFIG: Record<Provider, { baseUrl: string; model: string; }> = {
  moonshot: {
    baseUrl: 'https://api.moonshot.ai/v1',
    model: 'kimi-k2.6',
  },
  coding: {
    baseUrl: 'https://api.kimi.com/coding/v1',
    model: 'kimi-for-coding',
  },
};
const CODING_USER_AGENT = 'KimiCLI/1.39.0';
const DEFAULT_VIDEO_PROMPT = 'Describe this video clearly.';
const DIRECT_VIDEO_PART_SUPPORT: Record<Provider, boolean> = {
  moonshot: true,
  coding: false,
};
const DEFAULT_MODEL_CAPABILITIES: Record<string, string[]> = {
  'kimi-for-coding': ['video_in'],
};
const VIDEO_MIME_MAP: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.webm': 'video/webm',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.3gp': 'video/3gpp',
  '.m4v': 'video/mp4',
};

function normalizeBaseUrl(baseUrl?: string | null) {
  return (baseUrl || '').replace(/\/$/, '');
}

function normalizeProvider(provider?: string | null): Provider {
  const normalized = (provider || '').trim().toLowerCase();
  if (!normalized) return DEFAULT_PROVIDER;
  if (normalized === 'moonshot' || normalized === 'coding') {
    return normalized;
  }
  throw new Error(`Unsupported KIMI_API_PROVIDER: ${provider}`);
}

export function detectProviderFromBaseUrl(baseUrl?: string | null): Provider {
  const normalized = normalizeBaseUrl(baseUrl).toLowerCase();
  if (!normalized) return DEFAULT_PROVIDER;
  if (normalized.includes('/coding')) return 'coding';
  return 'moonshot';
}

export function resolveApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const apiKey = env.KIMI_API_KEY || null;
  const explicitBaseUrl = env.KIMI_API_BASE_URL || null;
  const explicitModel = env.KIMI_API_MODEL || null;
  const inferredProvider = explicitBaseUrl ? detectProviderFromBaseUrl(explicitBaseUrl) : DEFAULT_PROVIDER;
  const provider = normalizeProvider(env.KIMI_API_PROVIDER || inferredProvider);
  const defaults = DEFAULT_PROVIDER_CONFIG[provider];

  return {
    apiKey,
    provider,
    baseUrl: normalizeBaseUrl(explicitBaseUrl || defaults.baseUrl),
    model: explicitModel || defaults.model,
  };
}

export function buildApiHeaders(config: ApiConfig, options: { jsonBody?: unknown; headers?: Record<string, string>; } = {}) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey || ''}`,
    ...(config.provider === 'coding' ? { 'User-Agent': CODING_USER_AGENT } : {}),
    ...(options.headers || {}),
  };

  if (options.jsonBody !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  return headers;
}

function ensureApiKey(config: ApiConfig) {
  if (!config.apiKey) {
    throw new Error('Missing KIMI_API_KEY');
  }
}

function buildApiUrl(config: ApiConfig, path: string) {
  return `${config.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
}

function hasOnlyEmptyTextParts(content: unknown) {
  if (typeof content === 'string') {
    return content.trim() === '';
  }
  if (!Array.isArray(content)) {
    return false;
  }
  if (content.length === 0) {
    return true;
  }
  return content.every(part => {
    if (!part || typeof part !== 'object') return false;
    const candidate = part as { type?: string; text?: unknown; };
    return candidate.type === 'text' && !String(candidate.text || '').trim();
  });
}

function normalizeMessageForApi(message: ChatMessage) {
  if (message.role === 'assistant' && message.tool_calls?.length && hasOnlyEmptyTextParts(message.content)) {
    const { content, ...rest } = message;
    return rest;
  }
  return message;
}

export function buildChatRequestBody(messages: ChatMessage[], options: { config?: ApiConfig; } = {}) {
  const config = options.config || resolveApiConfig();
  return {
    model: config.model,
    messages: messages.map(normalizeMessageForApi),
  };
}

async function kimiApiRequest(path: string, options: {
  method?: string;
  config?: ApiConfig;
  jsonBody?: unknown;
  body?: BodyInit | null;
  formData?: FormData;
} = {}) {
  const config = options.config || resolveApiConfig();
  ensureApiKey(config);

  const response = await fetch(buildApiUrl(config, path), {
    method: options.method || 'GET',
    headers: buildApiHeaders(config, options),
    body: options.formData || (options.jsonBody !== undefined ? JSON.stringify(options.jsonBody) : options.body),
  });

  if (response.status === 401) {
    throw new Error('KIMI_API_KEY invalid or missing');
  }
  if (!response.ok) {
    throw new Error(`Kimi API error ${response.status}: ${await response.text()}`);
  }

  return response.json();
}

async function kimiChat(messages: ChatMessage[], options: { config?: ApiConfig; } = {}) {
  const data = await kimiApiRequest('/chat/completions', {
    method: 'POST',
    config: options.config,
    jsonBody: buildChatRequestBody(messages, options),
  });
  return data.choices?.[0]?.message;
}

function getVideoDescriptor(filePath: string) {
  const extension = extname(filePath).toLowerCase();
  const mime = VIDEO_MIME_MAP[extension];
  if (!mime) {
    throw new Error(`Unsupported video type for ${filePath}`);
  }

  return {
    kind: 'video' as const,
    mime,
    purpose: 'video',
  };
}

function resolveInputPath(inputPath: string, workFolder?: string) {
  if (isAbsolute(inputPath)) {
    return inputPath;
  }
  return resolve(workFolder || process.cwd(), inputPath);
}

function supportsVideoInput(config: ApiConfig) {
  if (DEFAULT_MODEL_CAPABILITIES[config.model]?.includes('video_in')) {
    return true;
  }
  return config.model.startsWith('kimi-k2');
}

function supportsNativeVideoAnalysis(config: ApiConfig) {
  return supportsVideoInput(config)
    && (DIRECT_VIDEO_PART_SUPPORT[config.provider] || config.provider === 'coding');
}

function escapeTagAttribute(value: string) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildNativeVideoToolMessages(filePath: string, mediaPart: { type: 'video_url'; video_url: { url: string; id: null; }; }, userPrompt: string): ChatMessage[] {
  const toolCallId = 'read-video-input';
  const escapedPath = escapeTagAttribute(filePath);

  return [
    {
      role: 'assistant',
      content: [],
      tool_calls: [{
        id: toolCallId,
        type: 'function',
        function: {
          name: 'ReadVideoFile',
          arguments: JSON.stringify({ path: filePath }),
        },
      }],
    },
    {
      role: 'tool',
      tool_call_id: toolCallId,
      content: [
        { type: 'text', text: `<video path="${escapedPath}">` },
        mediaPart,
        { type: 'text', text: '</video> Loaded video file.' },
      ],
    },
    {
      role: 'user',
      content: userPrompt,
    },
  ];
}

function extractMessageText(message: { content?: unknown; } | undefined) {
  if (!message) {
    return '(no response)';
  }
  if (typeof message.content === 'string' && message.content.trim()) {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    const text = message.content
      .filter(part => part && typeof part === 'object' && (part as { type?: string; }).type === 'text')
      .map(part => String((part as { text?: unknown; }).text || ''))
      .join('\n')
      .trim();
    return text || '(no response)';
  }
  return '(no response)';
}

function buildReadVideoPrompt(prompt?: string) {
  return prompt?.trim() || DEFAULT_VIDEO_PROMPT;
}

async function uploadKimiFile(filePath: string, options: { config?: ApiConfig; } = {}) {
  const config = options.config || resolveApiConfig();
  const descriptor = getVideoDescriptor(filePath);
  const formData = new FormData();
  const blob = new Blob([await readFile(filePath)], { type: descriptor.mime });
  formData.append('purpose', descriptor.purpose);
  formData.append('file', blob, basename(filePath));

  return kimiApiRequest('/files', {
    method: 'POST',
    config,
    formData,
  });
}

export async function analyzeLocalVideo(inputPath: string, options: { config?: ApiConfig; prompt?: string; workFolder?: string; } = {}): Promise<VideoAnalysisResult> {
  const config = options.config || resolveApiConfig();
  const filePath = resolveInputPath(inputPath, options.workFolder);
  getVideoDescriptor(filePath);

  if (!supportsNativeVideoAnalysis(config)) {
    throw new Error(`The configured model does not expose native video input for this MCP. Current model=${config.model}, provider=${config.provider}.`);
  }

  const uploaded = await uploadKimiFile(filePath, { config });
  const mediaPart = { type: 'video_url' as const, video_url: { url: `ms://${uploaded.id}`, id: null } };
  const userPrompt = buildReadVideoPrompt(options.prompt);

  const { messages, note } = config.provider === 'coding'
    ? {
      messages: buildNativeVideoToolMessages(filePath, mediaPart, userPrompt),
      note: `Uploaded file_id: ${uploaded.id}\n\nUsed native video_url through a synthetic tool-result conversation because provider=coding rejects user-role video_url parts over direct HTTP.`,
    }
    : {
      messages: [{
        role: 'user' as const,
        content: [
          mediaPart,
          { type: 'text', text: userPrompt },
        ],
      }],
      note: `Uploaded file_id: ${uploaded.id}`,
    };

  const message = await kimiChat(messages, { config });
  return {
    text: extractMessageText(message),
    note,
  };
}

function buildToolResponseText(result: VideoAnalysisResult) {
  return result.text;
}

export function createServer() {
  const server = new McpServer({ name: 'kimi-read-video-mcp', version: '0.1.0' });

  server.tool('kimi_read_video', 'Analyze a local video file using the configured Kimi-compatible API.', {
    path: z.string().describe('Path to a local video file'),
    prompt: z.string().optional().describe('Optional natural-language instruction for how to analyze the video'),
    workFolder: z.string().optional().describe('Optional working directory used to resolve relative paths'),
  }, async ({ path, prompt, workFolder }) => {
    try {
      const result = await analyzeLocalVideo(path, {
        config: resolveApiConfig(),
        prompt,
        workFolder,
      });
      return {
        content: [{ type: 'text', text: buildToolResponseText(result) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      };
    }
  });

  return server;
}

export async function startServer() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

const isDirectExecution = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  await startServer();
}