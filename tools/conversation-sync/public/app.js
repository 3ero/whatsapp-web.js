'use strict';

async function refresh() {
    try {
        const response = await fetch('/api/status');
        if (!response.ok) throw new Error('status');
        const status = await response.json();
        const phases = {
            starting: 'Starting WhatsApp…',
            pairing: 'Link your WhatsApp account',
            loading: 'Loading your conversations…',
            ready: 'Connected to WhatsApp',
            disconnected: 'WhatsApp disconnected',
            auth_failure: 'Please reconnect your WhatsApp account',
        };
        document.getElementById('phase').textContent =
            phases[status.phase] || status.phase;
        document.getElementById('detail').textContent = status.syncing
            ? `Refreshing conversations: ${status.processedChats || 0} of ${status.totalChats || '…'}.`
            : status.ready
              ? 'New messages are saved as they arrive. Markdown files refresh on schedule.'
              : 'Your session is kept on the server so it can reconnect after a restart.';
        document.getElementById('chats').textContent = status.chats;
        document.getElementById('messages').textContent = status.messages;
        document.getElementById('interval').textContent =
            `${status.intervalSeconds / 60} min`;
        document.getElementById('last-sync').textContent = status.lastSync
            ? `Last refresh: ${new Date(status.lastSync).toLocaleString()}. GitHub publication follows its own schedule.`
            : 'Waiting for the first import.';
        document.getElementById('error').textContent = status.lastError || '';
        const qr = document.getElementById('qr');
        qr.hidden = !status.qr;
        document.getElementById('pairing-help').hidden = !status.qr;
        if (status.qr) qr.src = `/api/qr.svg?t=${Date.now()}`;
        const filesResponse = await fetch('/api/files');
        if (!filesResponse.ok) throw new Error('files');
        const files = await filesResponse.json();
        const list = document.getElementById('files');
        list.replaceChildren();
        for (const filename of files) {
            const item = document.createElement('li');
            const link = document.createElement('a');
            link.textContent = filename;
            link.href = `/files/${encodeURIComponent(filename)}`;
            item.append(link);
            list.append(item);
        }
    } catch {
        document.getElementById('error').textContent =
            'Cannot reach the service. Refresh the page to reconnect.';
    }
}

void refresh();
setInterval(() => void refresh(), 10000);
