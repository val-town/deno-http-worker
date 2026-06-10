---
"@valtown/deno-http-worker": patch
---

Detect worker readiness via fs.watch on a private per-worker socket directory instead of a 20ms fs.stat poll. Experimental alternative to the connect-retry approach in #120, for comparison.
