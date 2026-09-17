# Hermes action approvals: use the Cuate gateway patch

CuateWeb consumes the same native-session approval contract as Cuate macOS and
Android. Install the existing Cuate gateway patch v6 through Cuate or its VPS
instructions, only when its compatibility checks accept the installed Hermes
version. CuateWeb no longer ships a separate gateway patch or installer.

The contract is an authoritative `approvals` array on `GET /v1/runs/{run_id}`,
`cuate_approval_version: 1`, and `approval.changed` notifications. Every decision
uses the exact server scope, session, run and request, with `choice: once | deny`.
An upstream singular `approval` remains a fallback, not a complete multiple-request
recovery guarantee. A missing or lost decision response requires a status check;
no automatic decision retry is performed.

The retired CuateWeb candidate did not cover the native human-presence gate or
complete queue recovery. Do not install it from older archives. If previously
applied, inspect its exact backup and the current Hermes revision before using
the Cuate installer; that installer intentionally refuses a foreign bridge. Do
not restore an old source backup over a newer Hermes version. No automatic
uninstallation, live Gateway restart or database change is performed here.

Refer to Cuate's `docs/hermes-approvals.md` and `docs/hermes-vps-setup.md` for the
maintained compatibility checks and installation. CuateWeb's MIT/ISC sources
contain no copy of Cuate's AGPL implementation.
