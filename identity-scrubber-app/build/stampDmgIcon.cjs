// electron-builder afterAllArtifactBuild hook.
//
// electron-builder applies our icon to the .app bundle (mac.icon) and to the
// mounted DMG volume (dmg.icon), but it has no option to set a custom Finder
// icon on the .dmg *file* itself — so the installer shows the generic
// disk-image icon. That icon lives in the file's resource fork / FinderInfo
// xattrs (not inside the disk image), so it must be stamped with Apple's CLI
// tools. This hook stamps build/icon.icns onto each produced .dmg file.
//
// Because the icon lives in xattrs and not in the signed DMG bytes, it does not
// affect code signing, notarization, or the auto-update blockmap. (It also
// means the icon may not survive a browser download, which strips resource
// forks — a macOS limitation, not something we can fix here.)

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

exports.default = async function stampDmgIcon(buildResult) {
  const icns = path.join(__dirname, 'icon.icns');
  if (!fs.existsSync(icns)) {
    console.warn(`[stampDmgIcon] ${icns} not found; skipping`);
    return;
  }

  const dmgs = (buildResult.artifactPaths || []).filter((p) => p.endsWith('.dmg'));
  for (const dmg of dmgs) {
    try {
      stamp(dmg, icns);
      console.log(`[stampDmgIcon] applied icon to ${path.basename(dmg)}`);
    } catch (err) {
      console.warn(`[stampDmgIcon] failed for ${path.basename(dmg)}: ${err.message}`);
    }
  }
};

function stamp(target, icns) {
  const id = Date.now();
  const tmpIcns = path.join(os.tmpdir(), `dmgicon-${id}.icns`);
  const tmpRsrc = path.join(os.tmpdir(), `dmgicon-${id}.rsrc`);
  try {
    fs.copyFileSync(icns, tmpIcns);
    // Give the .icns file its own custom icon, then lift that resource out.
    execFileSync('sips', ['-i', tmpIcns], { stdio: 'ignore' });
    const rsrc = execFileSync('DeRez', ['-only', 'icns', tmpIcns], { maxBuffer: 64 * 1024 * 1024 });
    fs.writeFileSync(tmpRsrc, rsrc);
    // Append the icon resource to the DMG and flag it as having a custom icon.
    execFileSync('Rez', ['-append', tmpRsrc, '-o', target]);
    execFileSync('SetFile', ['-a', 'C', target]);
  } finally {
    fs.rmSync(tmpIcns, { force: true });
    fs.rmSync(tmpRsrc, { force: true });
  }
}
