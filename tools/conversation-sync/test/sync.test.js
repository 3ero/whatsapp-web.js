'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Archive } = require('../archive');
const { ConversationSync } = require('../sync');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-sync-test-'));
    const archive = new Archive({
        dataDir: root,
        outputDir: path.join(root, 'Messags'),
    });
    const client = new EventEmitter();
    const sync = new ConversationSync({ client, archive, pageSize: 2 });
    sync.ready = true;
    t.after(async () => {
        await sync.stop();
        archive.close();
        fs.rmSync(root, { recursive: true, force: true });
    });
    return { archive, client, sync };
}

function message(n) {
    return {
        id: { _serialized: `msg-${n}` },
        body: `body ${n}`,
        timestamp: 1700000000 + n,
        from: 'chat@c.us',
        to: 'me@c.us',
        type: 'chat',
    };
}

test('catch-up expands past the first page to cover a busy conversation', async (t) => {
    const { archive, client, sync } = fixture(t);
    const info = { id: 'chat@c.us', name: 'Chat' };
    archive.reconcile(info, [message(1)]);
    const messages = Array.from({ length: 10 }, (_, n) => message(n + 1));
    const calls = [];
    client.getChats = async () => [
        {
            id: { _serialized: info.id },
            name: info.name,
            fetchMessages: async ({ limit }) => {
                calls.push(limit);
                return messages.slice(-limit);
            },
        },
    ];
    assert.equal(await sync.run(), true);
    assert.deepEqual(calls, [2, 4, 8, 16]);
    assert.equal(archive.counts().messages, 10);
    assert.equal(archive.getChat(info.id).cursor, 'msg-10');
});

test('new conversations import all available history and failed chats retry without losing others', async (t) => {
    const { archive, client, sync } = fixture(t);
    const chat = {
        id: { _serialized: 'chat@c.us' },
        name: 'Chat',
        fetchMessages: async (options) => {
            // The real browser receives nested arguments through JSON/CDP.
            const received = JSON.parse(JSON.stringify(options));
            assert.equal(received.limit, Number.MAX_SAFE_INTEGER);
            return [message(1)];
        },
    };
    client.getChats = async () => [
        chat,
        {
            id: { _serialized: 'broken@c.us' },
            fetchMessages: async () => {
                throw new Error('offline');
            },
        },
    ];
    assert.equal(await sync.run(), false);
    assert.equal(archive.counts().messages, 1);
    assert.equal(sync.status.failures, 1);
    assert.equal(archive.getChat('broken@c.us'), undefined);
    chat.fetchMessages = async () => [message(1)];
    client.getChats = async () => [chat];
    assert.equal(await sync.run(), true);
});

test('a legacy cursor does not skip the corrected first history import', async (t) => {
    const { archive, sync } = fixture(t);
    const info = { id: 'chat@c.us', name: 'Chat' };
    archive.reconcile(info, [message(2)]);
    archive.db
        .prepare('UPDATE chats SET history_complete = 0 WHERE id = ?')
        .run(info.id);
    let limit;
    const messages = await sync.history({
        id: { _serialized: info.id },
        fetchMessages: async (options) => {
            limit = JSON.parse(JSON.stringify(options)).limit;
            return [message(1), message(2)];
        },
    });
    assert.equal(limit, Number.MAX_SAFE_INTEGER);
    archive.reconcile(info, messages);
    assert.equal(archive.counts().messages, 2);
    assert.equal(archive.getChat(info.id).history_complete, 1);
});

test('live outgoing messages, edits and deletions are persisted before the scheduled flush', (t) => {
    const { archive, client, sync } = fixture(t);
    sync.attach();
    const outgoing = {
        ...message(1),
        fromMe: true,
        to: 'group@g.us',
        from: 'me@c.us',
    };
    client.emit('message_create', outgoing);
    assert.equal(archive.getChat('group@g.us').isGroup, true);
    client.emit('message_edit', outgoing, 'Replacement');
    assert.equal(archive.messages('group@g.us')[0].body, 'Replacement');
    client.emit('message_revoke_everyone', { ...outgoing, type: 'revoked' });
    assert.equal(archive.messages('group@g.us')[0].body, '');
    assert.equal(archive.messages('group@g.us')[0].deleted, 1);
});

test('concurrent refresh requests share one reconciliation', async (t) => {
    const { client, sync } = fixture(t);
    let calls = 0;
    let release;
    client.getChats = () => {
        calls++;
        return new Promise((resolve) => {
            release = resolve;
        });
    };
    const first = sync.run();
    const second = sync.run();
    assert.equal(first, second);
    release([]);
    await first;
    assert.equal(calls, 1);
});
