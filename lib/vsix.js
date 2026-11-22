'use strict';

const fs = require('node:fs/promises');
const zlib = require('node:zlib');

// Reads extension/package.json out of a VSIX (a standard zip) to validate the
// downloaded package before installing it. Supports stored and deflated
// entries, which covers packages produced by vsce.

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function findEndOfCentralDirectory(buffer) {
  const earliest = Math.max(0, buffer.length - 22 - 65535);
  for (let offset = buffer.length - 22; offset >= earliest; offset--) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

function readZipEntry(buffer, entryName) {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd === -1) throw new Error('Not a valid zip file (no end-of-central-directory record).');
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < entryCount; i++) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error('Corrupt zip central directory.');
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (name === entryName) {
      if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
        throw new Error('Corrupt zip local header.');
      }
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const data = buffer.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error(`Unsupported zip compression method ${method} for ${entryName}.`);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

// Returns { id, publisher, name, version, displayName } from the VSIX.
async function readVsixManifest(filePath) {
  const buffer = await fs.readFile(filePath);
  const data = readZipEntry(buffer, 'extension/package.json');
  if (!data) throw new Error('The downloaded file is not a VSIX (missing extension/package.json).');
  let manifest;
  try {
    manifest = JSON.parse(data.toString('utf8'));
  } catch (error) {
    throw new Error(`The VSIX contains an invalid package.json: ${error.message}`);
  }
  const { publisher, name, version, displayName } = manifest;
  if (typeof publisher !== 'string' || typeof name !== 'string' || typeof version !== 'string') {
    throw new Error('The VSIX package.json is missing publisher, name, or version.');
  }
  return { id: `${publisher}.${name}`, publisher, name, version, displayName: displayName || name };
}

module.exports = { readVsixManifest, readZipEntry };
