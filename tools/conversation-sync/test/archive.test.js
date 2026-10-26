'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Archive } = require('../archive');

function fixture(t) {
    const root = fs.mkdtempSync(
        path.join(os.tmpdir(), 'whatsapp-archive-test-'),
    );
    const options = {
        dataDir: path.join(root, 'state'),
        outputDir: path.join(root, 'Messags'),
    };
    const archive = new Archive(options);
    t.after(() => {
        archive.close();
        fs.rmSync(root, { recursive: true, force: true });
    });
    return { archive, options };
}

const chat = { id: 'test@c.us', name: 'A conversation', isGroup: false };
function message(id, body, timestamp = 1700000000) {
    return {
        id: { _serialized: id },
        body,
        timestamp,
        from: chat.id,
        fromMe: false,
        type: 'chat',
    };
}

test('repeated imports deduplicate, add deltas, sort and do not rewrite unchanged files', (t) => {
    const { archive, options } = fixture(t);
    archive.reconcile(chat, [
        message('two', 'Second', 1700000002),
        message('one', 'First'),
    ]);
    assert.equal(archive.flush(), 1);
    const file = path.join(
        options.outputDir,
        archive.getChat(chat.id).filename,
    );
    const original = fs.readFileSync(file, 'utf8');
    assert.ok(original.indexOf('First') < original.indexOf('Second'));
    const stat = fs.statSync(file);
    archive.reconcile(chat, [message('two', 'Second', 1700000002)]);
    assert.equal(archive.flush(), 0);
    assert.equal(fs.statSync(file).mtimeMs, stat.mtimeMs);
    archive.reconcile(chat, [
        message('two', 'Second', 1700000002),
        message('three', 'Third', 1700000003),
    ]);
    assert.equal(archive.flush(), 1);
    assert.deepEqual(archive.counts(), { chats: 1, messages: 3 });
    assert.equal(
        fs.readFileSync(file, 'utf8').split('message-id: two').length - 1,
        1,
    );
});

test('conversation renames keep the filename and hostile titles stay inside the folder', (t) => {
    const { archive } = fixture(t);
    archive.reconcile({ ...chat, name: '../../<script>bad</script>' }, []);
    const filename = archive.getChat(chat.id).filename;
    assert.match(filename, /^[a-zA-Z0-9-]+--[a-f0-9]{16}\.md$/);
    archive.reconcile({ ...chat, name: 'New name' }, []);
    assert.equal(archive.getChat(chat.id).filename, filename);
    assert.match(archive.snapshot()[0].content, /New name/);
    archive.reconcile({ ...chat, id: 'other@c.us', name: 'New name' }, []);
    assert.equal(new Set(archive.files().map((file) => file.filename)).size, 2);
});

test('edits replace content, revocations redact it and stale history cannot restore it', (t) => {
    const { archive } = fixture(t);
    archive.reconcile(chat, [message('one', 'Original')]);
    archive.upsert(chat.id, message('one', 'Edited <img src="tracker">'), {
        edited: true,
    });
    let content = archive.snapshot()[0].content;
    assert.ok(!content.includes('Original'));
    assert.ok(!content.includes('<img'));
    assert.match(content, /&lt;img/);
    assert.match(content, /\*Edited\.\*/);
    archive.upsert(chat.id, message('one', 'Edited <img src="tracker">'), {
        deleted: true,
    });
    archive.reconcile(chat, [message('one', 'Original')]);
    content = archive.snapshot()[0].content;
    assert.ok(!content.includes('Original'));
    assert.ok(!content.includes('tracker'));
    assert.match(content, /Message deleted for everyone/);
});

test('cursor and messages survive reopening the database, and missing Markdown is regenerated', (t) => {
    const { archive, options } = fixture(t);
    archive.reconcile(chat, [message('one', 'Saved')]);
    archive.flush();
    const second = new Archive(options);
    try {
        assert.equal(second.getChat(chat.id).cursor, 'one');
        assert.equal(second.counts().messages, 1);
        fs.unlinkSync(
            path.join(options.outputDir, second.getChat(chat.id).filename),
        );
        assert.equal(second.flush(), 1);
        assert.match(second.snapshot()[0].content, /Saved/);
    } finally {
        second.close();
    }
});

test('a failed disk write leaves the conversation dirty for retry', (t) => {
    const { archive, options } = fixture(t);
    archive.reconcile(chat, [message('one', 'Saved')]);
    fs.rmdirSync(options.outputDir);
    fs.writeFileSync(options.outputDir, 'blocked');
    assert.throws(() => archive.flush());
    assert.equal(archive.getChat(chat.id).dirty, 1);
    fs.unlinkSync(options.outputDir);
    fs.mkdirSync(options.outputDir);
    assert.equal(archive.flush(), 1);
});

test('legacy archives retain messages and retry full history after migration', (t) => {
    const { archive, options } = fixture(t);
    archive.reconcile(chat, [message('one', 'Saved')]);
    archive.db.exec('ALTER TABLE chats DROP COLUMN history_complete');
    const migrated = new Archive(options);
    try {
        assert.equal(migrated.getChat(chat.id).cursor, 'one');
        assert.equal(migrated.getChat(chat.id).history_complete, 0);
        assert.equal(migrated.counts().messages, 1);
    } finally {
        migrated.close();
    }
});
