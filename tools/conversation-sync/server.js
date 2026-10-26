'use strict';

process.umask(0o077);

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { timingSafeEqual } = require('node:crypto');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('../..');
const { Archive } = require('./archive');
const { ConversationSync } = require('./sync');
const { clearBrowserLocks } = require('./session');

function authorized(header, token) {
    if (!header?.startsWith('Basic ')) return false;
    const decoded = Buffer.from(header.slice(6), 'base64').toString();
    const actual = Buffer.from(decoded.slice(decoded.indexOf(':') + 1));
    const expected = Buffer.from(token);
    return (
        decoded.startsWith('sync:') &&
        actual.length === expected.length &&
        timingSafeEqual(actual, expected)
    );
}

function createServer({ token, sync, archive, pairing, repository }) {
    return http.createServer(async (request, response) => {
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('X-Frame-Options', 'DENY');
        response.setHeader('Referrer-Policy', 'no-referrer');
        response.setHeader(
            'Content-Security-Policy',
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        );
        const url = new URL(request.url, 'http://localhost');
        if (url.pathname === '/healthz' && request.method === 'GET') {
            response.writeHead(200, { 'Content-Type': 'text/plain' });
            response.end('ok');
            return;
        }
        if (!authorized(request.headers.authorization, token)) {
            response.writeHead(401, {
                'WWW-Authenticate':
                    'Basic realm="WhatsApp Markdown", charset="UTF-8"',
            });
            response.end(
                'Sign in with username sync and the configured access token.',
            );
            return;
        }
        try {
            if (request.method !== 'GET') {
                response.writeHead(405, { Allow: 'GET' });
                response.end();
                return;
            }
            if (url.pathname === '/api/status') {
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(
                    JSON.stringify({
                        ...sync.status,
                        ...archive.counts(),
                        ready: sync.ready,
                        intervalSeconds: sync.intervalMs / 1000,
                        qr: Boolean(pairing.qr),
                        repository,
                    }),
                );
            } else if (url.pathname === '/api/qr.svg' && pairing.qr) {
                const svg = await QRCode.toString(pairing.qr, {
                    type: 'svg',
                    margin: 3,
                });
                response.writeHead(200, { 'Content-Type': 'image/svg+xml' });
                response.end(svg);
            } else if (url.pathname === '/api/export.json') {
                // Export a consistent saved snapshot. Polling and durable live
                // events run independently, so publication never holds a job
                // open while the first, potentially long history import runs.
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(
                    JSON.stringify({
                        schema: 1,
                        repository,
                        generatedAt: new Date().toISOString(),
                        lastSync: sync.status.lastSync,
                        files: archive.snapshot(),
                    }),
                );
            } else if (url.pathname.startsWith('/files/')) {
                const name = decodeURIComponent(url.pathname.slice(7));
                const content = archive.file(name);
                if (content === undefined) {
                    response.writeHead(404);
                    response.end();
                    return;
                }
                response.writeHead(200, {
                    'Content-Type': 'text/markdown; charset=utf-8',
                    'Content-Disposition': `attachment; filename="${name}"`,
                });
                response.end(content);
            } else if (url.pathname === '/api/files') {
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(
                    JSON.stringify(
                        archive.files().map((file) => file.filename),
                    ),
                );
            } else {
                const assets = {
                    '/': ['index.html', 'text/html; charset=utf-8'],
                    '/app.js': ['app.js', 'text/javascript'],
                    '/style.css': ['style.css', 'text/css'],
                };
                const asset = assets[url.pathname];
                if (!asset) {
                    response.writeHead(404);
                    response.end();
                    return;
                }
                response.writeHead(200, { 'Content-Type': asset[1] });
                response.end(
                    fs.readFileSync(path.join(__dirname, 'public', asset[0])),
                );
            }
        } catch {
            if (!response.headersSent) response.writeHead(500);
            response.end('Request failed. No conversation data was logged.');
        }
    });
}

async function main() {
    const token = process.env.SYNC_ACCESS_TOKEN || '';
    if (token.length < 32)
        throw new Error(
            'SYNC_ACCESS_TOKEN must contain at least 32 characters.',
        );
    const intervalSeconds = Number(process.env.SYNC_INTERVAL_SECONDS || 300);
    if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 30) {
        throw new Error(
            'SYNC_INTERVAL_SECONDS must be a whole number of at least 30.',
        );
    }
    const root = path.resolve(__dirname, '../..');
    const dataDir = path.resolve(
        process.env.SYNC_DATA_DIR || path.join(root, '.conversation-sync'),
    );
    const outputDir = path.resolve(
        process.env.SYNC_OUTPUT_DIR || path.join(root, 'Messags'),
    );
    if (process.env.SYNC_EXCLUSIVE_PROFILE === 'true')
        clearBrowserLocks(dataDir);
    const archive = new Archive({ dataDir, outputDir });
    const client = new Client({
        authStrategy: new LocalAuth({ dataPath: path.join(dataDir, 'auth') }),
        webVersionCache: {
            type: 'local',
            path: path.join(dataDir, 'web-cache'),
        },
        puppeteer: {
            headless: true,
            ...(process.env.PUPPETEER_EXECUTABLE_PATH
                ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
                : {}),
            args:
                process.env.CHROME_NO_SANDBOX === 'true'
                    ? [
                          '--no-sandbox',
                          '--disable-setuid-sandbox',
                          '--disable-dev-shm-usage',
                      ]
                    : [],
        },
    });
    const sync = new ConversationSync({
        client,
        archive,
        intervalMs: intervalSeconds * 1000,
    });
    const pairing = { qr: null };
    sync.attach();
    client.on('qr', (qr) => {
        pairing.qr = qr;
        sync.status.phase = 'pairing';
        console.log(
            'WhatsApp pairing is available on the authenticated web page.',
        );
    });
    client.on('authenticated', () => {
        pairing.qr = null;
        sync.status.phase = 'loading';
    });
    client.on('ready', () => {
        pairing.qr = null;
        console.log('WhatsApp connected; conversation sync is running.');
    });
    const server = createServer({
        token,
        sync,
        archive,
        pairing,
        repository:
            process.env.SYNC_REPOSITORY || '3ero/whatsapp-markdown-sync',
    });
    server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => {
        console.log('Private pairing and archive server started.');
    });
    let shuttingDown = false;
    async function shutdown(exitCode = 0) {
        if (shuttingDown) return;
        shuttingDown = true;
        const force = setTimeout(() => process.exit(1), 20000);
        force.unref();
        server.close();
        await sync.stop();
        await client.destroy();
        archive.close();
        process.exit(exitCode);
    }
    process.once('SIGTERM', () => void shutdown());
    process.once('SIGINT', () => void shutdown());
    client.on('disconnected', () => void shutdown(1));
    client.on('auth_failure', () => void shutdown(1));
    client
        .initialize()
        .then(() => {
            client.pupBrowser.once('disconnected', () => void shutdown(1));
        })
        .catch((error) => {
            // Crash/restart on failed initialization; keep the persisted session.
            const locked =
                /Singleton|profile appears to be in use|process.*in use/i.test(
                    String(error?.message || error),
                );
            console.error(
                locked
                    ? 'Browser initialization failed: stale profile lock. Check exclusive-profile recovery.'
                    : 'Browser initialization failed. Check browser configuration and restart the service.',
            );
            process.exit(1);
        });
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.message);
        process.exit(1);
    });
}

module.exports = { authorized, createServer };
