'use strict';

const { isNewerVersion } = require('./version');

// Per-source check logic, kept free of vscode imports so it is unit-testable.

// Picks the VSIX asset from a release. Multiple VSIX assets require an
// explicit per-source "asset" file name so we never pick one arbitrarily.
function selectVsixAsset(assets, configuredName) {
  const vsixAssets = (assets || []).filter((asset) => /\.vsix$/i.test(asset.name));
  if (configuredName) {
    const match = (assets || []).find((asset) => asset.name === configuredName);
    if (match) return { asset: match };
    return { error: `the release has no asset named "${configuredName}".` };
  }
  if (vsixAssets.length === 0) return { error: 'the latest release has no .vsix asset.' };
  if (vsixAssets.length > 1) {
    const names = vsixAssets.map((asset) => asset.name).join(', ');
    return { error: `the release has multiple .vsix assets (${names}); set "asset" for this source in the configuration file.` };
  }
  return { asset: vsixAssets[0] };
}

// Checks one source. getInstalledVersion(id) returns the installed version
// string or undefined. Result status: 'install' | 'update' | 'up-to-date' | 'error'.
async function checkSource(client, source, { getInstalledVersion }) {
  const { repo, asset: configuredAsset } = source;
  try {
    const release = await client.getLatestRelease(repo);
    const manifest = await client.getPackageJsonAtRef(repo, release.tagName);
    const { publisher, name, version, displayName } = manifest;
    if (typeof publisher !== 'string' || typeof name !== 'string' || typeof version !== 'string') {
      return { repo, status: 'error', error: `${repo}: package.json at ${release.tagName} is missing publisher, name, or version.` };
    }
    const id = `${publisher}.${name}`;
    const selected = selectVsixAsset(release.assets, configuredAsset);
    if (selected.error) return { repo, status: 'error', error: `${repo}: ${selected.error}` };
    const installedVersion = getInstalledVersion(id);
    const update = {
      repo,
      id,
      displayName: displayName || name,
      installedVersion,
      availableVersion: version,
      tagName: release.tagName,
      releaseUrl: release.htmlUrl,
      asset: selected.asset
    };
    if (installedVersion === undefined) return { repo, status: 'install', update };
    let newer;
    try {
      newer = isNewerVersion(version, installedVersion);
    } catch (error) {
      return { repo, status: 'error', error: `${repo}: ${error.message}` };
    }
    return newer ? { repo, status: 'update', update } : { repo, status: 'up-to-date', update };
  } catch (error) {
    return { repo, status: 'error', error: error.message };
  }
}

// Resolves "owner/repo" from a package.json repository field; null when the
// metadata is missing or not a github.com repository.
function parseRepositoryField(repository) {
  const url = typeof repository === 'string' ? repository : (repository && typeof repository.url === 'string' ? repository.url : '');
  const match = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

module.exports = { selectVsixAsset, checkSource, parseRepositoryField };
