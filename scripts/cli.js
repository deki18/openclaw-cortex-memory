#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const PLUGIN_NAME = 'cortex-memory-pro';
const EXCLUSIVE_MEMORY_PLUGINS = ['memory-core', 'memory-lancedb'];

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

function getHomePath() {
  return process.env.USERPROFILE || process.env.HOME || '';
}

function expandHomePath(inputPath) {
  if (!inputPath) {
    return inputPath;
  }
  if (inputPath === '~') {
    return getHomePath() || inputPath;
  }
  if (inputPath.startsWith(`~${path.sep}`) || inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    const homePath = getHomePath();
    if (!homePath) {
      return inputPath;
    }
    return path.join(homePath, inputPath.slice(2));
  }
  return inputPath;
}

function commandName(name) {
  return name;
}

function quoteWindowsArg(arg) {
  const value = String(arg);
  if (!/[\s"&|<>^]/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '\\"')}"`;
}

function spawnCommand(command, args, options = {}) {
  if (process.platform === 'win32') {
    const commandLine = [commandName(command), ...args].map(quoteWindowsArg).join(' ');
    return childProcess.spawnSync('cmd.exe', ['/d', '/s', '/c', commandLine], options);
  }
  return childProcess.spawnSync(commandName(command), args, options);
}

function runCommand(command, args) {
  const display = [command, ...args].join(' ');
  console.log(`\n> ${display}`);
  const result = spawnCommand(command, args, {
    stdio: 'inherit'
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Command failed with exit code ${result.status}: ${display}`);
  }
}

function runOptionalCommand(command, args) {
  try {
    runCommand(command, args);
  } catch (error) {
    console.warn(`Optional command failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function ensureCommandAvailable(command) {
  const result = process.platform === 'win32'
    ? childProcess.spawnSync('where', [command], { stdio: 'ignore' })
    : childProcess.spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' });
  if (result.error || result.status !== 0) {
    throw new Error(`Required command is not available: ${command}`);
  }
}

function resolveOpenClawBasePath() {
  const explicitBasePath = process.env.OPENCLAW_BASE_PATH || process.env.OPENCLAW_STATE_DIR || '';
  if (explicitBasePath) {
    return path.resolve(expandHomePath(explicitBasePath));
  }

  const configPath = findOpenClawConfig();
  if (configPath) {
    return path.dirname(path.resolve(configPath));
  }

  const homePath = getHomePath();
  return homePath ? path.join(homePath, '.openclaw') : path.join(process.cwd(), '.openclaw');
}

function resolveExtensionDir(explicitExtensionDir) {
  if (explicitExtensionDir) {
    return path.resolve(expandHomePath(explicitExtensionDir));
  }
  return path.join(resolveOpenClawBasePath(), 'extensions', PLUGIN_NAME);
}

function assertSafePluginExtensionDir(extensionDir) {
  const resolved = path.resolve(extensionDir);
  if (path.basename(resolved) !== PLUGIN_NAME || path.basename(path.dirname(resolved)) !== 'extensions') {
    throw new Error(`Refusing to remove unexpected extension directory: ${resolved}`);
  }
  return resolved;
}

function packNpmPackage(packageSpec) {
  const display = `npm pack ${packageSpec} --json`;
  console.log(`\n> ${display}`);
  const result = spawnCommand('npm', ['pack', packageSpec, '--json'], {
    encoding: 'utf8'
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    throw new Error(`Command failed with exit code ${result.status}: ${display}`);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  let packResult;
  try {
    packResult = JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new Error(`Unable to parse npm pack output: ${error instanceof Error ? error.message : String(error)}`);
  }

  const packedFile = Array.isArray(packResult) ? packResult[0]?.filename : packResult?.filename;
  if (!packedFile) {
    throw new Error('npm pack did not return a package filename.');
  }

  const packedPath = path.resolve(process.cwd(), packedFile);
  console.log(`Packed: ${packedPath}`);
  return packedPath;
}

function ensureExclusiveMemoryMode(config) {
  let changed = false;

  if (!config.plugins) {
    config.plugins = {};
    changed = true;
  }
  if (!config.plugins.entries) {
    config.plugins.entries = {};
    changed = true;
  }

  for (const pluginId of EXCLUSIVE_MEMORY_PLUGINS) {
    const current = config.plugins.entries[pluginId] || {};
    if (current.enabled !== false) {
      config.plugins.entries[pluginId] = {
        ...current,
        enabled: false
      };
      changed = true;
    }
  }

  if (!config.plugins.slots) {
    config.plugins.slots = {};
    changed = true;
  }
  if (config.plugins.slots.memory !== 'none') {
    config.plugins.slots.memory = 'none';
    changed = true;
  }

  return changed;
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
          memory: 'none'
        },
        entries: {
          'memory-core': {
            enabled: false
          },
          'memory-lancedb': {
            enabled: false
          },
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

  const wasEnabled = config.plugins.entries[PLUGIN_NAME]?.enabled === true;
  config.plugins.entries[PLUGIN_NAME] = {
    ...config.plugins.entries[PLUGIN_NAME],
    enabled: true
  };

  const exclusiveUpdated = ensureExclusiveMemoryMode(config);
  if (wasEnabled && !exclusiveUpdated) {
    console.log(`Plugin '${PLUGIN_NAME}' is already enabled.`);
    return;
  }

  saveConfig(configPath, config);
  if (wasEnabled) {
    console.log(`Plugin '${PLUGIN_NAME}' is already enabled.`);
    console.log('Exclusive memory mode config has been refreshed (slots.memory=none, memory-core/memory-lancedb disabled).');
  } else {
    console.log(`Plugin '${PLUGIN_NAME}' has been enabled.`);
  }
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

function parseUpdateArgs(args) {
  const options = {
    packageSpec: `${PLUGIN_NAME}@latest`,
    restart: false,
    removeExisting: true,
    extensionDir: '',
    help: false
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--restart':
        options.restart = true;
        break;
      case '--no-restart':
        options.restart = false;
        break;
      case '--skip-remove':
        options.removeExisting = false;
        break;
      case '--package':
      case '--from':
        i += 1;
        if (!args[i]) {
          throw new Error(`${arg} requires a package spec, for example ${PLUGIN_NAME}@latest.`);
        }
        options.packageSpec = args[i];
        break;
      case '--extensions-dir':
        i += 1;
        if (!args[i]) {
          throw new Error('--extensions-dir requires a path.');
        }
        options.extensionDir = args[i];
        break;
      default:
        if (!arg.startsWith('-') && options.packageSpec === `${PLUGIN_NAME}@latest`) {
          options.packageSpec = arg;
          break;
        }
        throw new Error(`Unknown update option: ${arg}`);
    }
  }

  return options;
}

function removeExistingExtension(extensionDir) {
  const safeExtensionDir = assertSafePluginExtensionDir(extensionDir);
  if (!fs.existsSync(safeExtensionDir)) {
    console.log(`No existing extension directory found: ${safeExtensionDir}`);
    return;
  }

  console.log(`Removing existing extension directory: ${safeExtensionDir}`);
  fs.rmSync(safeExtensionDir, { recursive: true, force: true });
}

function updatePlugin(args) {
  let options;
  try {
    options = parseUpdateArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('Run "cortex-memory update --help" for usage information.');
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    showUpdateHelp();
    return;
  }

  const extensionDir = resolveExtensionDir(options.extensionDir);
  let packedPath = '';

  console.log('='.repeat(50));
  console.log('Cortex Memory Plugin Updater');
  console.log('='.repeat(50));
  console.log(`Package: ${options.packageSpec}`);
  console.log(`Extension directory: ${extensionDir}`);

  try {
    ensureCommandAvailable('openclaw');
    packedPath = packNpmPackage(options.packageSpec);

    if (options.removeExisting) {
      removeExistingExtension(extensionDir);
    } else {
      console.log('Skipping extension directory removal (--skip-remove).');
    }

    runCommand('openclaw', ['plugins', 'install', packedPath]);
    runCommand('openclaw', ['plugins', 'enable', PLUGIN_NAME]);
    enablePlugin();
    runOptionalCommand('openclaw', ['plugins', 'list', '--enabled']);

    if (options.restart) {
      runCommand('openclaw', ['gateway', 'restart']);
    } else {
      console.log('\nUpdate installed. Restart OpenClaw gateway to load the new plugin code:');
      console.log('  openclaw gateway restart');
    }

    console.log('\nUpdate complete.');
  } catch (error) {
    console.error(`\nUpdate failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    if (packedPath && fs.existsSync(packedPath)) {
      try {
        fs.unlinkSync(packedPath);
        console.log(`Removed temporary package: ${packedPath}`);
      } catch (error) {
        console.warn(`Failed to remove temporary package: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

function runUninstall(args) {
  const uninstallScriptPath = path.join(__dirname, 'uninstall.js');
  if (!fs.existsSync(uninstallScriptPath)) {
    console.error('Uninstall script not found.');
    process.exit(1);
  }
  try {
    const uninstallModule = require(uninstallScriptPath);
    if (!uninstallModule || typeof uninstallModule.uninstall !== 'function') {
      console.error('Invalid uninstall script export.');
      process.exit(1);
    }
    uninstallModule.uninstall(args);
  } catch (error) {
    console.error(`Failed to run uninstall: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

function showUpdateHelp() {
  console.log(`
Cortex Memory Plugin Updater

Usage: cortex-memory update [options]

Options:
  --restart                 Restart OpenClaw gateway after installing
  --no-restart              Install only and print the restart command (default)
  --package <spec>          npm package spec to install (default: ${PLUGIN_NAME}@latest)
  --from <spec>             Alias for --package
  --extensions-dir <path>   Override the plugin extension directory
  --skip-remove             Do not remove the existing extension directory first
  --help                    Show this help message

Examples:
  cortex-memory update
  cortex-memory update --restart
  cortex-memory update --package ${PLUGIN_NAME}@latest --restart
  npx -y -p ${PLUGIN_NAME}@latest cortex-memory update --restart

The updater refreshes the installed plugin package and enable/config state.
It does not remove memory data under workspace/memory or data/memory.
`);
}

function showHelp() {
  console.log(`
Cortex Memory Plugin CLI

Usage: cortex-memory <command> [options]

Commands:
  enable              Enable the Cortex Memory plugin
  disable             Disable the Cortex Memory plugin (fallback to builtin memory)
  status              Show the current plugin status
  update [options]    Update/reinstall the plugin from npm
  uninstall [options] Uninstall the plugin completely
  help                Show this help message

Update Options:
  --restart           Restart OpenClaw gateway after installing
  --package <spec>    npm package spec to install (default: ${PLUGIN_NAME}@latest)

Uninstall Options:
  --keep-data         Keep memory data files (LanceDB, episodic memory, etc.)
  --keep-config       Keep plugin entry in openclaw.json

Examples:
  cortex-memory enable              Enable the plugin
  cortex-memory disable             Disable the plugin
  cortex-memory status              Check current status
  cortex-memory update --restart    Update plugin and restart gateway
  cortex-memory uninstall           Full uninstall (removes everything)
  cortex-memory uninstall --keep-data  Keep memory data files

Configuration:
  The plugin state is stored in openclaw.json under:
  {
    "plugins": {
      "allow": ["cortex-memory-pro"],
      "slots": {
        "memory": "none"
      },
      "entries": {
        "memory-core": {
          "enabled": false
        },
        "memory-lancedb": {
          "enabled": false
        },
        "cortex-memory-pro": {
          "enabled": true/false
        }
      }
    }
  }
  Note: do not set plugins.slots.memory to "cortex-memory-pro".

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
    case 'update':
      updatePlugin(args.slice(1));
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
