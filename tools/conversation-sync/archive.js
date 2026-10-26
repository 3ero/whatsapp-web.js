'use strict';

const { DatabaseSync } = require('node:sqlite');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function escapeMarkdown(value) {
    return String(value || '')
        .replace(/\r\n?/g, '\n')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/([\\`*_{}[\]()#+.!|~-])/g, '\\$1');
}

function renderChat(chat, messages) {
    const lines = [
        '---',
        `title: ${JSON.stringify(chat.name)}`,
        `chat_id: ${JSON.stringify(chat.id)}`,
        `kind: ${chat.isGroup ? 'group' : 'direct'}`,
        'source: WhatsApp Web',
        '---',
        '',
        `# ${escapeMarkdown(chat.name)}`,
        '',
        '> Captured from the history available to the linked WhatsApp Web session.',
        '> Times are UTC. Attachments are described; their files are not downloaded.',
        '',
    ];
    for (const message of messages) {
        const sender = message.fromMe ? 'Me' : message.sender;
        const timestamp = new Date(message.timestamp * 1000).toISOString();
        const safeId = message.id
            .replace(/[^a-zA-Z0-9_:@.-]/g, '')
            .replace(/--/g, '');
        lines.push(`<!-- message-id: ${safeId} -->`);
        lines.push(`### ${timestamp} — ${escapeMarkdown(sender)}`, '');
        if (message.deleted) {
            lines.push('*Message deleted for everyone.*');
        } else {
            if (message.body) lines.push(escapeMarkdown(message.body));
            if (message.hasMedia) {
                lines.push('', `*Attachment: ${escapeMarkdown(message.type)}*`);
            } else if (!message.body) {
                lines.push(`*Message type: ${escapeMarkdown(message.type)}*`);
            }
            if (message.edited) lines.push('', '*Edited.*');
        }
        lines.push('');
    }
    return lines.join('\n');
}

class Archive {
    constructor({ dataDir, outputDir }) {
        fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
        this.outputDir = outputDir;
        this.db = new DatabaseSync(path.join(dataDir, 'archive.sqlite'));
        this.db.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = FULL;
            CREATE TABLE IF NOT EXISTS chats (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, is_group INTEGER NOT NULL,
                filename TEXT NOT NULL UNIQUE, cursor TEXT, dirty INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, timestamp INTEGER NOT NULL,
                sender TEXT NOT NULL, from_me INTEGER NOT NULL, body TEXT NOT NULL,
                type TEXT NOT NULL, has_media INTEGER NOT NULL,
                edited INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS message_order ON messages(chat_id, timestamp, id);
        `);
        if (
            !this.db
                .prepare('PRAGMA table_info(chats)')
                .all()
                .some((column) => column.name === 'history_complete')
        ) {
            // Existing cursors may come from an older cached-messages-only import.
            this.db.exec(
                'ALTER TABLE chats ADD COLUMN history_complete INTEGER NOT NULL DEFAULT 0',
            );
        }
    }

    getChat(id) {
        const row = this.db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
        return row ? { ...row, isGroup: Boolean(row.is_group) } : undefined;
    }

    ensureChat({ id, name, isGroup = false }) {
        if (!id || /broadcast|newsletter/.test(id)) return undefined;
        const existing = this.getChat(id);
        const title = name || existing?.name || id;
        const slug =
            title
                .normalize('NFKD')
                .replace(/[\u0300-\u036f]/g, '')
                .replace(/[^a-zA-Z0-9 -]/g, '')
                .trim()
                .replace(/\s+/g, '-')
                .slice(0, 65) || 'conversation';
        const suffix = createHash('sha256')
            .update(id)
            .digest('hex')
            .slice(0, 16);
        this.db
            .prepare(
                `
            INSERT INTO chats(id, name, is_group, filename) VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                dirty = CASE WHEN name != excluded.name OR is_group != excluded.is_group
                             THEN 1 ELSE dirty END,
                name = excluded.name, is_group = excluded.is_group
        `,
            )
            .run(
                id,
                title,
                Number(isGroup),
                existing?.filename || `${slug}--${suffix}.md`,
            );
        return this.getChat(id);
    }

    upsert(chatId, message, { edited = false, deleted = false } = {}) {
        deleted = deleted || message.type === 'revoked';
        const id = message.id?._serialized || message.id?.$1;
        const timestamp = Number(message.timestamp);
        if (!id || !Number.isFinite(timestamp) || timestamp <= 0) return;
        const sender = message.author || message.from || chatId;
        const result = this.db
            .prepare(
                `
            INSERT INTO messages(id, chat_id, timestamp, sender, from_me, body,
                                 type, has_media, edited, deleted)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                body = CASE WHEN messages.deleted OR excluded.deleted THEN '' ELSE excluded.body END,
                type = excluded.type, has_media = excluded.has_media,
                edited = MAX(messages.edited, excluded.edited),
                deleted = MAX(messages.deleted, excluded.deleted)
            WHERE messages.body != CASE WHEN messages.deleted OR excluded.deleted THEN '' ELSE excluded.body END
                OR messages.type != excluded.type
                OR messages.has_media != excluded.has_media
                OR (excluded.edited = 1 AND messages.edited = 0)
                OR (excluded.deleted = 1 AND messages.deleted = 0)
        `,
            )
            .run(
                id,
                chatId,
                timestamp,
                sender,
                Number(Boolean(message.fromMe)),
                deleted ? '' : message.body || '',
                message.type || 'unknown',
                Number(Boolean(message.hasMedia)),
                Number(edited),
                Number(deleted),
            );
        if (result.changes) {
            this.db
                .prepare('UPDATE chats SET dirty = 1 WHERE id = ?')
                .run(chatId);
        }
    }

    reconcile(chat, messages) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            this.ensureChat(chat);
            for (const message of messages) this.upsert(chat.id, message);
            const newest = messages.reduce((best, message) => {
                return !best || message.timestamp >= best.timestamp
                    ? message
                    : best;
            }, undefined);
            if (newest) {
                this.db
                    .prepare('UPDATE chats SET cursor = ? WHERE id = ?')
                    .run(newest.id._serialized || newest.id.$1, chat.id);
            }
            this.db
                .prepare('UPDATE chats SET history_complete = 1 WHERE id = ?')
                .run(chat.id);
            this.db.exec('COMMIT');
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    messages(chatId) {
        return this.db
            .prepare(
                `
            SELECT id, timestamp, sender, from_me AS fromMe, body, type,
                   has_media AS hasMedia, edited, deleted
            FROM messages WHERE chat_id = ? ORDER BY timestamp, id
        `,
            )
            .all(chatId);
    }

    flush() {
        let written = 0;
        for (const row of this.db.prepare('SELECT * FROM chats').all()) {
            const filename = path.join(this.outputDir, row.filename);
            if (!row.dirty && fs.existsSync(filename)) continue;
            const chat = { ...row, isGroup: Boolean(row.is_group) };
            const content = renderChat(chat, this.messages(chat.id));
            const temp = `${filename}.${randomUUID()}.tmp`;
            try {
                fs.writeFileSync(temp, content, { mode: 0o600 });
                fs.renameSync(temp, filename);
                this.db
                    .prepare('UPDATE chats SET dirty = 0 WHERE id = ?')
                    .run(chat.id);
                written++;
            } finally {
                fs.rmSync(temp, { force: true });
            }
        }
        return written;
    }

    snapshot() {
        // Synchronous reads give one consistent snapshot between event callbacks.
        return this.db
            .prepare('SELECT * FROM chats ORDER BY filename')
            .all()
            .map((row) => ({
                filename: row.filename,
                content: renderChat(
                    { ...row, isGroup: Boolean(row.is_group) },
                    this.messages(row.id),
                ),
            }));
    }

    files() {
        return this.db
            .prepare('SELECT id, filename FROM chats ORDER BY filename')
            .all();
    }

    file(filename) {
        const row = this.db
            .prepare('SELECT * FROM chats WHERE filename = ?')
            .get(filename);
        return row
            ? renderChat(
                  { ...row, isGroup: Boolean(row.is_group) },
                  this.messages(row.id),
              )
            : undefined;
    }

    counts() {
        return {
            chats: this.db.prepare('SELECT COUNT(*) AS n FROM chats').get().n,
            messages: this.db
                .prepare('SELECT COUNT(*) AS n FROM messages')
                .get().n,
        };
    }

    close() {
        this.db.close();
    }
}

module.exports = { Archive, escapeMarkdown, renderChat };
