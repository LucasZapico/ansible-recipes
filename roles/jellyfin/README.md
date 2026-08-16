# jellyfin

Applies Jellyfin's transcoding configuration over its REST API.

That is the whole scope. The container itself is deployed by the `compose`
role; this only sets what lives inside the application.

## Why transcoding and nothing else

Hardware acceleration is worth declaring because Jellyfin **silently falls back
to CPU** when it is off. Nothing in the UI announces that, so a host with a
perfectly working GPU can transcode on the CPU for months without anyone
noticing. Stating it here means a converge asserts it and `task verify` proves
it.

It is also genuinely reconcilable: the role reads the current config, merges
only the keys you declare, and writes only on drift. Keys it does not name keep
their dashboard values, so it never fights a human.

## Why media libraries are NOT managed here

This role used to create libraries too. That was removed deliberately.

Jellyfin has no API to edit an existing library's paths in place. Anything
built on top can only *create when missing*, never reconcile. If a path changes
in the dashboard, ansible would not fix it, would not fail, and would not even
notice: a bootstrap script wearing configuration-management clothing, and much
weaker than what `storage` or `docker` provide.

The cost was not free either. It required an API key before a converge could
run at all, which blocked unrelated changes to the host and needed a skip gate
to work around.

Libraries are created once, in the setup wizard, alongside the admin account.
The thing that actually protects them is a **backup of the config directory**,
which restores libraries, watch history, users and the API key in one move.
Ansible can only ever recreate the first of those.

Collection grouping (`AutomaticallyAddToCollection`) is a per-library option set
at creation time, so it is part of that same one-time step.

## Credentials

`jellyfin_api_key` comes from the vault. The role never creates the first admin
account: that is a credential decision, and a repo that can mint admins on any
host is a worse trade than a one-time manual step.

An empty key is not fatal. The role warns loudly and ends the play, so an
unrelated change to the host can still converge. `task verify` fails while it is
outstanding, so the skip cannot pass unnoticed.

## Variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `jellyfin_url` | `http://localhost:8096` | API base; local because the role runs on the host |
| `jellyfin_api_key` | `""` | From the vault. Empty means warn and skip |
| `jellyfin_encoding` | `{}` | `EncodingOptions` keys to assert |

Field names for `jellyfin_encoding` come from the server's own
`/api-docs/openapi.json`, not from documentation. Check there when adding keys.
