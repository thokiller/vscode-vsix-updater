'use strict';

// Normalizes user-provided GitHub repository references into "owner/repo".
// Accepts "owner/repo" or a github.com URL (with optional .git suffix,
// trailing slash, or extra path segments like /releases).

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function normalizeSource(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    return { error: 'Repository must be a non-empty string.' };
  }
  let text = input.trim();
  const urlMatch = text.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^?#]+)/i);
  if (urlMatch) {
    text = urlMatch[1];
  } else if (/^(?:https?:)?\/\//.test(text) || /^[^/]+\.[^/]+\//.test(text)) {
    return { error: `Only github.com repositories are supported: "${input}"` };
  }
  const segments = text.split('/').filter((part) => part !== '');
  if (segments.length < 2) {
    return { error: `Expected "owner/repo" or a github.com URL: "${input}"` };
  }
  const owner = segments[0];
  const repoName = segments[1].replace(/\.git$/i, '');
  if (!NAME_PATTERN.test(owner) || !NAME_PATTERN.test(repoName)) {
    return { error: `Invalid repository name: "${input}"` };
  }
  return { repo: `${owner}/${repoName}` };
}

function sameRepo(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

module.exports = { normalizeSource, sameRepo };
