# kimi-read-video-mcp

Minimal MCP server for Kimi-compatible video analysis. It exposes exactly one tool, `kimi_read_video`, and supports both the Moonshot Open Platform entrypoint and the Kimi Coding entrypoint.

The external configuration surface is intentionally small: use `KIMI_API_KEY`, `KIMI_API_BASE_URL`, and `KIMI_API_MODEL` in normal cases. The server infers the provider from the base URL by default, but you can also set `KIMI_API_PROVIDER` explicitly when a relay or third-party provider uses a URL that does not clearly identify the upstream provider.

## What It Does

- Exposes one MCP tool: `kimi_read_video`
- Uploads a local video file to the configured Kimi-compatible API
- Uses direct user-role `video_url` for moonshot-compatible endpoints
- Uses a synthetic tool-result bridge for coding-compatible endpoints, because the coding HTTP surface rejects user-role `video_url` parts

## Supported Providers

| Provider | Base URL | Typical model | Internal routing |
|----------|----------|---------------|------------------|
| `moonshot` | `https://api.moonshot.ai/v1` | `kimi-k2.6` | Direct user-role `video_url` |
| `coding` | `https://api.kimi.com/coding/v1` | `kimi-for-coding` | Synthetic tool-result `video_url` bridge |

The environment variables are the same for both providers. The difference is internal message construction, not external configuration.

## Install

Use `npx`:

```bash
npx kimi-read-video-mcp@latest
```

Or install globally:

```bash
npm install -g kimi-read-video-mcp
```

## MCP Setup

### Moonshot example

```json
{
  "mcpServers": {
    "kimi-video": {
      "command": "npx",
      "args": ["-y", "kimi-read-video-mcp@latest"],
      "env": {
        "KIMI_API_KEY": "your-api-key",
        "KIMI_API_BASE_URL": "https://api.moonshot.ai/v1",
        "KIMI_API_MODEL": "kimi-k2.6"
      }
    }
  }
}
```

### Kimi Coding example

```json
{
  "mcpServers": {
    "kimi-video": {
      "command": "npx",
      "args": ["-y", "kimi-read-video-mcp@latest"],
      "env": {
        "KIMI_API_KEY": "your-api-key",
        "KIMI_API_BASE_URL": "https://api.kimi.com/coding/v1",
        "KIMI_API_MODEL": "kimi-for-coding"
      }
    }
  }
}
```

### Relay or third-party provider example

Use `KIMI_API_PROVIDER` when the base URL belongs to a relay, gateway, or third-party provider and the URL itself does not reliably reveal whether the upstream behavior should be treated as `moonshot` or `coding`.

```json
{
  "mcpServers": {
    "kimi-video": {
      "command": "npx",
      "args": ["-y", "kimi-read-video-mcp@latest"],
      "env": {
        "KIMI_API_KEY": "your-api-key",
        "KIMI_API_BASE_URL": "https://your-relay.example.com/v1",
        "KIMI_API_MODEL": "kimi-for-coding",
        "KIMI_API_PROVIDER": "coding"
      }
    }
  }
}
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `KIMI_API_KEY` | Yes | API key for the target endpoint |
| `KIMI_API_PROVIDER` | No | Optional explicit provider override: `moonshot` or `coding` |
| `KIMI_API_BASE_URL` | No | Base URL override; if omitted, defaults to moonshot |
| `KIMI_API_MODEL` | No | Model override; if omitted, defaults to the inferred provider default |

If `KIMI_API_BASE_URL` is omitted, the server defaults to moonshot with `https://api.moonshot.ai/v1` and `kimi-k2.6`.

Provider resolution works in this order:

1. If `KIMI_API_PROVIDER` is set, the server uses it directly.
2. Otherwise, if `KIMI_API_BASE_URL` contains `/coding`, the server treats it as `coding`.
3. Otherwise, the server falls back to `moonshot`.

When the effective provider is `coding`, the server automatically adds `User-Agent: KimiCLI/1.39.0` to requests.

## Tool

### `kimi_read_video`

Analyze a local video file.

Arguments:

- `path`: path to a local video file
- `prompt`: optional instruction such as `Describe this video in one short sentence.`
- `workFolder`: optional working directory for resolving relative paths

## Important Limits

- This project is intentionally minimal and only implements video analysis.
- It does not expose image analysis, web search, shell, file editing, or agent workflows.
- It does not implement `ffmpeg` / `ffprobe` frame fallback. If your chosen endpoint or model does not accept the native video flow implemented here, the tool fails fast.
- Video support is inferred for `kimi-for-coding` and `kimi-k2*` models.

## Development

```bash
npm install
npm run build
npm test
```

Live tests require a local `.env` file with the same three environment variables:

```bash
npm run test:live
```

`test:live` runs:

- a direct API smoke test for local video analysis
- an SDK stdio MCP round-trip that verifies `tools/list` and `tools/call`

## License

MIT