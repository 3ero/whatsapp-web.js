# Private WhatsApp Markdown archive

An always-on service maintains a linked WhatsApp Web session, captures incoming
and outgoing messages, and creates one Markdown file per direct or group
conversation. The output folder is named **`Messags`**, as requested.

The private GitHub destination is
[`3ero/whatsapp-markdown-sync`](https://github.com/3ero/whatsapp-markdown-sync).
The original public fork must never receive conversation files or session data.

## How the two schedules work

- The server saves live message events to SQLite immediately. Every five minutes
  it reconciles WhatsApp history and refreshes changed Markdown files.
- A short GitHub Actions workflow runs on a five-minute schedule. It checks that
  its repository is private, downloads an authenticated snapshot from the server,
  and commits only changed files under `Messags/`.
- GitHub's scheduler can delay runs. Publication is best effort and can lag a
  server refresh by one or more workflow intervals. The server keeps collecting
  messages between publication runs, even when GitHub is unavailable.

No personal GitHub access token is stored on the server. Publication uses the
workflow's temporary `GITHUB_TOKEN` with access to this repository.

## Deploy the always-on server

The root Dockerfile lets Railway detect this as a Docker service. Deploy the private
repository as one persistent service. Create a persistent volume mounted at
**`/data` before the first WhatsApp pairing**. Use one replica and disable sleeping
or serverless suspension. Configure these environment variables:

New Railway services use settings configured directly in Railway; new services
cannot opt into the deprecated `railway.json` configuration format.
Configure `/healthz` as the health check,
`ALWAYS` as the restart policy, and watch only application source, package files,
the root Dockerfile, and `tools/conversation-sync/**`. In particular, commits under
`Messags/` must not trigger deployments.

| Variable                | Value                                     |
| ----------------------- | ----------------------------------------- |
| `SYNC_ACCESS_TOKEN`     | A random secret of at least 32 characters |
| `SYNC_REPOSITORY`       | `3ero/whatsapp-markdown-sync`             |
| `SYNC_INTERVAL_SECONDS` | `300` (default)                           |

The Docker image supplies Chromium, Node.js 22, and the required libraries. It
uses `/data/state` for the database and browser session and `/data/Messags` for
generated files. Those directories must survive restarts and deployments.

The dedicated Docker container also sets `SYNC_EXCLUSIVE_PROFILE=true`.
Before launching Chromium, it removes only the three temporary top-level
`Singleton*` lock files left by a previous container. Cookies, browser storage,
and the archive database remain intact. Keep one replica and exclusive ownership
of the volume; do not enable this setting for a profile shared by running browsers.

Expose the service through the host's **HTTPS** domain. The public `/healthz`
endpoint reports process liveness only; inspect the authenticated status page to
verify WhatsApp is paired and imports are completing. Open the service URL and
sign in with username **`sync`** and the access token as the password. Scan the QR
code from WhatsApp's **Linked devices → Link a device** screen on your phone.
Session material and QR values are not written to logs.

If the hosting platform does not permit Chromium's sandbox, the included Docker
image runs with `CHROME_NO_SANDBOX=true`. This service should have its own container
and volume, and should not host other applications. A host that supports the
Chromium sandbox can omit this setting.

## Connect GitHub publication

In the **private** repository's Actions secrets, configure:

| Secret              | Value                                          |
| ------------------- | ---------------------------------------------- |
| `SYNC_URL`          | The server's HTTPS base URL                    |
| `SYNC_ACCESS_TOKEN` | The same access token configured on the server |

Run **Publish private conversation Markdown** from the Actions tab after pairing.
Once that succeeds, set the repository Actions variable **`SYNC_ENABLED=true`**
to enable scheduled publication. Until then the schedule is inactive, so an
unfinished deployment does not keep starting failing jobs.
The workflow refuses to download conversation data
if GitHub does not confirm that the repository is private. Keep repository access
restricted to people who should be able to read the conversations.

To change the cadence, change `SYNC_INTERVAL_SECONDS` on the server and the cron
expression in `.github/workflows/conversation-sync.yml`. GitHub Actions supports
scheduled intervals of five minutes or more. Frequent private-repository runs
consume the account's Actions allowance and may incur usage charges.

## Output and delta behavior

Example filenames:

```text
Messags/
  Example-contact--0123456789abcdef.md
  Example-group--fedcba9876543210.md
```

The title plus a hash of the chat ID creates a stable, distinct filename. Renaming
a conversation updates its title inside the file without creating a second file.
Message IDs deduplicate repeated history fetches. Messages are ordered by their
timestamp and ID. A busy conversation's catch-up window expands until it overlaps
the previous completed sync or WhatsApp has no more history to provide.

Only changed conversations are rewritten; each changed file is replaced
atomically. A failed write leaves the database intact for retry. Conversations
removed from WhatsApp remain in the archive. Status broadcasts and channels are
excluded. This application does not send messages, mark chats read, or download
attachment files. Media captions and attachment-type placeholders are exported.

The first import attempts **all history available to the linked web session**.
WhatsApp Web may not provide the account's entire lifetime history. Observed edits
and deletions update the current Markdown file. Edits/deletions to older messages
while the server is offline may be missed if those messages are outside the next
catch-up window. This is an archive, not a guaranteed complete WhatsApp backup.
Previous Git commits retain old text even after a message is edited or deleted.

## Run locally

Install the root dependencies and the exporter dependencies:

```sh
npm ci
npm ci --prefix tools/conversation-sync
```

Set `SYNC_ACCESS_TOKEN` in your environment, then run:

```sh
npm start --prefix tools/conversation-sync
```

Open `http://localhost:3000` locally. Session/database files go in
`.conversation-sync/`, and Markdown files go in `Messags/`. Both are excluded from
normal Git staging. The publication workflow explicitly stages `.md` files only
after verifying that the destination is private.

For Docker, set `SYNC_ACCESS_TOKEN` in the environment and run:

```sh
docker compose -f tools/conversation-sync/compose.yml up --build -d
```

The Compose configuration binds the web port to localhost. Put a TLS reverse proxy
in front of it when using a server. Back up the persistent volume privately;
possession of the browser session may grant access to the linked account.

## Verification

```sh
npm test --prefix tools/conversation-sync
npm run check
```

The exporter tests use temporary databases and fake messages. They do not log in
to WhatsApp or send anything. The upstream library's separate integration tests
require a real authenticated account and a recipient; they are not needed to run
these isolated exporter tests.

Live acceptance requires pairing, confirming the first real conversation file,
checking a subsequent delta and GitHub commit, and confirming session recovery
after a service restart. Code tests alone do not establish those outcomes.

The upstream dependency versions are retained. During implementation, npm's
production dependency audit reported high-severity advisories in the upstream
Puppeteer dependency tree. Updating that browser-control dependency needs a
separate compatibility check against WhatsApp Web; these tests do not establish
that the upstream dependencies are free of known vulnerabilities.
