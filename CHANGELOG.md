# @valtown/deno-http-worker

## 2.0.0

### Major Changes

- 7fef5bf: Remove configurable spawn function option

  Previously, we supported a `spawnFunc` option which let you use spawn methods
  other than child_process.spawn. Given the lack of useful alternatives to child_process.spawn
  and our efforts to really optimize this module, we're removing this option.

### Patch Changes

- c834beb: Improve error testing
- 3bca30f: Internal refactor: use once() and move sync code out of promise callback

## 1.1.4

### Patch Changes

- 6764cf6: Don't close the pool (bugfix)

## 1.1.3

### Patch Changes

- 1ad123c: Don't include tests in NPM dist
- c9b56ac: Close request pools when terminating workers

## 1.1.2

### Patch Changes

- f009504: Adopt deno 2.5.x and OIDC

## 1.1.1

### Patch Changes

- c48cbdd: Adopt changesets
