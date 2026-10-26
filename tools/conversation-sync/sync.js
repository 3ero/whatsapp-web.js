'use strict';

const { setTimeout: delay } = require('node:timers/promises');

function chatData(chat) {
    return {
        id: chat.id._serialized || chat.id.$1,
        name: chat.name,
        isGroup: Boolean(chat.isGroup),
    };
}

class ConversationSync {
    constructor({ client, archive, intervalMs = 300000, pageSize = 100 }) {
        this.client = client;
        this.archive = archive;
        this.intervalMs = intervalMs;
        this.pageSize = pageSize;
        this.ready = false;
        this.stopping = false;
        this.status = {
            phase: 'starting',
            lastSync: null,
            lastError: null,
            failures: 0,
        };
        this.pending = new Map();
    }

    attach() {
        this.client.on('message_create', (message) => this.capture(message));
        this.client.on('message_edit', (message, newBody) => {
            this.capture(
                { ...message, body: newBody ?? message.body },
                { edited: true },
            );
        });
        this.client.on('message_revoke_everyone', (message, original) => {
            this.capture(original || message, { deleted: true });
        });
        this.client.on('ready', () => {
            this.ready = true;
            this.status.phase = 'ready';
            void this.run();
            if (!this.timer) {
                this.timer = setInterval(
                    () => void this.run(),
                    this.intervalMs,
                );
            }
        });
        this.client.on('disconnected', () => {
            this.ready = false;
            this.status.phase = 'disconnected';
        });
        this.client.on('auth_failure', () => {
            this.ready = false;
            this.status.phase = 'auth_failure';
        });
    }

    capture(message, flags = {}) {
        if (this.stopping || message.isStatus) return;
        const chatId = message.fromMe ? message.to : message.from;
        const id = message.id?._serialized || message.id?.$1;
        if (!chatId || !id || /broadcast|newsletter/.test(chatId)) return;
        try {
            if (!this.archive.getChat(chatId)) {
                this.archive.ensureChat({
                    id: chatId,
                    isGroup: chatId.endsWith('@g.us'),
                });
            }
            this.archive.upsert(chatId, message, flags);
        } catch {
            // Keep failed captures for retry. Never log message bodies or identifiers.
            this.pending.set(id, { chatId, message, flags });
            this.status.lastError =
                'Could not persist an event; it is queued for retry.';
        }
    }

    async history(chat) {
        const previous = this.archive.getChat(chatData(chat).id);
        // First import attempts all history WhatsApp Web can provide.
        if (!previous?.cursor) return chat.fetchMessages({ limit: Infinity });
        let limit = this.pageSize;
        for (;;) {
            if (this.stopping || !this.ready) throw new Error('Disconnected');
            const messages = await chat.fetchMessages({ limit });
            const found = messages.some((message) => {
                return (
                    (message.id._serialized || message.id.$1) ===
                    previous.cursor
                );
            });
            if (found || messages.length < limit) return messages;
            // Expand until we overlap the last completed reconciliation, rather
            // than silently dropping a busy chat's messages between polls.
            limit *= 2;
            if (!Number.isSafeInteger(limit))
                throw new Error('History window exhausted');
        }
    }

    run() {
        if (this.inFlight) return this.inFlight;
        if (!this.ready || this.stopping) return Promise.resolve(false);
        this.inFlight = this.reconcile().finally(() => {
            this.inFlight = null;
        });
        return this.inFlight;
    }

    async reconcile() {
        this.status.syncing = true;
        let failures = 0;
        try {
            for (const [id, event] of this.pending) {
                if (!this.archive.getChat(event.chatId)) {
                    this.archive.ensureChat({
                        id: event.chatId,
                        isGroup: event.chatId.endsWith('@g.us'),
                    });
                }
                this.archive.upsert(event.chatId, event.message, event.flags);
                this.pending.delete(id);
            }
            const chats = await this.client.getChats();
            this.status.totalChats = chats.filter((chat) => {
                return !/broadcast|newsletter/.test(chatData(chat).id);
            }).length;
            this.status.processedChats = 0;
            for (const chat of chats) {
                if (this.stopping || !this.ready) break;
                const info = chatData(chat);
                if (/broadcast|newsletter/.test(info.id)) continue;
                try {
                    const messages = await this.history(chat);
                    this.archive.reconcile(info, messages);
                    this.archive.flush();
                } catch {
                    failures++;
                }
                this.status.processedChats++;
                await delay(100);
            }
            this.archive.flush();
            if (!this.ready || this.stopping) failures++;
            this.status.lastSync = new Date().toISOString();
            this.status.failures = failures;
            this.status.lastError = failures
                ? `${failures} conversation(s) could not be refreshed; will retry.`
                : null;
            return failures === 0;
        } catch {
            this.status.lastError =
                'Refresh failed; saved conversations are retained and will be retried.';
            return false;
        } finally {
            this.status.syncing = false;
        }
    }

    async stop() {
        this.stopping = true;
        clearInterval(this.timer);
        if (this.inFlight) await this.inFlight;
        this.archive.flush();
    }
}

module.exports = { ConversationSync };
