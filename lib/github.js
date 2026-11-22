'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

// Minimal GitHub REST client using the global fetch. The token, when set, is
// only ever sent to the API host; it is dropped on cross-origin redirects
// (release asset downloads redirect to a signed CDN URL) and never logged.

const DEFAULT_API_BASE = 'https://api.github.com';
const MAX_REDIRECTS = 5;

class GitHubError extends Error {
  constructor(message, { status, rateLimited } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.rateLimited = Boolean(rateLimited);
  }
}

function describeHttpError(response, repo) {
  const remaining = response.headers.get('x-ratelimit-remaining');
  if (response.status === 403 && remaining === '0') {
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    const resetText = Number.isFinite(reset) && reset > 0 ? ` (resets ${new Date(reset * 1000).toLocaleTimeString()})` : '';
    return new GitHubError(`GitHub API rate limit reached${resetText}. Configure a token to raise the limit.`, { status: 403, rateLimited: true });
  }
  if (response.status === 404) {
    return new GitHubError(`${repo}: not found. The repository may not exist, have no releases yet, or be private (configure a token with access).`, { status: 404 });
  }
  if (response.status === 401) {
    return new GitHubError('GitHub rejected the configured token (401). Check the token in the configuration file.', { status: 401 });
  }
  return new GitHubError(`GitHub request for ${repo} failed with HTTP ${response.status}.`, { status: response.status });
}

class GitHubClient {
  constructor({ apiBase = DEFAULT_API_BASE, token = '', fetchImpl = fetch } = {}) {
    this.apiBase = apiBase.replace(/\/+$/, '');
    this.apiHost = new URL(this.apiBase).host;
    this.token = token;
    this.fetch = fetchImpl;
  }

  headers(extra = {}) {
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'vsix-updater',
      ...extra
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }

  // Latest published release; GitHub excludes drafts and prereleases here.
  async getLatestRelease(repo) {
    const response = await this.fetch(`${this.apiBase}/repos/${repo}/releases/latest`, { headers: this.headers() });
    if (!response.ok) throw describeHttpError(response, repo);
    const release = await response.json();
    return {
      tagName: release.tag_name,
      name: release.name || release.tag_name,
      htmlUrl: release.html_url,
      assets: (release.assets || []).map((asset) => ({
        name: asset.name,
        url: asset.url,
        size: asset.size
      }))
    };
  }

  // Raw package.json at a tag, via the contents API so the token applies to
  // private repositories without a second host.
  async getPackageJsonAtRef(repo, ref) {
    const url = `${this.apiBase}/repos/${repo}/contents/package.json?ref=${encodeURIComponent(ref)}`;
    const response = await this.fetch(url, { headers: this.headers({ Accept: 'application/vnd.github.raw+json' }) });
    if (!response.ok) throw describeHttpError(response, repo);
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new GitHubError(`${repo}: package.json at ${ref} is not valid JSON: ${error.message}`);
    }
  }

  // Downloads a release asset to destPath, following redirects manually so
  // the Authorization header is only sent to the API host.
  async downloadAsset(assetUrl, destPath, onProgress) {
    let url = assetUrl;
    let response;
    for (let redirects = 0; ; redirects++) {
      const sameOrigin = new URL(url).host === this.apiHost;
      const headers = { Accept: 'application/octet-stream', 'User-Agent': 'vsix-updater' };
      if (this.token && sameOrigin) headers.Authorization = `Bearer ${this.token}`;
      response = await this.fetch(url, { headers, redirect: 'manual' });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw new GitHubError(`Download redirect from ${new URL(url).host} had no location.`);
        if (redirects >= MAX_REDIRECTS) throw new GitHubError('Download followed too many redirects.');
        url = new URL(location, url).toString();
        continue;
      }
      break;
    }
    if (!response.ok) throw describeHttpError(response, assetUrl);
    const expectedSize = Number(response.headers.get('content-length'));
    let received = 0;
    const counter = async function* (source) {
      for await (const chunk of source) {
        received += chunk.length;
        if (onProgress) onProgress(received, Number.isFinite(expectedSize) ? expectedSize : 0);
        yield chunk;
      }
    };
    try {
      await pipeline(Readable.fromWeb(response.body), counter, fs.createWriteStream(destPath));
      if (Number.isFinite(expectedSize) && expectedSize > 0 && received !== expectedSize) {
        throw new GitHubError(`Download incomplete: received ${received} of ${expectedSize} bytes.`);
      }
    } catch (error) {
      await fsp.rm(destPath, { force: true });
      throw error;
    }
  }
}

module.exports = { GitHubClient, GitHubError, DEFAULT_API_BASE };
