/**
 * @file src/agent/servefile.mjs
 * @module agent/servefile
 * @purpose The record of the server on the disk.
 *
 *   The extension reads the record `serve.json` through the API of the editor, but the
 *   stdio server of the editor runs outside of the editor: it reads the file itself.
 *   The module lives apart from the address of the server, so the code of the extension
 *   keeps away from the file system of Node.js.
 *
 * @depends node:fs/promises, agent/endpoint
 * @usedBy agent/mcpstdio
 * @exports readServeRecordFile, readFirstServeRecordFile
 * @ai.tags serve, record, io
 * @ai.hint io
 */

import { readFile } from 'node:fs/promises';
import { parseServeRecord, pidAlive } from './endpoint.mjs';

/**
 * Read the record of the server from a home of it.
 *
 * @param {string} dir the home of the server
 * @returns {Promise<object|null>}
 */
export async function readServeRecordFile(dir) {
    if (typeof dir !== 'string' || !dir.trim()) {
        return null;
    }
    try {
        const text = await readFile(`${dir.replace(/[\\/]+$/, '')}/serve.json`, 'utf8');
        return parseServeRecord(text);
    } catch {
        return null;
    }
}

/**
 * The record of the first home that has a live one.
 *
 * A record of a dead process is no record: the server is gone.
 *
 * @param {string[]} dirs the homes, in the order of the priority
 * @returns {Promise<object|null>}
 */
export async function readFirstServeRecordFile(dirs) {
    for (const dir of Array.isArray(dirs) ? dirs : []) {
        const record = await readServeRecordFile(dir);
        if (record && pidAlive(record.pid)) {
            return record;
        }
    }
    return null;
}
