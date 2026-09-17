# CuateWeb beside an existing Hermes installation

Use this Compose file on a **Linux VPS**. The CuateWeb container uses the host
network and binds only to `127.0.0.1:3080`. It reaches your already installed
Hermes API and Dashboard at their existing loopback URLs. Hermes is not installed,
patched, restarted or moved into a container by Compose. The web client uses the
same native session/run Gateway API and existing Cuate patch as macOS and Android.
See [Gateway requirements](../hermes/README.md).

MongoDB, Meilisearch and RAG use dedicated persistent volumes. Their host ports
are bound to loopback; PostgreSQL is reachable only inside the Compose network.
MongoDB stores web accounts and ordinary web-client data. Hermes owns its session
history; the shared sidebar and chat window read it directly through the adapter.
Hermes transcripts are not imported into MongoDB. Keep your existing HTTPS proxy.

## Install

Build on the VPS from the published CuateWeb release tag:

```sh
git clone --branch v0.8.8-rc4-cuate.10 --single-branch https://github.com/kidem42/CuateWeb.git
cd CuateWeb/deploy/docker
python3 setup.py
docker compose build api
```

The Dockerfile builds for the host architecture. Keep this checkout and its
release tag so the installation can be reproduced. Upgrades should use a new
reviewed tag; preserve the existing configuration and persistent volumes.

Edit `.env`: set `DOMAIN_CLIENT` and `DOMAIN_SERVER` to **your** HTTPS origin,
then set the existing Hermes API key and Dashboard session token. The sample
domain is a placeholder, not a compiled application setting. Preserve generated
keys and volumes across upgrades. Do not overwrite an existing `.env`.

Prefer building on the VPS from a pinned checkout of the fork instead of transferring a large image. Prepare code changes locally, then deploy the reviewed source revision:

```sh
docker compose build api
```

Start the database, create the first account through LibreChat's existing prompt,
and obtain the account ID:

```sh
docker compose up -d mongodb
docker compose run --rm --no-deps api npm run create-user
docker compose exec mongodb mongosh CuateWeb --quiet --eval 'db.users.find({}, {email:1}).forEach(u => print(u._id.toString()+" "+u.email))'
```

`setup.py` creates an empty `hermes.connections` list and disables the unrelated
web agent builder, marketplace and MCP management. It does not overwrite existing
configuration. Merge [the native configuration](../native/hermes.example.yaml)
into `librechat.yaml`, set the native Gateway/Dashboard URLs, and replace
`REPLACE_WITH_LIBRECHAT_USER_ID` with the account ID above. Preserve existing
configuration and secrets. Each allowlisted account can access its assigned
Hermes profile, including the profile's tools and files.

```sh
docker compose up -d
docker compose logs --tail=100 api
```

Point your existing HTTPS proxy at `127.0.0.1:3080`; use
`../native/Caddyfile.example` as a template. Configure DNS and the certificate for
your domain. SSE requires disabled proxy buffering and a long read timeout.
The user logs in and opens existing Hermes sessions in the shared Chats list.
New chat uses the configured Hermes connection; its standard model menu selects
the native provider/model. Delete removes the native session, as in the apps;
there is no separate Hermes archive. Skills selected in the standard picker
become an explicit instruction in the message to Hermes. The `/` command and Skills sidebar use the native catalog. With an assigned Hermes connection, unrelated Prompts, Bookmarks, Memories, Files management and Projects are hidden; the composer attachment button remains available.

## Operations

- `docker compose stop` preserves data; `docker compose down -v` deletes it.
- Back up `.env`, `librechat.yaml` and the named volumes before upgrades.
- Port conflicts: change `PORT`, `MONGO_PORT`, `MEILI_PORT`, `RAG_PORT` in `.env`.
- Existing LibreChat providers, speech, MCP, RAG and search use their original
  configuration. They are not replaced by Hermes. Configure external model keys
  or local embedding models as required for the LibreChat features you use.
- The optional upstream admin panel is retained under `--profile admin`. Set
  `ADMIN_PANEL_API_URL` to your reachable CuateWeb HTTPS URL before enabling it.
  It binds to `127.0.0.1:3000`; its separate service/license remains upstream-owned.
- Pin the RAG/admin service images to tested digests in your production deployment;
  their upstream Compose defaults currently use mutable tags.

See `../native/COMPATIBILITY.md` for protocol limits and the VPS acceptance checklist.
Database variable names follow the [upstream RAG configuration](https://github.com/danny-avila/rag_api#environment-variables).
Verify the exact deployed image through the public HTTPS origin. A healthy API alone does not prove that the Hermes configuration was loaded.

### Build and runtime dependencies

The Dockerfile builds the web client and shared modules in a build stage, then
installs only production dependencies in a separate runtime stage and copies the
compiled outputs. It does not run `npm prune` against the development dependency
tree. Keep the previous deployed image until the new container passes health
checks. Build-cache cleanup is optional maintenance after a successful rollout;
it does not require deleting database or upload volumes.
