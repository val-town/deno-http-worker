---
"@valtown/deno-http-worker": patch
---

Do not swallow unhandled rejections

In 0.0.21, behavior changed and unhandled rejections from Deno were
logged, and the Deno process would not crash. This might be useful for
some cases, but in the general sense it is not what we want. This
reverts behavior to what it was in 0.0.20: unhandled rejections will
crash the process.
