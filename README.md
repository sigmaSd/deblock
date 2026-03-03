# deblock

Find blocking (synchronous) calls inside `async` functions in your Deno &
TypeScript projects.

## What it does

`deblock` uses [ts-morph](https://jsr.io/@ts-morph/ts-morph) to statically
analyze your code and detect synchronous blocking calls that shouldn't be in
async functions — a common source of performance issues in server-side code.

It detects:

- **Deno.\*Sync APIs** — `Deno.readTextFileSync`, `Deno.writeFileSync`,
  `Deno.statSync`, etc.
- **Node.js builtin sync APIs** — `readFileSync`, `execSync`, `spawnSync`, etc.
  from `node:fs`, `node:child_process`, `node:crypto`.
- **Blocking JSR dependencies** — traces through JSR dependency source code to
  find transitive blocking calls (e.g. `walkSync` from `@std/fs` internally
  calls `Deno.readDirSync`). Dependencies are resolved automatically from Deno's
  global cache.
- **Propagation** — if a sync function calls a blocker, and that sync function
  is called from an async function, it's reported with the full root cause
  chain.

## Install & Run

```sh
deno run -A jsr:@sigmasd/deblock
```

Or install it as a tool:

```sh
deno install -A -n deblock jsr:@sigmasd/deblock
deblock
```

## Usage

```
Usage: deblock [options] [<files...>]

Looks for blocking Deno APIs inside asynchronous functions.

Options:
  -e, --exclude <pattern>    Exclude files matching the glob pattern.
  -h, --help                 Show this help message.
```

### Scan the entire project

```sh
deblock
```

Discovers all `*.ts` and `*.tsx` files (excluding `node_modules`, `vendor`,
`.git`) and analyzes them.

### Scan specific files

```sh
deblock src/server.ts src/handlers.ts
```

### Exclude patterns

```sh
deblock -e "**/*_test.ts" -e "scripts/**"
```

## Example output

```
ERROR src/server.ts:42:5
  In async function: handleRequest
  Blocking call:     Deno.readTextFileSync("config.json")
  Reason:            Deno.readTextFileSync

ERROR src/utils.ts:18:10
  In async function: processFiles
  Blocking call:     walkSync(".")
  Reason:            walkSync is blocking (via Deno.readDirSync in @std/fs/walk.ts:909)

✖ Found blocking calls in async functions.
```

## JSR dependency tracing

JSR dependency detection works automatically. `deblock` runs `deno info --json`
internally to resolve all dependencies to their cached source files (in Deno's
global cache or a local `vendor/` directory). No special configuration is needed
— just make sure your dependencies are listed in `deno.json`.

## How it works

1. **Resolve dependencies** — runs `deno info --json` on user files to build a
   complete module graph mapping every import specifier to its local cached file
   path (works with both the global DENO_DIR cache and vendored dependencies).
2. **Parse** — loads source files into a ts-morph `Project` with a custom
   resolution host that uses the `deno info` module graph for resolution.
3. **Collect functions** — gathers all function-like declarations (functions,
   arrow functions, methods, constructors, accessors).
4. **Detect native blockers** — marks any function that directly calls a
   `Deno.*Sync` or Node.js sync API.
5. **Propagate** — iteratively marks non-async functions that call
   already-marked blocking functions.
6. **Report** — for each async function in user files, reports any direct or
   transitive blocking call with the root cause.

## Running tests

```sh
deno test -A
```

## License

MIT
