const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const venvDir = path.join(rootDir, 'venv');

const TROUBLESHOOTING = {
  pythonNotFound: `
[TROUBLESHOOTING] Python not found:
  1. Ensure Python 3.10+ is installed
  2. Add Python to your system PATH
  3. On Windows, try: 'py --version' instead
  4. Download from: https://www.python.org/downloads/`,

  venvCreationFailed: `
[TROUBLESHOOTING] Virtual environment creation failed:
  1. Ensure you have write permissions in: ${rootDir}
  2. Try running as administrator (Windows) or with sudo (Linux/Mac)
  3. Check if 'venv' module is available: python -m venv --help
  4. On Ubuntu/Debian, install: sudo apt-get install python3-venv`,

  pipInstallFailed: `
[TROUBLESHOOTING] Python dependency installation failed:
  1. Check your internet connection
  2. Try upgrading pip manually: python -m pip install --upgrade pip
  3. Check if requirements.txt exists and is valid
  4. Try installing dependencies manually:
     ${process.platform === 'win32' 
       ? path.join(venvDir, 'Scripts', 'pip.exe')
       : path.join(venvDir, 'bin', 'pip')} install -r requirements.txt`,

  buildFailed: `
[TROUBLESHOOTING] TypeScript build failed:
  1. Ensure Node.js 18+ is installed
  2. Run 'npm install' in the plugin directory first
  3. Check for TypeScript errors: npm run build
  4. Try deleting node_modules and running 'npm install' again`,

  permissionDenied: `
[TROUBLESHOOTING] Permission denied:
  1. On Windows, run terminal as Administrator
  2. On Linux/Mac, try: sudo npm install
  3. Check folder permissions for: ${rootDir}`
};

function printError(title, error, troubleshootingKey) {
  console.error(`\n[ERROR] ${title}`);
  console.error(`  Details: ${error.message || error}`);
  if (troubleshootingKey && TROUBLESHOOTING[troubleshootingKey]) {
    console.error(TROUBLESHOOTING[troubleshootingKey]);
  }
}

function checkPython() {
  const pythonCommands = ['python', 'python3', 'py'];
  for (const cmd of pythonCommands) {
    try {
      const version = execSync(`${cmd} --version`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      console.log(`  Found Python: ${version.trim()}`);
      return cmd;
    } catch {}
  }
  return null;
}

function checkPip(pythonCmd) {
  try {
    const pipVersion = execSync(`${pythonCmd} -m pip --version`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    console.log(`  Found pip: ${pipVersion.trim().split(' ')[1]}`);
    return true;
  } catch {
    return false;
  }
}

console.log('[Cortex Memory] Setting up Python environment...\n');

try {
  console.log('[1/5] Checking Python installation...');
  const pythonCmd = checkPython();
  if (!pythonCmd) {
    printError('Python not found', 'No Python installation detected in PATH', 'pythonNotFound');
    process.exit(1);
  }

  console.log('\n[2/5] Checking pip...');
  if (!checkPip(pythonCmd)) {
    printError('pip not found', 'pip module is not available', 'pythonNotFound');
    process.exit(1);
  }

  console.log('\n[3/5] Setting up virtual environment...');
  if (!fs.existsSync(venvDir)) {
    console.log('  Creating virtual environment...');
    try {
      execSync(`${pythonCmd} -m venv venv`, { 
        cwd: rootDir, 
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf8'
      });
      console.log('  Virtual environment created successfully');
    } catch (error) {
      printError('Failed to create virtual environment', error, 'venvCreationFailed');
      process.exit(1);
    }
  } else {
    console.log('  Virtual environment already exists');
  }

  console.log('\n[4/5] Installing Python dependencies...');
  const pipCmd = process.platform === 'win32' 
    ? path.join(venvDir, 'Scripts', 'pip.exe')
    : path.join(venvDir, 'bin', 'pip');

  const requirementsPath = path.join(rootDir, 'requirements.txt');
  if (!fs.existsSync(requirementsPath)) {
    printError('requirements.txt not found', `Expected at: ${requirementsPath}`, 'pipInstallFailed');
    process.exit(1);
  }

  try {
    execSync(`"${pipCmd}" install --upgrade pip`, { 
      cwd: rootDir, 
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8'
    });
    execSync(`"${pipCmd}" install -r requirements.txt`, { 
      cwd: rootDir, 
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8'
    });
    console.log('  Python dependencies installed successfully');
  } catch (error) {
    printError('Failed to install Python dependencies', error, 'pipInstallFailed');
    process.exit(1);
  }

  console.log('\n[5/5] Building TypeScript...');
  const pluginDir = path.resolve(__dirname, '..');
  try {
    execSync('npm run build', { 
      cwd: pluginDir, 
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8'
    });
    console.log('  TypeScript build completed successfully');
  } catch (error) {
    const stderr = error.stderr || '';
    if (stderr.includes('permission') || stderr.includes('EACCES')) {
      printError('TypeScript build failed', error, 'permissionDenied');
    } else {
      printError('TypeScript build failed', error, 'buildFailed');
    }
    process.exit(1);
  }

  console.log('\n' + '='.repeat(50));
  console.log('[SUCCESS] Cortex Memory setup complete!');
  console.log('='.repeat(50));
  console.log('\nNext steps:');
  console.log('  1. Add plugin config to your openclaw.json:');
  console.log('     {');
  console.log('       "plugins": {');
  console.log('         "slots": {');
  console.log('           "memory": "@openclaw/cortex-memory"');
  console.log('         },');
  console.log('         "entries": {');
  console.log('           "@openclaw/cortex-memory": {');
  console.log('             "enabled": true,');
  console.log('             "config": {');
  console.log('               "embedding": {');
  console.log('                 "provider": "openai-compatible",');
  console.log('                 "model": "text-embedding-3-large",');
  console.log('                 "dimensions": 3072,');
  console.log('                 "apiKey": "${OPENAI_API_KEY}"');
  console.log('               },');
  console.log('               "llm": {');
  console.log('                 "provider": "openai",');
  console.log('                 "model": "gpt-4o-mini",');
  console.log('                 "apiKey": "${OPENAI_API_KEY}"');
  console.log('               },');
  console.log('               "reranker": {');
  console.log('                 "provider": "siliconflow",');
  console.log('                 "model": "BAAI/bge-reranker-v2-m3",');
  console.log('                 "apiKey": "${SILICONFLOW_API_KEY}",');
  console.log('                 "endpoint": "https://api.siliconflow.cn/v1/rerank"');
  console.log('               },');
  console.log('               "autoSync": true,');
  console.log('               "autoReflect": false');
  console.log('             }');
  console.log('           }');
  console.log('         }');
  console.log('       }');
  console.log('     }');
  console.log('\n  2. Set required API keys:');
  console.log('     export OPENAI_API_KEY="your-key"  (Linux/Mac)');
  console.log('     set OPENAI_API_KEY=your-key       (Windows)');
  console.log('\n  3. Restart OpenClaw gateway:');
  console.log('     openclaw gateway restart');
  console.log('');

} catch (error) {
  console.error('\n[ERROR] Unexpected error during setup:');
  console.error(error.stack || error.message || error);
  console.error('\nPlease report this issue at: https://github.com/deki18/openclaw-cortex-memory/issues');
  process.exit(1);
}
