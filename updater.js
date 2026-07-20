'use strict';

// ---------------------------------------------------------------------------
// Portable self-update.
//
// When Hivemind is running as the portable single-exe build (electron-builder
// sets PORTABLE_EXECUTABLE_FILE in that case, and only that case), check
// GitHub for a newer release on startup. If one exists, ask the user once;
// on "Update Now" download the new portable exe next to the current one,
// launch it, delete the old exe and every other older-versioned sibling,
// and quit. Installed (NSIS) and dev runs return immediately.
// ---------------------------------------------------------------------------

const { app, dialog } = require('electron');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REPO = 'mikemcs121/hivemind';
const RELEASES_URL = `https://github.com/${REPO}/releases`;
const USER_AGENT = 'Hivemind-Updater';

// Matches both the release-asset name ("Hivemind.0.1.7.portable.exe") and the
// name the updater downloads to ("Hivemind 0.1.7 portable.exe").
const PORTABLE_EXE_RE = /^hivemind[ .](\d+\.\d+\.\d+)[ .]portable\.exe$/i;

function isNewer(latest, current) {
  const a = latest.replace(/^v/, '').split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

// Absolute paths of sibling portable exes strictly older than `version`
// (which may carry a leading "v"). The freshly downloaded exe is never listed
// because its version equals `version`; a running old exe IS listed as long
// as its filename matches the standard pattern.
function findOlderExes(dir, version) {
  let entries;
  try { entries = fs.readdirSync(dir); } catch (_) { return []; }
  const out = [];
  for (const name of entries) {
    const m = PORTABLE_EXE_RE.exec(name);
    if (m && isNewer(version, m[1])) out.push(path.join(dir, name));
  }
  return out;
}

// Delete older portable exes (and orphaned .part downloads) sitting next to
// the running one. If a post-update cleanup batch ever fails, the previous
// version's exe stays behind and launching it re-triggers the update prompt.
// Best-effort: anything still locked is retried on the next launch.
// Newer-versioned siblings are left alone.
function cleanupStaleExes() {
  const currentExe = process.env.PORTABLE_EXECUTABLE_FILE;
  const dir = path.dirname(currentExe);
  let entries;
  try { entries = fs.readdirSync(dir); } catch (_) { return; }
  for (const name of entries) {
    const full = path.join(dir, name);
    if (full.toLowerCase() === currentExe.toLowerCase()) continue;
    const exeMatch = PORTABLE_EXE_RE.exec(name);
    if (exeMatch) {
      if (isNewer(app.getVersion(), exeMatch[1])) {
        try { fs.unlinkSync(full); } catch (_) { /* still locked — next launch */ }
      }
      continue;
    }
    // A finished download gets renamed, so any surviving .part is a dead one.
    if (/^hivemind[ .].*portable\.exe\.part$/i.test(name)) {
      try { fs.unlinkSync(full); } catch (_) { /* still locked — next launch */ }
    }
  }
}

function httpsGet(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': USER_AGENT },
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        resolve(httpsGet(res.headers.location, redirectsLeft - 1));
        return;
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.setTimeout(5000, () => req.destroy());
    req.on('error', reject);
  });
}

// Stream a URL to `destPath`. Every failure mode — write-stream error (disk
// full / permission), response-stream error (connection dropped mid-body), a
// bad or non-HTTPS redirect, an idle stall — rejects the promise exactly once
// instead of throwing an unhandled 'error' that would crash the main process.
function downloadToFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      file.destroy();
      reject(err);
    };
    file.on('error', fail);

    function download(u, redirectsLeft = 5) {
      let parsed;
      try { parsed = new URL(u); } catch (_) { return fail(new Error(`Invalid download URL: ${u}`)); }
      // Only ever fetch over HTTPS — a redirect to http:// would silently drop
      // TLS and (via `https.get`) throw synchronously here otherwise.
      if (parsed.protocol !== 'https:') return fail(new Error(`Refusing non-HTTPS download (${parsed.protocol})`));

      const req = https.get(parsed, { headers: { 'User-Agent': USER_AGENT } }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
          res.resume(); // drain so the socket can be reused/closed
          let next;
          try { next = new URL(res.headers.location, parsed).toString(); } catch (_) { return fail(new Error('Bad redirect location')); }
          download(next, redirectsLeft - 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          return fail(new Error(`Download failed (HTTP ${res.statusCode})`));
        }
        res.on('error', fail);
        res.pipe(file);
        file.on('finish', () => {
          if (settled) return;
          settled = true;
          file.close(err => (err ? reject(err) : resolve()));
        });
      });
      // Idle-stall guard: a server that sends headers then nothing must not
      // leave the update promise pending forever.
      req.setTimeout(120000, () => req.destroy(new Error('Download timed out')));
      req.on('error', fail);
    }
    download(url);
  });
}

