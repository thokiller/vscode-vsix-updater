'use strict';

const zlib = require('node:zlib');
const http = require('node:http');

// Minimal zip writer used to build VSIX fixtures without dependencies.

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let k = 0; k < 8; k++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// entries: [{ name, data: string|Buffer, deflate?: boolean }]
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const method = entry.deflate ? 8 : 0;
    const stored = entry.deflate ? zlib.deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuffer]));
    locals.push(Buffer.concat([local, nameBuffer, stored]));
    offset += 30 + nameBuffer.length + stored.length;
  }
  const centralData = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralData.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralData, eocd]);
}

// A VSIX fixture that VS Code accepts via workbench.extensions.installExtension.
function makeVsix({ publisher = 'local', name = 'dummy-ext', version = '1.0.0', displayName = 'Dummy Extension' } = {}) {
  const manifest = {
    name,
    displayName,
    version,
    publisher,
    engines: { vscode: '^1.0.0' },
    main: './extension.js',
    activationEvents: []
  };
  const vsixManifest = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">',
    '  <Metadata>',
    `    <Identity Language="en-US" Id="${name}" Version="${version}" Publisher="${publisher}" />`,
    `    <DisplayName>${displayName}</DisplayName>`,
    `    <Description xml:space="preserve">${displayName}</Description>`,
    '  </Metadata>',
    '  <Installation>',
    '    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>',
    '  </Installation>',
    '  <Dependencies/>',
    '  <Assets>',
    '    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />',
    '  </Assets>',
    '</PackageManifest>'
  ].join('\n');
  const contentTypes = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '  <Default Extension=".json" ContentType="application/json"/>',
    '  <Default Extension=".vsixmanifest" ContentType="text/xml"/>',
    '  <Default Extension=".js" ContentType="application/javascript"/>',
    '</Types>'
  ].join('\n');
  return makeZip([
    { name: 'extension.vsixmanifest', data: vsixManifest },
    { name: '[Content_Types].xml', data: contentTypes },
    { name: 'extension/package.json', data: JSON.stringify(manifest, null, 2), deflate: true },
    { name: 'extension/extension.js', data: 'exports.activate = function () {};\n' }
  ]);
}

// Fake GitHub API + release asset server for tests. state.repos maps
// "owner/repo" to { tagName, packageJson, assets: [{ name, vsix: Buffer }] }.
function startFakeGitHub() {
  const served = { repos: new Map(), requests: [] };
  const server = http.createServer((request, response) => {
    served.requests.push({ url: request.url, authorization: request.headers.authorization || null });
    const releaseMatch = request.url.match(/^\/repos\/([^/]+\/[^/]+)\/releases\/latest$/);
    const contentsMatch = request.url.match(/^\/repos\/([^/]+\/[^/]+)\/contents\/package\.json\?ref=(.+)$/);
    const assetMatch = request.url.match(/^\/repos\/([^/]+\/[^/]+)\/releases\/assets\/(\d+)$/);
    const base = `http://127.0.0.1:${server.address().port}`;
    if (releaseMatch) {
      const repo = served.repos.get(releaseMatch[1]);
      if (!repo) { response.writeHead(404).end('{}'); return; }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        tag_name: repo.tagName,
        name: repo.tagName,
        html_url: `${base}/releases/${repo.tagName}`,
        assets: repo.assets.map((asset, index) => ({
          name: asset.name,
          url: `${base}/repos/${releaseMatch[1]}/releases/assets/${index}`,
          size: asset.vsix ? asset.vsix.length : 0
        }))
      }));
      return;
    }
    if (contentsMatch) {
      const repo = served.repos.get(contentsMatch[1]);
      if (!repo) { response.writeHead(404).end('{}'); return; }
      response.writeHead(200, { 'content-type': 'application/vnd.github.raw+json' });
      response.end(JSON.stringify(repo.packageJson));
      return;
    }
    if (assetMatch) {
      const repo = served.repos.get(assetMatch[1]);
      const asset = repo && repo.assets[Number(assetMatch[2])];
      if (!asset) { response.writeHead(404).end('{}'); return; }
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': asset.vsix.length });
      response.end(asset.vsix);
      return;
    }
    response.writeHead(404).end('{}');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        served,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

module.exports = { crc32, makeZip, makeVsix, startFakeGitHub };
