// electron-builder `beforeBuild` hook.
//
// Runs before EVERY packaging build — both `npm run dist` and the in-app
// "Build Portable" button. build.js invokes the electron-builder CLI directly
// (bypassing npm scripts), so a `predist` hook would NOT fire for that path;
// a build-config hook fires for both.
//
// It ensures the speech-to-text model is downloaded so electron-builder can
// bundle models/** (see package.json build.asarUnpack). If the model can't be
// fetched, the build is aborted loudly rather than silently shipping an app
// whose voice typing is broken on the target machine.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

function beforeBuild() {
  const script = path.join(__dirname, 'fetch-model.mjs');
  // Hard-fail mode (no --soft): a missing model must stop the build.
  const res = spawnSync(process.execPath, [script], { stdio: 'inherit' });
  if (res.status !== 0) {
    throw new Error(
      'fetch-model failed (exit ' + res.status + '); aborting build so the ' +
      'app is not packaged without its speech model.'
    );
  }
  // Let electron-builder proceed with its normal dependency handling
  // (returning false would skip it).
  return true;
}

module.exports = beforeBuild;
module.exports.default = beforeBuild;
