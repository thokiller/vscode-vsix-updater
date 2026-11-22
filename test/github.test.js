'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { GitHubClient } = require('../lib/github');
const { startFakeGitHub } = require('./fixtures');

function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((done) => server.close(done))
    }));
  });
}

test('sends the token to the API host and parses the latest release', async () => {
  const fake = await startFakeGitHub();
  try {
    fake.served.repos.set('owner/repo', {
      tagName: 'v1.2.0',
      packageJson: { publisher: 'pub', name: 'ext', version: '1.2.0' },
      assets: [{ name: 'ext-1.2.0.vsix', vsix: Buffer.from('x') }]
    });
    const client = new GitHubClient({ apiBase: fake.baseUrl, token: 'secret-token' });
    const release = await client.getLatestRelease('owner/repo');
    assert.strictEqual(release.tagName, 'v1.2.0');
    assert.strictEqual(release.assets.length, 1);
    const manifest = await client.getPackageJsonAtRef('owner/repo', release.tagName);
    assert.strictEqual(manifest.version, '1.2.0');
    for (const request of fake.served.requests) {
      assert.strictEqual(request.authorization, 'Bearer secret-token');
    }
  } finally {
    await fake.close();
  }
});

test('drops the token on cross-origin download redirects', async () => {
  const cdnRequests = [];
  const cdn = await startServer((request, response) => {
    cdnRequests.push({ authorization: request.headers.authorization || null });
    const body = Buffer.from('vsix-bytes');
    response.writeHead(200, { 'content-length': body.length });
    response.end(body);
  });
  const api = await startServer((request, response) => {
    response.writeHead(302, { location: `${cdn.baseUrl}/signed/download` });
    response.end();
  });
  try {
    // The API and CDN run on different ports, so they are different origins.
    const client = new GitHubClient({ apiBase: api.baseUrl, token: 'secret-token' });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vsix-updater-dl-'));
    const dest = path.join(dir, 'out.vsix');
    try {
      const progress = [];
      await client.downloadAsset(`${api.baseUrl}/repos/o/r/releases/assets/1`, dest, (received, total) => progress.push([received, total]));
      assert.strictEqual((await fs.readFile(dest)).toString(), 'vsix-bytes');
      assert.strictEqual(cdnRequests.length, 1);
      assert.strictEqual(cdnRequests[0].authorization, null);
      assert.ok(progress.length > 0);
      assert.deepStrictEqual(progress[progress.length - 1], [10, 10]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  } finally {
    await api.close();
    await cdn.close();
  }
});

test('reports rate limiting and missing repositories clearly', async () => {
  const limited = await startServer((request, response) => {
    response.writeHead(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '0' });
    response.end('{}');
  });
  try {
    const client = new GitHubClient({ apiBase: limited.baseUrl });
    await assert.rejects(() => client.getLatestRelease('o/r'), (error) => {
      assert.ok(error.rateLimited);
      assert.match(error.message, /rate limit/);
      return true;
    });
  } finally {
    await limited.close();
  }
  const missing = await startServer((request, response) => {
    response.writeHead(404);
    response.end('{}');
  });
  try {
    const client = new GitHubClient({ apiBase: missing.baseUrl });
    await assert.rejects(() => client.getLatestRelease('o/r'), /not found|no releases|private/);
  } finally {
    await missing.close();
  }
});

test('rejects incomplete downloads and removes the temp file', async () => {
  const truncating = await startServer((request, response) => {
    response.writeHead(200, { 'content-length': 100 });
    response.write('only a little');
    response.destroy();
  });
  try {
    const client = new GitHubClient({ apiBase: truncating.baseUrl });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vsix-updater-trunc-'));
    const dest = path.join(dir, 'out.vsix');
    try {
      await assert.rejects(() => client.downloadAsset(`${truncating.baseUrl}/asset`, dest));
      await assert.rejects(() => fs.access(dest));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  } finally {
    await truncating.close();
  }
});
