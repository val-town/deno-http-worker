---
"@valtown/deno-http-worker": major
---

Require Deno 2.9+.

Deno 2.9 moved Unix domain socket operations behind the net permission
(denoland/deno#34395), so `Deno.serve` on the worker's socket now fails with
`NotCapable: Requires net access` unless the spawned process has net access.
The worker now always grants net access scoped to its own socket via
`--allow-net=unix:<socket>` — appended to any user-provided `--allow-net=...`
flag, or skipped if `--allow-net`/`--allow-all` is already present.
