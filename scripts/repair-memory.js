#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isFix = args.includes('--fix');
const targetArg = args.find(a => a.startsWith('--target='));
const target = targetArg ? targetArg.split('=')[1] : 'all';

const PROJECT_ROOT = process.cwd();
const MEMORY_ROOT = path.join(PROJECT_ROOT, 'data', 'memory');

const VALID_TARGETS = ['all', 'archive', 'active', 'vector'];

function printUsage() {
  console.log(`
Memory Data Repair Tool

Usage: node scripts/repair-memory.js [options]

Options:
  --dry-run          Scan and report issues without making changes
  --fix              Remove invalid records and create quarantine file
  --target=<target>  Specify target: all, archive, active, vector (default: all)

Examples:
  node scripts/repair-memory.js --dry-run
  node scripts/repair-memory.js --fix --target=archive
`);
}

if (!VALID_TARGETS.includes(target)) {
  console.error(`Invalid target: ${target}. Valid targets: ${VALID_TARGETS.join(', ')}`);
  printUsage();
  process.exit(1);
}

if (!isDryRun && !isFix) {
  printUsage();
  process.exit(0);
}

function validateJsonlLine(line, lineNumber) {
  const errors = [];
  if (!line || !line.trim()) {
    return { valid: true, errors: [], record: null };
  }
  let record;
  try {
    record = JSON.parse(line);
  } catch (e) {
    errors.push(`JSON parse error: ${e.message}`);
    return { valid: false, errors, record: null };
  }
  if (!record || typeof record !== 'object') {
    errors.push('Record is not an object');
    return { valid: false, errors, record: null };
  }
  if (typeof record.id !== 'string' || !record.id.trim()) {
    errors.push('Missing or invalid id field');
  }
  if (typeof record.timestamp !== 'string' || !record.timestamp.trim()) {
    errors.push('Missing or invalid timestamp field');
  }
  if (record.layer !== 'active' && record.layer !== 'archive') {
    errors.push('Missing or invalid layer field');
  }
  const anomalyPatterns = [
    /\d+\.\d+,\s*"[^"]+"/,
    /"[^"]+"\s+\d+\.\d+/,
    /,\s*\d+\.\d+,/,
    /"\w+\.\w+\.\w+"/,
    /\d+\.\w+\.\d+/,
  ];
  const lineStr = JSON.stringify(record);
  for (const pattern of anomalyPatterns) {
    if (pattern.test(lineStr)) {
      errors.push('Anomaly pattern detected in record');
      break;
    }
  }
  return { valid: errors.length === 0, errors, record };
}

function scanJsonlFile(filePath) {
  const results = {
    path: filePath,
    exists: false,
    totalLines: 0,
    validLines: 0,
    invalidLines: 0,
    emptyLines: 0,
    issues: [],
  };
  if (!fs.existsSync(filePath)) {
    return results;
  }
  results.exists = true;
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      results.emptyLines++;
      continue;
    }
    results.totalLines++;
    const validation = validateJsonlLine(line, i + 1);
    if (validation.valid) {
      results.validLines++;
    } else {
      results.invalidLines++;
      results.issues.push({
        lineNumber: i + 1,
        errors: validation.errors,
        preview: line.slice(0, 100) + (line.length > 100 ? '...' : ''),
      });
    }
  }
  return results;
}

function repairJsonlFile(filePath, dryRun) {
  const results = {
    path: filePath,
    exists: false,
    totalLines: 0,
    validLines: 0,
    removedLines: 0,
    quarantineLines: [],
  };
  if (!fs.existsSync(filePath)) {
    return results;
  }
  results.exists = true;
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/);
  const validRecords = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      continue;
    }
    results.totalLines++;
    const validation = validateJsonlLine(line, i + 1);
    if (validation.valid) {
      results.validLines++;
      validRecords.push(line);
    } else {
      results.removedLines++;
      results.quarantineLines.push({
        lineNumber: i + 1,
        content: line,
        errors: validation.errors,
      });
    }
  }
  if (!dryRun && results.removedLines > 0) {
    const newContent = validRecords.join('\n') + (validRecords.length > 0 ? '\n' : '');
    fs.writeFileSync(filePath, newContent, 'utf-8');
    const quarantinePath = filePath + '.quarantine.jsonl';
    const quarantineContent = results.quarantineLines.map(q => 
      JSON.stringify({ lineNumber: q.lineNumber, errors: q.errors, content: q.content })
    ).join('\n');
    fs.writeFileSync(quarantinePath, quarantineContent + '\n', 'utf-8');
  }
  return results;
}

