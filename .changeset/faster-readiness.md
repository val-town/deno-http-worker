---
"@valtown/deno-http-worker": patch
---

Detect worker readiness via a 1ms socket connect-retry loop instead of a 20ms fs.stat poll, cutting ~17ms of detection latency from every spawn
