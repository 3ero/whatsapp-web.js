'use strict';

const fs = require('node:fs');
const path = require('node:path');

function clearBrowserLocks(dataDir) {
    // Only use before launch in the dedicated, single-replica container.
    // A replacement container has a new hostname; old Chromium locks persist
    // on its volume even though the old browser process is gone.
    const profile = path.join(dataDir, 'auth', 'session');
    for (const name of [
        'SingletonLock',
        'SingletonSocket',
        'SingletonCookie',
    ]) {
        fs.rmSync(path.join(profile, name), { force: true });
    }
}

module.exports = { clearBrowserLocks };