function scanVectorFallback(filePath) {
  const results = {
    path: filePath,
    exists: false,
    totalRecords: 0,
    validRecords: 0,
    orphanRecords: 0,
    issues: [],
  };
  if (!fs.existsSync(filePath)) {
    return results;
  }
  results.exists = true;
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    results.totalRecords++;
    try {
      const record = JSON.parse(line);
      if (!record.id || !record.embedding) {
        results.issues.push({
          lineNumber: i + 1,
          error: 'Missing id or embedding',
        });
      } else {
        results.validRecords++;
      }
    } catch (e) {
      results.issues.push({
        lineNumber: i + 1,
        error: `JSON parse error: ${e.message}`,
      });
    }
  }
  return results;
}

console.log('='.repeat(60));
console.log('Memory Data Repair Tool');
console.log('='.repeat(60));
console.log(`Mode: ${isDryRun ? 'DRY RUN (no changes)' : 'FIX (will modify files)'}`);
console.log(`Target: ${target}`);
console.log(`Memory Root: ${MEMORY_ROOT}`);
console.log('='.repeat(60));

const archivePath = path.join(MEMORY_ROOT, 'sessions', 'archive', 'archive.jsonl');
const activePath = path.join(MEMORY_ROOT, 'sessions', 'active', 'sessions.jsonl');
const vectorFallbackPath = path.join(MEMORY_ROOT, 'vector', 'lancedb_events.jsonl');

let totalIssues = 0;
const report = {
  archive: null,
  active: null,
  vector: null,
};

if (target === 'all' || target === 'archive') {
  console.log('\n[Archive Layer]');
  if (isDryRun) {
    report.archive = scanJsonlFile(archivePath);
  } else {
    report.archive = repairJsonlFile(archivePath, false);
  }
  if (!report.archive.exists) {
    console.log('  File does not exist');
  } else {
    console.log(`  Total lines: ${report.archive.totalLines}`);
    console.log(`  Valid lines: ${report.archive.validLines}`);
    console.log(`  Invalid lines: ${report.archive.invalidLines || report.archive.removedLines}`);
    if (report.archive.issues && report.archive.issues.length > 0) {
      console.log('  Issues found:');
      report.archive.issues.slice(0, 5).forEach(issue => {
        console.log(`    Line ${issue.lineNumber}: ${issue.errors.join(', ')}`);
      });
      if (report.archive.issues.length > 5) {
        console.log(`    ... and ${report.archive.issues.length - 5} more`);
      }
    }
    totalIssues += report.archive.invalidLines || report.archive.removedLines || 0;
  }
}

if (target === 'all' || target === 'active') {
  console.log('\n[Active Layer]');
  if (isDryRun) {
    report.active = scanJsonlFile(activePath);
  } else {
    report.active = repairJsonlFile(activePath, false);
  }
  if (!report.active.exists) {
    console.log('  File does not exist');
  } else {
    console.log(`  Total lines: ${report.active.totalLines}`);
    console.log(`  Valid lines: ${report.active.validLines}`);
    console.log(`  Invalid lines: ${report.active.invalidLines || report.active.removedLines}`);
    if (report.active.issues && report.active.issues.length > 0) {
      console.log('  Issues found:');
      report.active.issues.slice(0, 5).forEach(issue => {
        console.log(`    Line ${issue.lineNumber}: ${issue.errors.join(', ')}`);
      });
      if (report.active.issues.length > 5) {
        console.log(`    ... and ${report.active.issues.length - 5} more`);
      }
    }
    totalIssues += report.active.invalidLines || report.active.removedLines || 0;
  }
}

if (target === 'all' || target === 'vector') {
  console.log('\n[Vector Fallback]');
  report.vector = scanVectorFallback(vectorFallbackPath);
  if (!report.vector.exists) {
    console.log('  File does not exist');
  } else {
    console.log(`  Total records: ${report.vector.totalRecords}`);
    console.log(`  Valid records: ${report.vector.validRecords}`);
    console.log(`  Issues: ${report.vector.issues.length}`);
    if (report.vector.issues.length > 0) {
      console.log('  Issues found:');
      report.vector.issues.slice(0, 5).forEach(issue => {
        console.log(`    Line ${issue.lineNumber}: ${issue.error}`);
      });
    }
    totalIssues += report.vector.issues.length;
  }
}

console.log('\n' + '='.repeat(60));
console.log('Summary');
console.log('='.repeat(60));
console.log(`Total issues found: ${totalIssues}`);

if (isDryRun) {
  if (totalIssues > 0) {
    console.log('\nRun with --fix to repair these issues.');
  } else {
    console.log('\nNo issues found. Memory data is healthy.');
  }
} else {
  if (totalIssues > 0) {
    console.log('\nRepair completed. Invalid records have been quarantined.');
    console.log('Check .quarantine.jsonl files for removed records.');
  } else {
    console.log('\nNo repairs needed. Memory data is healthy.');
  }
}

process.exit(totalIssues > 0 && isDryRun ? 1 : 0);
