const { spawnSync } = require('child_process');

const npmCommand = 'npm';
const steps = [
  { name: 'Version Gate', command: npmCommand, args: ['run', 'check:version'] },
  { name: 'Typecheck', command: npmCommand, args: ['run', 'typecheck'] },
  { name: 'Build', command: npmCommand, args: ['run', 'build'] },
  { name: 'Regression Tests', command: npmCommand, args: ['run', 'test:all'] },
  { name: 'Package Dry Run', command: npmCommand, args: ['pack', '--dry-run'] },
];

function runStep(step) {
  const direct = spawnSync(step.command, step.args, {
    stdio: 'inherit',
    shell: false,
  });
  if (!direct.error) {
    return direct;
  }
  const fallback = spawnSync([step.command, ...step.args].join(' '), {
    stdio: 'inherit',
    shell: true,
  });
  return fallback;
}

for (const step of steps) {
  console.log(`\n[Release Pipeline] ${step.name}`);
  const result = runStep(step);
  if (result.status !== 0) {
    console.error(`\n[Release Pipeline] Failed at step: ${step.name}`);
    process.exit(result.status || 1);
  }
}

console.log('\n[Release Pipeline] All checks passed.');
