---
"@valtown/deno-http-worker": major
---

Remove configurable spawn function option

Previously, we supported a `spawnFunc` option which let you use spawn methods
other than child_process.spawn. Given the lack of useful alternatives to child_process.spawn
and our efforts to really optimize this module, we're removing this option.
