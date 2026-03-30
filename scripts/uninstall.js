#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const PLUGIN_NAME = 'openclaw-cortex-memory';

function findProjectRoot() {
  let current = __dirname;
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, 'package.json')) && fs.existsSync(path.join(current, 'openclaw.plugin.json'))) {
      return current;
    }
    current = path.dirname(current);
  }
  return __dirname;
}

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

function removeVenv(projectRoot) {
  const venvPath = path.join(projectRoot, 'venv');
  if (fs.existsSync(venvPath)) {
    console.log(`Removing virtual environment: ${venvPath}`);
    try {
      fs.rmSync(venvPath, { recursive: true, force: true });
      console.log('Virtual environment removed.');
    } catch (e) {
      console.error(`Failed to remove venv: ${e.message}`);
    }
  } else {
    console.log('No virtual environment found.');
  }
}

function removeBuildArtifacts(projectRoot) {
  const distPath = path.join(projectRoot, 'dist');
  const nodeModulesPath = path.join(projectRoot, 'node_modules');
  
  if (fs.existsSync(distPath)) {
    console.log(`Removing dist: ${distPath}`);
    try {
      fs.rmSync(distPath, { recursive: true, force: true });
    } catch (e) {
      console.error(`Failed to remove dist: ${e.message}`);
    }
  }
  
  if (fs.existsSync(nodeModulesPath)) {
    console.log(`Removing node_modules: ${nodeModulesPath}`);
    try {
      fs.rmSync(nodeModulesPath, { recursive: true, force: true });
    } catch (e) {
      console.error(`Failed to remove node_modules: ${e.message}`);
    }
  }
  
  console.log('Build artifacts removed.');
}

function removeDataFiles(projectRoot, keepData) {
  if (keepData) {
    console.log('Keeping data files (--keep-data flag).');
    return;
  }
  
  const dataPaths = [
    path.join(projectRoot, 'data', 'memory'),
    path.join(projectRoot, 'data', 'lancedb_store'),
  ];
  
  const homeDataPaths = [
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw', 'agents', 'main', 'lancedb_store'),
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw', 'episodic_memory.jsonl'),
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw', 'memory_graph.json'),
  ];
  
  for (const dataPath of [...dataPaths, ...homeDataPaths]) {
    if (fs.existsSync(dataPath)) {
      console.log(`Removing data: ${dataPath}`);
      try {
        fs.rmSync(dataPath, { recursive: true, force: true });
      } catch (e) {
        console.error(`Failed to remove ${dataPath}: ${e.message}`);
      }
    }
  }
  
  console.log('Data files removed.');
}

function removeFromConfig() {
  const configPath = findOpenClawConfig();
  
  if (!configPath) {
    console.log('No OpenClaw config file found.');
    return;
  }
  
  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content);
    
    if (Array.isArray(config.plugins?.allow)) {
      config.plugins.allow = config.plugins.allow.filter((item) => item !== PLUGIN_NAME);
    }
    if (config.plugins?.entries?.[PLUGIN_NAME]) {
      delete config.plugins.entries[PLUGIN_NAME];
      if (config.plugins.slots?.memory === PLUGIN_NAME) {
        delete config.plugins.slots.memory;
      }
      
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      console.log(`Removed plugin from config: ${configPath}`);
    } else if (Array.isArray(config.plugins?.allow)) {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      console.log(`Removed plugin allowlist entry from config: ${configPath}`);
    } else {
      console.log('Plugin not found in config.');
    }
  } catch (e) {
    console.error(`Failed to update config: ${e.message}`);
  }
}

function showHelp() {
  console.log(`
Cortex Memory Plugin Uninstaller

Usage: cortex-memory uninstall [options]

Options:
  --keep-data    Keep memory data files (LanceDB, episodic memory, etc.)
  --keep-config  Keep plugin entry in openclaw.json
  --help         Show this help message

Examples:
  cortex-memory uninstall              # Full uninstall (removes everything)
  cortex-memory uninstall --keep-data  # Keep memory data files

This will:
  1. Remove local virtual environment folder (if exists)
  2. Remove node_modules and build artifacts
  3. Remove memory data files (unless --keep-data)
  4. Remove plugin from openclaw.json (unless --keep-config)
`);
}

function uninstall(args) {
  const keepData = args.includes('--keep-data');
  const keepConfig = args.includes('--keep-config');
  
  console.log('='.repeat(50));
  console.log('Cortex Memory Plugin Uninstaller');
  console.log('='.repeat(50));
  console.log('');
  
  const projectRoot = findProjectRoot();
  console.log(`Project root: ${projectRoot}`);
  console.log('');
  
  removeVenv(projectRoot);
  
  removeBuildArtifacts(projectRoot);
  
  removeDataFiles(projectRoot, keepData);
  
  if (!keepConfig) {
    removeFromConfig();
  } else {
    console.log('Keeping config entry (--keep-config flag).');
  }
  
  console.log('');
  console.log('='.repeat(50));
  console.log('Uninstall complete!');
  console.log('='.repeat(50));
  
  if (keepData) {
    console.log('\nNote: Memory data files were preserved. To remove them manually:');
    console.log(`  - ${path.join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw', 'agents', 'main', 'lancedb_store')}`);
  }
  
  console.log('\nTo reinstall the plugin:');
  console.log('  cd /path/to/openclaw-cortex-memory/plugin');
  console.log('  npm install');
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  
  if (command === 'uninstall') {
    uninstall(args.slice(1));
  } else if (command === '--help' || command === '-h' || command === 'help') {
    showHelp();
  } else {
    console.log(`Unknown command: ${command}`);
    console.log('Run "cortex-memory uninstall --help" for usage information.');
    process.exit(1);
  }
}

module.exports = {
  uninstall,
};

if (require.main === module) {
  main();
}
