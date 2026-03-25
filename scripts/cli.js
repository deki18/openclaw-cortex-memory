#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PLUGIN_NAME = 'openclaw-cortex-memory';

function findOpenClawConfig() {
  const explicitConfigPath = process.env.OPENCLAW_CONFIG_PATH || '';
  const stateDir = process.env.OPENCLAW_STATE_DIR || '';
  const basePath = process.env.OPENCLAW_BASE_PATH || '';
  const homePath = process.env.USERPROFILE || process.env.HOME || '';
  const possiblePaths = [
    explicitConfigPath,
    stateDir ? path.join(stateDir, 'openclaw.json') : '',
    basePath ? path.join(basePath, 'openclaw.json') : '',
    path.join(process.cwd(), 'openclaw.json'),
    homePath ? path.join(homePath, '.openclaw', 'openclaw.json') : '',
  ];
  
  for (const p of possiblePaths) {
    if (p && fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

function loadConfig(configPath) {
  if (!configPath || !fs.existsSync(configPath)) {
    return { plugins: {} };
  }
  
  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(content);
  } catch (e) {
    console.error(`Error loading config: ${e.message}`);
    return { plugins: {} };
  }
}

function saveConfig(configPath, config) {
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`Configuration saved to: ${configPath}`);
}

function enablePlugin() {
  const configPath = findOpenClawConfig();
  
  if (!configPath) {
    const defaultPath = process.env.OPENCLAW_CONFIG_PATH
      || (process.env.OPENCLAW_STATE_DIR ? path.join(process.env.OPENCLAW_STATE_DIR, 'openclaw.json') : '')
      || (process.env.OPENCLAW_BASE_PATH ? path.join(process.env.OPENCLAW_BASE_PATH, 'openclaw.json') : '')
      || path.join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw', 'openclaw.json');
    console.log(`No config file found. Creating: ${defaultPath}`);
    
    const config = {
      plugins: {
        allow: [PLUGIN_NAME],
        slots: {
          memory: PLUGIN_NAME
        },
        entries: {
          [PLUGIN_NAME]: {
            enabled: true
          }
        }
      }
    };
    saveConfig(defaultPath, config);
    console.log(`Plugin '${PLUGIN_NAME}' has been enabled.`);
    return;
  }
  
  const config = loadConfig(configPath);
  
  if (!config.plugins) {
    config.plugins = {};
  }
  if (!Array.isArray(config.plugins.allow)) {
    config.plugins.allow = [];
  }
  if (!config.plugins.allow.includes(PLUGIN_NAME)) {
    config.plugins.allow.push(PLUGIN_NAME);
  }
  if (!config.plugins.entries) {
    config.plugins.entries = {};
  }
  
  if (config.plugins.entries[PLUGIN_NAME]?.enabled === true) {
    console.log(`Plugin '${PLUGIN_NAME}' is already enabled.`);
    return;
  }
  
  config.plugins.entries[PLUGIN_NAME] = {
    ...config.plugins.entries[PLUGIN_NAME],
    enabled: true
  };
  
  if (!config.plugins.slots) {
    config.plugins.slots = {};
  }
  config.plugins.slots.memory = PLUGIN_NAME;
  
  saveConfig(configPath, config);
  console.log(`Plugin '${PLUGIN_NAME}' has been enabled.`);
  console.log('The plugin will be activated on the next OpenClaw restart or config reload.');
}

function disablePlugin() {
  const configPath = findOpenClawConfig();
  
  if (!configPath) {
    console.error('No OpenClaw configuration file found.');
    console.error('Please create an openclaw.json file first.');
    process.exit(1);
  }
  
  const config = loadConfig(configPath);
  
  if (!config.plugins?.entries?.[PLUGIN_NAME] || config.plugins.entries[PLUGIN_NAME].enabled !== false) {
    if (!config.plugins) {
      config.plugins = {};
    }
    if (!config.plugins.entries) {
      config.plugins.entries = {};
    }
    
    config.plugins.entries[PLUGIN_NAME] = {
      ...config.plugins.entries[PLUGIN_NAME],
      enabled: false
    };
    
    saveConfig(configPath, config);
    console.log(`Plugin '${PLUGIN_NAME}' has been disabled.`);
    console.log('The plugin will be deactivated on the next OpenClaw restart or config reload.');
  } else {
    console.log(`Plugin '${PLUGIN_NAME}' is already disabled.`);
  }
}

function getStatus() {
  const configPath = findOpenClawConfig();
  
  console.log('Cortex Memory Plugin Status');
  console.log('='.repeat(40));
  
  if (!configPath) {
    console.log('Config file: Not found');
    console.log('Status: Enabled (default)');
    console.log('\nNote: Plugin is enabled by default when no config exists.');
    return;
  }
  
  console.log(`Config file: ${configPath}`);
  
  const config = loadConfig(configPath);
  const pluginConfig = config.plugins?.entries?.[PLUGIN_NAME];
  
  if (!pluginConfig) {
    console.log('Status: Enabled (default)');
  } else {
    console.log(`Status: ${pluginConfig.enabled === false ? 'Disabled' : 'Enabled'}`);
  }
  
  console.log('\nConfiguration:');
  console.log(JSON.stringify(pluginConfig || { enabled: true }, null, 2));
}

function runUninstall(args) {
  const uninstallScript = path.join(__dirname, 'uninstall.js');
  
  if (!fs.existsSync(uninstallScript)) {
    console.error('Uninstall script not found.');
    process.exit(1);
  }
  
  const child = spawn(process.execPath, [uninstallScript, 'uninstall', ...args], {
    stdio: 'inherit',
    cwd: process.cwd()
  });
  
  child.on('exit', (code) => {
    process.exit(code || 0);
  });
}

function showHelp() {
  console.log(`
Cortex Memory Plugin CLI

Usage: cortex-memory <command> [options]

Commands:
  enable              Enable the Cortex Memory plugin
  disable             Disable the Cortex Memory plugin (fallback to builtin memory)
  status              Show the current plugin status
  uninstall [options] Uninstall the plugin completely
  help                Show this help message

Uninstall Options:
  --keep-data         Keep memory data files (LanceDB, episodic memory, etc.)
  --keep-config       Keep plugin entry in openclaw.json

Examples:
  cortex-memory enable              Enable the plugin
  cortex-memory disable             Disable the plugin
  cortex-memory status              Check current status
  cortex-memory uninstall           Full uninstall (removes everything)
  cortex-memory uninstall --keep-data  Keep memory data files

Configuration:
  The plugin state is stored in openclaw.json under:
  {
    "plugins": {
      "allow": ["openclaw-cortex-memory"],
      "entries": {
        "openclaw-cortex-memory": {
          "enabled": true/false
        }
      }
    }
  }

Fallback Behavior:
  When disabled, the plugin will fall back to OpenClaw's builtin
  memory system if fallbackToBuiltin is true (default).
`);
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';
  
  switch (command) {
    case 'enable':
      enablePlugin();
      break;
    case 'disable':
      disablePlugin();
      break;
    case 'status':
      getStatus();
      break;
    case 'uninstall':
      runUninstall(args.slice(1));
      break;
    case 'help':
    case '--help':
    case '-h':
      showHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      showHelp();
      process.exit(1);
  }
}

main();
