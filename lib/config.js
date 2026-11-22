'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { normalizeSource, sameRepo } = require('./sources');

// The user-level configuration file lives in the extension's global storage
// and is shared across workspaces. It is strict JSON (no comments).

const CONFIG_FILE_NAME = 'config.json';

const CONFIG_TEMPLATE = {
  sources: [],
  token: '',
  checkOnStartup: true,
  periodicCheckHours: 0
};

const KNOWN_KEYS = new Set(Object.keys(CONFIG_TEMPLATE));

// Validates a parsed configuration object. Returns the effective config plus
// a list of human-readable problems. Valid parts are kept so one bad entry
// does not disable everything else.
function validateConfig(raw) {
  const errors = [];
  const config = {
    sources: [],
    token: '',
    checkOnStartup: true,
    periodicCheckHours: 0
  };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { config, errors: ['Configuration must be a JSON object.'] };
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) errors.push(`Unknown setting "${key}" is ignored.`);
  }
  if (raw.sources !== undefined) {
    if (!Array.isArray(raw.sources)) {
      errors.push('"sources" must be an array of "owner/repo" strings or { "repo": ... } objects.');
    } else {
      raw.sources.forEach((entry, index) => {
        let repoInput;
        let asset = '';
        if (typeof entry === 'string') {
          repoInput = entry;
        } else if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
          repoInput = entry.repo;
          if (entry.asset !== undefined) {
            if (typeof entry.asset === 'string' && entry.asset.trim() !== '') {
              asset = entry.asset.trim();
            } else {
              errors.push(`sources[${index}]: "asset" must be a non-empty string (the exact .vsix file name).`);
              return;
            }
          }
        } else {
          errors.push(`sources[${index}]: must be an "owner/repo" string or an object with a "repo" property.`);
          return;
        }
        const normalized = normalizeSource(repoInput);
        if (normalized.error) {
          errors.push(`sources[${index}]: ${normalized.error}`);
          return;
        }
        if (config.sources.some((existing) => sameRepo(existing.repo, normalized.repo))) {
          errors.push(`sources[${index}]: duplicate repository "${normalized.repo}" is ignored.`);
          return;
        }
        config.sources.push({ repo: normalized.repo, asset });
      });
    }
  }
  if (raw.token !== undefined) {
    if (typeof raw.token === 'string') {
      config.token = raw.token.trim();
    } else {
      errors.push('"token" must be a string (a GitHub personal access token, or empty).');
    }
  }
  if (raw.checkOnStartup !== undefined) {
    if (typeof raw.checkOnStartup === 'boolean') {
      config.checkOnStartup = raw.checkOnStartup;
    } else {
      errors.push('"checkOnStartup" must be true or false.');
    }
  }
  if (raw.periodicCheckHours !== undefined) {
    if (typeof raw.periodicCheckHours === 'number' && Number.isFinite(raw.periodicCheckHours) && raw.periodicCheckHours >= 0) {
      config.periodicCheckHours = raw.periodicCheckHours;
    } else {
      errors.push('"periodicCheckHours" must be a number of hours (0 disables periodic checks).');
    }
  }
  return { config, errors };
}

// Loads the configuration file. A missing file yields the defaults with
// missing=true; an unreadable or invalid file keeps its contents on disk and
// reports errors instead.
async function loadConfig(configPath) {
  let text;
  try {
    text = await fs.readFile(configPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { config: { ...CONFIG_TEMPLATE, sources: [] }, errors: [], missing: true };
    }
    return {
      config: { ...CONFIG_TEMPLATE, sources: [] },
      errors: [`Could not read ${configPath}: ${error.message}`],
      missing: false
    };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      config: { ...CONFIG_TEMPLATE, sources: [] },
      errors: [`${path.basename(configPath)} is not valid JSON: ${error.message}`],
      missing: false
    };
  }
  const { config, errors } = validateConfig(raw);
  return { config, errors, missing: false };
}

// Creates the configuration file with the empty template if it is missing.
// Never overwrites an existing file, even an invalid one.
async function ensureConfigFile(configPath) {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  try {
    await fs.writeFile(configPath, JSON.stringify(CONFIG_TEMPLATE, null, 2) + '\n', { flag: 'wx' });
    return true;
  } catch (error) {
    if (error && error.code === 'EEXIST') return false;
    throw error;
  }
}

// Adds a repository to the sources array in the file, preserving all other
// content verbatim. Returns { added } or { error }.
async function addSourceToFile(configPath, repoInput) {
  const normalized = normalizeSource(repoInput);
  if (normalized.error) return { error: normalized.error };
  await ensureConfigFile(configPath);
  const text = await fs.readFile(configPath, 'utf8');
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { error: `The configuration file is not valid JSON, fix it first: ${error.message}` };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'The configuration file must contain a JSON object, fix it first.' };
  }
  if (raw.sources === undefined) raw.sources = [];
  if (!Array.isArray(raw.sources)) {
    return { error: 'The "sources" setting in the configuration file is not an array, fix it first.' };
  }
  const { config } = validateConfig(raw);
  if (config.sources.some((existing) => sameRepo(existing.repo, normalized.repo))) {
    return { error: `"${normalized.repo}" is already configured.` };
  }
  raw.sources.push(normalized.repo);
  await fs.writeFile(configPath, JSON.stringify(raw, null, 2) + '\n');
  return { added: normalized.repo };
}

module.exports = { CONFIG_FILE_NAME, CONFIG_TEMPLATE, validateConfig, loadConfig, ensureConfigFile, addSourceToFile };
