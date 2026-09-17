#!/usr/bin/env python3
"""Initialize deployment secrets once; never replace existing configuration."""
import secrets
from pathlib import Path
root = Path(__file__).resolve().parent
path = root / '.env'
if path.exists():
    raise SystemExit('.env already exists; preserving it.')
values = {'DOMAIN_CLIENT': 'https://chat.example.com', 'DOMAIN_SERVER': 'https://chat.example.com', 'ALLOW_EMAIL_LOGIN': 'true', 'ALLOW_REGISTRATION': 'false', 'CUATEWEB_HERMES_API_KEY': 'replace-with-existing-hermes-key', 'CUATEWEB_HERMES_DASHBOARD_KEY': 'replace-with-existing-dashboard-token'}
for key in ['CREDS_KEY', 'JWT_SECRET', 'JWT_REFRESH_SECRET', 'MEILI_MASTER_KEY', 'POSTGRES_PASSWORD', 'ADMIN_PANEL_SESSION_SECRET']:
    values[key] = secrets.token_hex(32)
values['CREDS_IV'] = secrets.token_hex(16)
with path.open('x') as handle:
    path.chmod(0o600)
    handle.write(''.join(f'{key}={value}\n' for key, value in values.items()))
config = root / 'librechat.yaml'
if not config.exists():
    config.write_text('version: 1.3.16\nhermes:\n  formattingInstructions: true\n  connections: []\ninterface:\n  agents: {use: false, create: false, share: false, public: false}\n  remoteAgents: {use: false, create: false, share: false, public: false}\n  marketplace: {use: false}\n  mcpServers: {use: false, create: false, share: false, public: false, configureObo: false}\n')
print('Created .env. Set your domain and existing Hermes credentials before starting.')
