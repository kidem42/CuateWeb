# CuateWeb on the same VPS as Hermes

This deployment runs the prebuilt LibreChat server and browser client as a native
Node.js service. Docker is not required. It does not install, patch, restart or
replace Hermes, its Dashboard, or its database.

```
browser -> your HTTPS proxy -> 127.0.0.1:3080 CuateWeb
                                  |-> 127.0.0.1:8642 Hermes API
                                  |-> 127.0.0.1:9119 Hermes Dashboard (files)
```

The addresses and domain are deployment settings. No customer domain is compiled
into the application. The same archive can serve any domain.

## Prerequisites

- Linux with systemd and Node.js 24.16.0 (including npm) on the service PATH.
- MongoDB for LibreChat accounts and its ordinary conversations; keep it private.
  Use a separate database, e.g. `CuateWeb`, not a Hermes database.
- Your existing Hermes API and Dashboard, with the same credentials and patches
  currently used by Cuate. File transfer is Dashboard API functionality. Context
  occupancy and detached-turn support depend on the installed gateway revision.
- Your existing HTTPS proxy. Keep the Hermes ports private. If services use other
  ports or hosts, change the YAML; do not change the source.

Meilisearch, RAG API/PostgreSQL, model providers, speech providers, MCP and other
LibreChat services retain their upstream configuration. Configure these when
using the corresponding LibreChat features; they have not been removed. MongoDB
is not a second history database for Hermes conversations.

## Install a test bundle

Extract `CuateWeb-test.tar.gz` to `/opt/cuateweb`. The archive includes compiled
`client/dist` and compiled workspace packages plus their source. It deliberately
excludes `.env`, credentials, user data and node_modules. Dependencies must be
installed **on Linux**, because native modules from macOS cannot be shipped to Linux.

Create a dedicated `cuateweb` system account and grant it ownership of the extracted
application directory. From that directory, as that account:

```sh
npm ci --no-audit --no-fund
cp .env.example .env
```

Do not run `npm run frontend` on the VPS for this prebuilt bundle. `npm ci` installs
locked dependencies but does not build the frontend. Set these values in `.env`:

```dotenv
HOST=127.0.0.1
PORT=3080
MONGO_URI=mongodb://127.0.0.1:27017/CuateWeb
DOMAIN_CLIENT=https://chat.example.com
DOMAIN_SERVER=https://chat.example.com
ALLOW_EMAIL_LOGIN=true
ALLOW_REGISTRATION=false
CUATEWEB_HERMES_API_KEY=replace-with-your-existing-api-server-key
CUATEWEB_HERMES_DASHBOARD_KEY=replace-with-your-existing-dashboard-session-token
```

Replace `chat.example.com` with your domain. Set `CREDS_KEY`, `CREDS_IV`,
`JWT_SECRET` and `JWT_REFRESH_SECRET` in the same file: generate independent
random hex strings using `openssl rand -hex 32` for each key/secret and
`openssl rand -hex 16` for `CREDS_IV`. Do not reuse sample keys. Keep `.env` readable
only by the service account (`chmod 600 .env`). Preserve these keys across upgrades.

Create the first LibreChat account with its existing command:

```sh
npm run create-user
```

Supply the password interactively, not as a shell argument. Find the account's
`_id` in the CuateWeb MongoDB `users` collection and place its string value in
`hermes.connections[].userIds`. An account receives access to the **entire assigned
Hermes profile**, just like an existing Cuate client with that API key. Do not grant
unrelated users access to one profile. Tenant accounts also require a matching
`tenantId` in the connection entry. Unlisted accounts cannot proxy any Hermes request.

Create `librechat.yaml` with `version: 1.3.16` and the `hermes` section from
`hermes.example.yaml`, or merge that section into an existing LibreChat config.
Never overwrite existing provider, speech, search or RAG configuration.

Install `cuateweb.service` in `/etc/systemd/system/`, adjusting paths and account
names if necessary, then:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now cuateweb
sudo systemctl status cuateweb
```

Add the example Caddy site to your existing proxy configuration, replacing the
example domain. If using nginx instead, proxy to `127.0.0.1:3080`, disable response
buffering for SSE and allow long streaming responses. Validate the proxy config
before reload. Point the domain's DNS to the VPS and enable HTTPS through your
existing certificate setup. Ordinary users then log in through the browser and
open Hermes sessions in the shared Chats list; they do not need a terminal.
The standard model menu reads the native Gateway catalog. Chat, Steer, Stop and
approvals use the same native APIs as the Cuate apps, not chat/completions.

## Live acceptance check

Use a new test session, not an important existing task. Open it in CuateWeb and in
Cuate on macOS/Android. Verify titles, model selection, messages and attachments
in both directions. Send an image and a document, interrupt/reopen the browser,
confirm that the response appears in history, test an addition during a tool call,
and confirm Stop through the run status. Compare context occupancy with Hermes,
not the cumulative token bill. Keep the original services and data untouched.

A run ID is only known to the client that observed it, as in the existing clients.
There is no added run-discovery or synchronization service. Session-steer is used
only when Hermes advertises it. A missing context reading is shown as unavailable,
not fabricated from cumulative tokens. Gateway errors can also arrive as normal
assistant messages with HTTP 200; review the actual reply.

The test bundle has local build/contract verification, not a live-VPS acceptance
claim. Preserve `.env`, `librechat.yaml`, uploads and MongoDB data when upgrading.