async function checkForUpdates(win) {
  if (!process.env.PORTABLE_EXECUTABLE_FILE) return;

  cleanupStaleExes();

  try {
    const { statusCode, body } = await httpsGet(`https://api.github.com/repos/${REPO}/releases/latest`);
    if (statusCode !== 200) return;

    const release = JSON.parse(body);
    const latestTag = release.tag_name || '';
    if (!isNewer(latestTag, app.getVersion())) return;

    const portableAsset = (release.assets || []).find(a =>
      /portable/i.test(a.name) && /\.exe$/i.test(a.name)
    );

    // Single confirmation — on "Update Now" the app downloads and relaunches itself.
    const { response: updateResponse } = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Update Available',
      message: `A new version (${latestTag}) is available.\nYou are on v${app.getVersion()}.\n\nHivemind will download the update and restart automatically. Your boards and settings are not affected.\n\nUpdate now?`,
      buttons: ['Update Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (updateResponse !== 0) return;

    if (!portableAsset) {
      await dialog.showMessageBox(win, {
        type: 'info',
        title: 'Update',
        message: `Couldn't find a portable download in release ${latestTag}.\nDownload it manually from:\n${RELEASES_URL}`,
      });
      return;
    }

    const oldExePath = process.env.PORTABLE_EXECUTABLE_FILE;
    const currentDir = path.dirname(oldExePath);
    const newExePath = path.join(currentDir, `Hivemind ${latestTag.replace(/^v/, '')} portable.exe`);
    const partPath = `${newExePath}.part`;

    try {
      // Download to a .part file first so a failed/partial download can never
      // leave a half-written, launchable exe behind.
      await downloadToFile(portableAsset.browser_download_url, partPath);

      // Integrity check: a misbehaving proxy/captive portal can return a clean
      // HTTP 200 with a truncated body, which would otherwise be promoted and
      // launched. GitHub reports the exact asset byte size, so verify against
      // it before we touch the old exe. (No published hash to check, but a size
      // mismatch catches the truncation case that matters.)
      const expectedSize = Number(portableAsset.size) || 0;
      const gotSize = fs.statSync(partPath).size;
      if (expectedSize && gotSize !== expectedSize) {
        throw new Error(`Downloaded ${gotSize} bytes but expected ${expectedSize} — update aborted to protect the working copy.`);
      }

      // Promote the completed, size-verified download to its final name.
      try { fs.unlinkSync(newExePath); } catch (_) { /* didn't exist */ }
      fs.renameSync(partPath, newExePath);

      // Launch the new version. Deleting the old exe is destructive, so gate it
      // on the new process ACTUALLY spawning: the 'spawn' event fires only once
      // the OS started the process (catching a corrupt PE or AV-quarantined
      // download), and 'error' fires if it couldn't — in which case we keep the
      // old exe and tell the user rather than delete their only working copy.
      const child = spawn(newExePath, [], { detached: true, stdio: 'ignore' });
      let launchSettled = false;

      child.on('error', async (err) => {
        if (launchSettled) return;
        launchSettled = true;
        await dialog.showMessageBox(win, {
          type: 'error',
          title: 'Update Failed',
          message: `The updated version could not be started:\n${err.message}\n\nYour current version is unchanged. You can try again later, or download it manually from:\n${RELEASES_URL}`,
        });
      });

      child.on('spawn', () => {
        if (launchSettled) return;
        launchSettled = true;
        child.unref();

        // Delete the running exe AND every other older-versioned sibling, so a
        // folder that accumulated old copies is swept in one update. The old
        // exe stays locked until this process (and the portable launcher
        // wrapping it) fully exits, so retry the deletes for up to ~30s and
        // then give up rather than loop forever. `ping` is the delay because
        // `timeout` refuses to run without console input, which a hidden
        // window doesn't have.
        const staleExes = findOlderExes(currentDir, latestTag);
        if (!staleExes.some(p => p.toLowerCase() === oldExePath.toLowerCase())) {
          staleExes.push(oldExePath); // renamed exe won't match the pattern
        }
        const batPath = path.join(app.getPath('temp'), 'hivemind-update-cleanup.bat');
        fs.writeFileSync(batPath, [
          '@echo off',
          'set tries=0',
          ':loop',
          'set /a tries+=1',
          ...staleExes.map(p => `del /f /q "${p}" >nul 2>nul`),
          'if not exist ' + staleExes.map(p => `"${p}"`).join(' if not exist ') + ' goto done',
          'if %tries% geq 30 goto done',
          'ping -n 2 127.0.0.1 >nul',
          'goto loop',
          ':done',
          'del /f /q "%~f0"',
          '',
        ].join('\r\n'));
        spawn('cmd.exe', ['/c', batPath], { detached: true, stdio: 'ignore', windowsHide: true }).unref();

        app.quit();
        // node-pty's ConPTY children can keep the main process alive after
        // quit on Windows, leaving a hidden zombie that holds the old exe
        // locked forever. If quit hasn't actually exited shortly, force it.
        setTimeout(() => app.exit(0), 5000);
      });
    } catch (dlErr) {
      try { fs.unlinkSync(partPath); } catch (_) { /* nothing to clean */ }
      await dialog.showMessageBox(win, {
        type: 'error',
        title: 'Update Failed',
        message: `The update could not be downloaded:\n${dlErr.message}\n\nYou can try again later, or download it manually from:\n${RELEASES_URL}`,
      });
    }
  } catch (_) {
    // Network unavailable or any other error before the user opted in — ignore.
  }
}

module.exports = { checkForUpdates, findOlderExes };
