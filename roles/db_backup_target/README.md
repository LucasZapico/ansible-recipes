# db_backup_target

The offsite host that receives verified database dumps from one or more
`db_backup` source hosts. It holds the backup directory and authorises each
source's dedicated key, restricted with `rrsync` so the key can only write into
that source's backup tree — no shell, no other paths.

```yaml
db_backup_target_sources:
  - { host: ritron, dir: /mnt/merged/db-backups/ritron }
```

`host` must be an inventory host running `db_backup` with offsite enabled; its
public key comes from the `db_backup_pubkey` fact set during that host's play,
so run both plays in the same `site` invocation.

## Retention / pruning

Received dumps are pruned here, not by the source: the source's key is
`rrsync`-locked and cannot run `find` remotely. A daily `db-backup-prune.timer`
deletes `*.gz` older than `db_backup_target_retention_days` (default 30) in each
source's directory. A source entry may override with its own `retention_days`.
