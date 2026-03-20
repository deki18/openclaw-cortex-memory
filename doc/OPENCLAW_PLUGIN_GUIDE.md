# OpenClaw Plugin Development Guide

This document summarizes the key rules, specifications, and best practices for developing OpenClaw plugins, based on practical debugging experience.

## 1. Plugin Installation Path

```
~/.openclaw/extensions/<plugin-name>/
```

Plugins must be installed in the `extensions` directory under the OpenClaw configuration root.

## 2. Required Plugin Structure

```
<plugin-name>/
├── openclaw.plugin.json    # Plugin manifest (REQUIRED at root)
├── package.json            # Node.js package config
├── index.ts                # Entry point (TypeScript source)
├── dist/
│   └── index.js           # Compiled entry point
│   └── openclaw.plugin.json # Copy of manifest (for compiled version)
├── tsconfig.json          # TypeScript config
└── ... other files
```

### Critical Rules

1. **`openclaw.plugin.json` must be at the project root**
2. **Do NOT duplicate manifest files in multiple directories** (causes "duplicate plugin id" error)
3. **Build script should only copy manifest to `dist/`**, not to `src/`

## 3. Plugin Manifest (openclaw.plugin.json)

### Required Fields

```json
{
  "id": "@scope/plugin-name",
  "name": "Plugin Display Name",
  "version": "1.0.0",
  "description": "Plugin description",
  "main": "dist/index.js",
  "configSchema": {
    "type": "object",
    "properties": {
      "enabled": { "type": "boolean", "default": true }
    }
  }
}
```

### Hook Definitions

```json
{
  "hooks": [
    {
      "event": "onMessage",
      "handler": "handleMessage"
    },
    {
      "event": "onSessionEnd",
      "handler": "handleSessionEnd"
    },
    {
      "event": "onTimer",
      "handler": "handleTimer",
      "interval": 60000
    }
  ]
}
```

### Event Names

| Event | Description | Trigger |
|-------|-------------|---------|
| `onMessage` | Message hook | Every user/assistant message |
| `onSessionEnd` | Session end | When conversation session ends |
| `onTimer` | Timer hook | Periodic execution |

## 4. Entry Point (index.ts)

### Required Exports

```typescript
export async function register(api: PluginApi): Promise<void> {
  // Plugin initialization
}

export async function unregister(): Promise<void> {
  // Cleanup on plugin unload
}
```

### PluginApi Interface

```typescript
interface PluginApi {
  id: string;
  name: string;
  version: string;
  description: string;
  source: string;
  rootDir: string;           // Plugin root directory (use instead of __dirname)
  registrationMode: string;
  config: object;            // OpenClaw configuration
  pluginConfig: object;      // Plugin-specific configuration
  runtime: object;
  logger: Logger;
  
  // Registration methods
  registerTool(tool: ToolDefinition): void;
  registerHook(hook: HookDefinition): void;
  registerHttpRoute(route: RouteDefinition): void;
  registerChannel(channel: ChannelDefinition): void;
  registerProvider(provider: ProviderDefinition): void;
  registerSpeechProvider(provider: SpeechProviderDefinition): void;
  registerMediaUnderstandingProvider(provider: MediaProviderDefinition): void;
  registerImageGenerationProvider(provider: ImageProviderDefinition): void;
  registerWebSearchProvider(provider: WebSearchProviderDefinition): void;
  registerGatewayMethod(method: GatewayMethodDefinition): void;
  registerCli(cli: CliDefinition): void;
  registerService(service: ServiceDefinition): void;
  registerInteractiveHandler(handler: InteractiveHandlerDefinition): void;
  registerCommand(command: CommandDefinition): void;
  registerContextEngine(engine: ContextEngineDefinition): void;
  
  resolvePath(relativePath: string): string;
  on(event: string, handler: Function): void;
}
```

### Important Notes

1. **Use `api.rootDir` instead of `__dirname`** - `__dirname` may be undefined in some environments
2. **Access plugin config via `api.pluginConfig`** - Not from environment variables
3. **Log with `api.logger`** for consistent logging

## 5. Configuration

### Configuration Location

```
~/.openclaw/openclaw.json
```

### Plugin Configuration Structure

```json
{
  "plugins": {
    "allow": ["@scope/plugin-name"],
    "slots": {
      "memory": "@scope/plugin-name"
    },
    "entries": {
      "@scope/plugin-name": {
        "enabled": true,
        "config": {
          "embedding": {
            "provider": "openai-compatible",
            "model": "text-embedding-3-large",
            "apiKey": "${EMBEDDING_API_KEY}",
            "endpoint": "https://api.example.com/v1"
          },
          "llm": {
            "provider": "openai",
            "model": "gpt-4",
            "apiKey": "${LLM_API_KEY}"
          }
        }
      }
    }
  }
}
```

### Reading Configuration in Plugin

```typescript
export async function register(api: PluginApi): Promise<void> {
  const config = api.pluginConfig;
  const embeddingModel = config.embedding?.model;
  const llmModel = config.llm?.model;
}
```

## 6. Data Storage Paths

| Path | Description |
|------|-------------|
| `~/.openclaw/workspace/` | Core workspace directory |
| `~/.openclaw/workspace/MEMORY.md` | Long-term memory (loaded in private chats) |
| `~/.openclaw/workspace/memory/*.md` | Daily summary files |
| `~/.openclaw/workspace/memory/sessions/archive/` | Archived session files |
| `~/.openclaw/agents/main/sessions/*.jsonl` | Session records |
| `~/.openclaw/extensions/<plugin>/data/` | Plugin-specific data |

