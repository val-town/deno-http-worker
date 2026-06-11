# @valtown/deno-http-worker

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
