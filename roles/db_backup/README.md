# db_backup

Dump the databases on a host, keep a local copy with a retention window, and
push a size-verified copy to an offsite host. Built after a 2026-09-12 incident
where the previous hand-rolled backup script dumped the wrong container and
logged success anyway — so this role verifies every dump is real, not just that
a command exited 0, and fails loudly (non-zero, recorded by systemd) otherwise.

## What it does

- Runs on the host where the databases live. It only `docker exec`s into the DB
  containers, so it is safe on a Coolify host (it does not touch the engine).
- Dumps each database in `db_backup_databases` (postgres via `pg_dump`, mongo
  via `mongodump`), gzips it, and **verifies content** (a real `CREATE TABLE`
  for postgres, a non-trivial size for mongo).
- Prunes local dumps older than `db_backup_retention_days`.
- When `db_backup_offsite_enabled`, generates a dedicated ed25519 key **on the
  host** (never committed), rsyncs verified dumps to the offsite host, confirms
  the remote size matches, and prunes offsite by its own retention.
- Schedules it with a systemd timer (`db_backup_on_calendar`, default 2h).

The offsite public key is exposed as the fact `db_backup_pubkey`; the companion
`db_backup_target` role authorises it on the offsite host, restricted to the
backup directory via `rrsync`. Run both in one `site` invocation so the fact is
available to the target play.

## Configure (in host_vars)

```yaml
db_backup_databases:
  - { name: bhreco_prod, engine: postgres, container: bhreco-postgres-prod, db: bhrecoapp, user: bhreco }
db_backup_offsite_enabled: true
db_backup_offsite_host: 192.168.1.122          # milotron
db_backup_offsite_dir: /mnt/merged/db-backups/ritron
db_backup_offsite_hostkey: "ssh-ed25519 AAAA…"  # ssh-keyscan -t ed25519 192.168.1.122
```

Mongo databases add `password: "{{ vault_… }}"` from the vault; never inline it.

## Restore

See the app repo's `docs/database-backup-and-restore.md`. In short: pick the
newest dump, confirm it gunzips and has the expected table count, restore into a
clean empty target of the same major version, and verify row counts before
trusting it.