## 7. Session File Format (JSONL)

### Structure

Each line is a JSON object:

```json
{"sessionId": "xxx", "timestamp": "2026-03-20T10:00:00Z", "messages": [...]}
```

### Message Format

```json
{
  "messages": [
    {"role": "user", "content": "Hello"},
    {"role": "assistant", "content": "Hi there!"}
  ],
  "timestamp": "2026-03-20T10:00:00Z",
  "sessionId": "session-123"
}
```

### Content Extraction Priority

When processing session files, try these fields in order:
1. `content`
2. `summary`
3. `text`
4. `message`
5. `messages` array (join with role prefixes)
6. JSON dump of entire object

## 8. Build Configuration

### package.json Scripts

```json
{
  "scripts": {
    "build": "tsc && node -e \"require('fs').copyFileSync('openclaw.plugin.json', 'dist/openclaw.plugin.json')\"",
    "dev": "tsc --watch"
  }
}
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "outDir": "./dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["index.ts"],
  "exclude": ["node_modules", "dist", "venv"]
}
```

## 9. Python Backend Integration

### Virtual Environment

Create venv in project root:

```bash
python -m venv venv
source venv/bin/activate  # Linux/Mac
.\venv\Scripts\activate   # Windows
pip install -r requirements.txt
```

### Starting Python Service

```typescript
import { spawn } from 'child_process';
import path from 'path';

function startPythonService(api: PluginApi): ChildProcess {
  const venvPython = path.join(
    api.rootDir,
    'venv',
    process.platform === 'win32' ? 'Scripts' : 'bin',
    'python'
  );
  
  return spawn(venvPython, ['-m', 'api.server'], {
    cwd: api.rootDir,
    env: { ...process.env, PYTHONUNBUFFERED: '1' }
  });
}
```

### Requirements

- All Python dependencies must be in `requirements.txt`
- Install to project-local `venv/`, not globally
- Add `venv/` to `.gitignore`

## 10. Common Errors and Solutions

### Error: "plugin not found"

**Cause:** Manifest file not in correct location

**Solution:**
1. Ensure `openclaw.plugin.json` is at project root
2. Run `npm run build` to compile and copy manifest
3. Restart OpenClaw gateway

### Error: "duplicate plugin id detected"

**Cause:** Manifest files in multiple directories

**Solution:**
1. Remove `openclaw.plugin.json` from `src/` directory
2. Only copy manifest to `dist/` in build script

### Error: "plugin id mismatch"

**Cause:** `package.json` name doesn't match manifest `id`

**Solution:**
1. Ensure `package.json` name matches `openclaw.plugin.json` id
2. Or remove `entrypoint` field from manifest

### Error: "__dirname is not defined"

**Cause:** ES modules or certain runtime environments

**Solution:** Use `api.rootDir` instead of `__dirname`

```typescript
// Wrong
const dataPath = path.join(__dirname, 'data');

// Correct
const dataPath = path.join(api.rootDir, 'data');
```

### Error: "ModuleNotFoundError: No module named 'xxx'"

**Cause:** Python dependency not installed

**Solution:**
1. Add dependency to `requirements.txt`
2. Reinstall: `pip install -r requirements.txt`

### Error: Hook not triggering

**Cause:** Event name mismatch

**Solution:**
1. Check hook event names in `openclaw.plugin.json`
2. Use correct names: `onMessage`, `onSessionEnd`, `onTimer`
3. Ensure handler function is exported

## 11. Tool Registration

### Tool Definition

```typescript
api.registerTool({
  name: "search_memory",
  description: "Search long-term memory",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query"
      },
      top_k: {
        type: "number",
        description: "Number of results",
        default: 10
      }
    },
    required: ["query"]
  },
  handler: async (params: any) => {
    // Implementation
    return { results: [...] };
  }
});
```

## 12. HTTP Routes

### Registering Routes

```typescript
api.registerHttpRoute({
  method: 'GET',
  path: '/status',
  handler: async (req, res) => {
    res.json({ status: 'ok' });
  }
});
```

## 13. CLI Commands

### Registering CLI

```typescript
api.registerCli({
  name: 'my-plugin',
  commands: [
    {
      command: 'status',
      description: 'Show plugin status',
      handler: async (args) => {
        console.log('Plugin is running');
      }
    }
  ]
});
```

## 14. Best Practices

1. **Always use `api.rootDir`** for file paths
2. **Log important events** with `api.logger`
3. **Handle errors gracefully** and provide meaningful messages
4. **Clean up resources** in `unregister()`
5. **Use project-local venv** for Python dependencies
6. **Test plugin loading** after any structural changes
7. **Keep manifest in sync** with actual plugin capabilities
8. **Document configuration schema** clearly in manifest

## 15. Testing Checklist

- [ ] Plugin loads without errors: `openclaw plugins list`
- [ ] Configuration is read correctly
- [ ] Tools are registered and callable
- [ ] Hooks trigger at appropriate times
- [ ] HTTP routes respond correctly
- [ ] Python service starts and stops cleanly
- [ ] No duplicate plugin warnings
- [ ] Plugin can be disabled and re-enabled
