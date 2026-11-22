'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { makeZip, makeVsix } = require('./fixtures');
const { readVsixManifest, readZipEntry } = require('../lib/vsix');

test('reads stored and deflated zip entries', () => {
  const zip = makeZip([
    { name: 'plain.txt', data: 'hello' },
    { name: 'packed.txt', data: 'compressed content here', deflate: true }
  ]);
  assert.strictEqual(readZipEntry(zip, 'plain.txt').toString(), 'hello');
  assert.strictEqual(readZipEntry(zip, 'packed.txt').toString(), 'compressed content here');
  assert.strictEqual(readZipEntry(zip, 'missing.txt'), null);
});

test('reads the manifest from a VSIX', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vsix-updater-vsix-'));
  try {
    const vsixPath = path.join(dir, 'ext.vsix');
    await fs.writeFile(vsixPath, makeVsix({ publisher: 'pub', name: 'thing', version: '2.3.4', displayName: 'The Thing' }));
    const manifest = await readVsixManifest(vsixPath);
    assert.deepStrictEqual(manifest, {
      id: 'pub.thing',
      publisher: 'pub',
      name: 'thing',
      version: '2.3.4',
      displayName: 'The Thing'
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('rejects non-VSIX and corrupt files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vsix-updater-vsix-bad-'));
  try {
    const notZip = path.join(dir, 'not.vsix');
    await fs.writeFile(notZip, 'definitely not a zip file at all');
    await assert.rejects(() => readVsixManifest(notZip), /Not a valid zip/);

    const noManifest = path.join(dir, 'empty.vsix');
    await fs.writeFile(noManifest, makeZip([{ name: 'other.txt', data: 'x' }]));
    await assert.rejects(() => readVsixManifest(noManifest), /missing extension\/package\.json/);

    const badJson = path.join(dir, 'badjson.vsix');
    await fs.writeFile(badJson, makeZip([{ name: 'extension/package.json', data: '{ nope' }]));
    await assert.rejects(() => readVsixManifest(badJson), /invalid package\.json/);

    const incomplete = path.join(dir, 'incomplete.vsix');
    await fs.writeFile(incomplete, makeZip([{ name: 'extension/package.json', data: '{"name":"x"}' }]));
    await assert.rejects(() => readVsixManifest(incomplete), /missing publisher, name, or version/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
