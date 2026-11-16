'use strict';

// Quick sanity check you can run any time without launching Electron:
//   npm run check
// It just node --check's every source file so obvious typos are caught
// before you spend time on a full `npm run dist`.

const { execFileSync } = require('child_process');
const { globSync } = require('./glob-lite');
const path = require('path');

const root = path.join(__dirname, '..');
const files = globSync(path.join(root, 'src'), '.js');

let failed = false;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log(`ok    ${path.relative(root, file)}`);
  } catch (err) {
    failed = true;
    console.error(`FAIL  ${path.relative(root, file)}`);
    console.error(err.stderr ? err.stderr.toString() : err.message);
  }
}

if (failed) {
  console.error('\nSyntax check failed.');
  process.exit(1);
} else {
  console.log('\nAll source files parse cleanly.');
}
