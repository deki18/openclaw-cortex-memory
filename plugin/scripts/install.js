const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..', '..');
const venvDir = path.join(rootDir, 'venv');

console.log('[Cortex Memory] Setting up Python environment...');

try {
  // Check Python
  try {
    execSync('python --version', { stdio: 'ignore' });
  } catch {
    console.error('[ERROR] Python is not installed or not in PATH');
    process.exit(1);
  }

  // Create virtual environment
  if (!fs.existsSync(venvDir)) {
    console.log('  Creating virtual environment...');
    execSync('python -m venv venv', { cwd: rootDir, stdio: 'ignore' });
  }

  // Install Python dependencies
  console.log('  Installing Python dependencies...');
  const pipCmd = process.platform === 'win32' 
    ? path.join(venvDir, 'Scripts', 'pip.exe')
    : path.join(venvDir, 'bin', 'pip');
  
  execSync(`"${pipCmd}" install -q -r requirements.txt`, { 
    cwd: rootDir, 
    stdio: 'ignore' 
  });

  // Build TypeScript
  console.log('  Building TypeScript...');
  execSync('npm run build', { cwd: path.resolve(__dirname, '..'), stdio: 'ignore' });

  console.log('[Cortex Memory] Setup complete!');
  console.log('');
  console.log('Next steps:');
  console.log('  1. Add plugin config to your openclaw.json (see SKILL.md for example)');
  console.log('  2. Set required API keys (OPENAI_API_KEY, etc.)');
  console.log('  3. Run: openclaw gateway restart');
  console.log('');
} catch (error) {
  console.error('[ERROR] Setup failed:', error.message);
  process.exit(1);
}
