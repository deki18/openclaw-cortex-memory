const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const manifestPath = path.join(root, 'openclaw.plugin.json');

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

if (!pkg.version || !manifest.version) {
  console.error('Missing version field in package.json or openclaw.plugin.json');
  process.exit(1);
}

if (pkg.version !== manifest.version) {
  console.error(`Version mismatch: package.json=${pkg.version}, openclaw.plugin.json=${manifest.version}`);
  process.exit(1);
}

console.log(`Version check passed: ${pkg.version}`);
