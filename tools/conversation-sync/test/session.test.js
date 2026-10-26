'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clearBrowserLocks } = require('../session');

test('container recovery removes stale lock symlinks and preserves session data', (t) => {
    const root = fs.mkdtempSync(
        path.join(os.tmpdir(), 'whatsapp-session-test-'),
    );
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const profile = path.join(root, 'auth', 'session');
    const defaults = path.join(profile, 'Default');
    fs.mkdirSync(defaults, { recursive: true });
    const cookie = path.join(defaults, 'Cookies');
    fs.writeFileSync(cookie, 'saved browser state');
    fs.writeFileSync(path.join(defaults, 'SingletonLock'), 'keep nested data');
    for (const name of [
        'SingletonLock',
        'SingletonSocket',
        'SingletonCookie',
    ]) {
        fs.symlinkSync('old-container-123', path.join(profile, name));
    }
    clearBrowserLocks(root);
    assert.deepEqual(fs.readdirSync(profile), ['Default']);
    assert.equal(fs.readFileSync(cookie, 'utf8'), 'saved browser state');
    assert.equal(
        fs.readFileSync(path.join(defaults, 'SingletonLock'), 'utf8'),
        'keep nested data',
    );
    assert.doesNotThrow(() => clearBrowserLocks(path.join(root, 'missing')));
});
