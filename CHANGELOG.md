# @valtown/deno-http-worker

## 3.0.0

### Major Changes

- 2c2af5d: Require Deno 2.9+.
  
  Deno 2.9 moved Unix domain socket operations behind the net permission
  (denoland/deno#34395), so `Deno.serve` on the worker's socket now fails with
  `NotCapable: Requires net access` unless the spawned process has net access.
  The worker now always grants net access scoped to its own socket via
  `--allow-net=unix:<socket>` — appended to any user-provided `--allow-net=...`
  flag, or skipped if `--allow-net`/`--allow-all` is already present.

## 2.0.3

### Patch Changes

- 89075da: Do not swallow unhandled rejections

  In 0.0.21, behavior changed and unhandled rejections from Deno were
  logged, and the Deno process would not crash. This might be useful for
  some cases, but in the general sense it is not what we want. This
  reverts behavior to what it was in 0.0.20: unhandled rejections will
  crash the process.

## 2.0.2

### Patch Changes

- 012573c: Add flags for optimizations: faster socket check, skipping warm request, and caching bootstrap file
