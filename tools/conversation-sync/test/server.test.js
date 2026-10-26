'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server');
const { validateSnapshot, publishSnapshot } = require('../publish-snapshot');

test('pairing, conversations and status require authentication; only liveness is public', async (t) => {
    const token = 'a'.repeat(40);
    const server = createServer({
        token,
        repository: 'owner/private',
        pairing: { qr: 'test-pairing' },
        sync: { ready: true, status: { phase: 'ready' }, intervalMs: 300000 },
        archive: {
            counts: () => ({ chats: 0, messages: 0 }),
            snapshot: () => [],
            files: () => [],
            file: () => undefined,
        },
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}`;
    for (const endpoint of [
        '/',
        '/api/status',
        '/api/qr.svg',
        '/api/export.json',
        '/api/files',
        '/files/test.md',
    ]) {
        assert.equal((await fetch(url + endpoint)).status, 401);
    }
    assert.equal((await fetch(url + '/healthz')).status, 200);
    const headers = {
        Authorization: `Basic ${Buffer.from(`sync:${token}`).toString('base64')}`,
    };
    const status = await fetch(url + '/api/status', { headers });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).intervalSeconds, 300);
    assert.equal(status.headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(url + '/api/qr.svg', { headers })).status, 200);
    assert.equal(
        (await fetch(url + '/api/export.json', { method: 'POST', headers }))
            .status,
        405,
    );
});

test('publisher rejects public repositories before requesting any conversation data', async () => {
    let requests = 0;
    const mockFetch = async () => {
        requests++;
        return { ok: true, json: async () => ({ private: false }) };
    };
    await assert.rejects(
        publishSnapshot(
            {
                SYNC_URL: 'https://archive.example',
                SYNC_ACCESS_TOKEN: 'secret',
                GITHUB_REPOSITORY: 'owner/public',
                GITHUB_TOKEN: 'test',
            },
            mockFetch,
        ),
        /public repository/,
    );
    assert.equal(requests, 1);
});

test('snapshot validation rejects traversal, duplicate filenames and the wrong repository', () => {
    const valid = { filename: 'Chat--0123456789abcdef.md', content: '# Chat' };
    const snapshot = { schema: 1, repository: 'owner/private', files: [valid] };
    assert.deepEqual(validateSnapshot(snapshot, 'owner/private'), [valid]);
    assert.throws(() => validateSnapshot(snapshot, 'other/private'));
    assert.throws(() =>
        validateSnapshot(
            { ...snapshot, files: [{ ...valid, filename: '../secret.md' }] },
            snapshot.repository,
        ),
    );
    assert.throws(() =>
        validateSnapshot(
            { ...snapshot, files: [valid, valid] },
            snapshot.repository,
        ),
    );
});
