'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

function validateSnapshot(snapshot, repository) {
    if (
        snapshot.schema !== 1 ||
        snapshot.repository !== repository ||
        !Array.isArray(snapshot.files)
    ) {
        throw new Error(
            'The archive schema or repository does not match this private repository.',
        );
    }
    const names = new Set();
    for (const file of snapshot.files) {
        if (
            !/^[a-zA-Z0-9-]+--[a-f0-9]{16}\.md$/.test(file.filename) ||
            typeof file.content !== 'string' ||
            names.has(file.filename)
        ) {
            throw new Error(
                'The archive contains an invalid or duplicate filename.',
            );
        }
        names.add(file.filename);
    }
    return snapshot.files;
}

async function publishSnapshot(env = process.env, fetchImpl = fetch) {
    const { SYNC_URL, SYNC_ACCESS_TOKEN, GITHUB_REPOSITORY, GITHUB_TOKEN } =
        env;
    if (
        !SYNC_URL ||
        !SYNC_ACCESS_TOKEN ||
        !GITHUB_REPOSITORY ||
        !GITHUB_TOKEN
    ) {
        throw new Error(
            'Configure SYNC_URL and SYNC_ACCESS_TOKEN repository secrets before publication.',
        );
    }
    const base = new URL(SYNC_URL);
    if (
        base.protocol !== 'https:' ||
        base.username ||
        base.password ||
        base.search ||
        base.hash
    ) {
        throw new Error(
            'SYNC_URL must be an HTTPS URL without credentials or query parameters.',
        );
    }
    const repoResponse = await fetchImpl(
        `https://api.github.com/repos/${GITHUB_REPOSITORY}`,
        {
            headers: {
                Authorization: `Bearer ${GITHUB_TOKEN}`,
                Accept: 'application/vnd.github+json',
            },
            redirect: 'error',
            signal: AbortSignal.timeout(30000),
        },
    );
    if (!repoResponse.ok || (await repoResponse.json()).private !== true) {
        throw new Error(
            'Refusing to publish conversation files to an unverified or public repository.',
        );
    }
    const response = await fetchImpl(new URL('/api/export.json', base), {
        headers: {
            Authorization: `Basic ${Buffer.from(`sync:${SYNC_ACCESS_TOKEN}`).toString('base64')}`,
        },
        redirect: 'error',
        signal: AbortSignal.timeout(120000),
    });
    if (!response.ok)
        throw new Error(`Archive download failed (${response.status}).`);
    const files = validateSnapshot(await response.json(), GITHUB_REPOSITORY);
    const folder = path.resolve('Messags');
    const folderInfo = await fs.lstat(folder).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
    });
    if (folderInfo?.isSymbolicLink())
        throw new Error('Messags must be a real directory.');
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    for (const file of files) {
        const destination = path.join(folder, file.filename);
        const info = await fs.lstat(destination).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
        });
        if (info?.isSymbolicLink())
            throw new Error('Export files must not be symbolic links.');
        await fs.writeFile(destination, file.content, { mode: 0o600 });
    }
    console.log(
        `Refreshed ${files.length} conversation file(s) in the private repository.`,
    );
}

if (require.main === module) {
    publishSnapshot().catch((error) => {
        console.error(error.message);
        process.exit(1);
    });
}

module.exports = { publishSnapshot, validateSnapshot };
