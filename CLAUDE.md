# CLAUDE.md

Project conventions for gas-price-monitor. This file is the source of
truth for "how we work here". Read it before making non-trivial changes.

## What this is

A local-network dashboard for German fuel prices. Bun serves static HTML
plus a thin proxy to the [Tankerkönig](https://creativecommons.tankerkoenig.de/)
API. Personal/homelab scope. No auth. About 2,400 lines across `src/`,
`tests/`, `e2e/`, and one HTML page.

## Stack

- **Bun** (1.3+) runs `.ts` files directly. No build step, no transpile.
  `tsconfig.json` sets `allowImportingTsExtensions: true`, so imports
  include the `.ts` suffix.
- **Zero runtime dependencies.** Only Node stdlib (`node:fs/promises`,
  `node:path`, `node:crypto`) plus Bun-native APIs (`Bun.serve`,
  `Bun.file`, `Bun.write`). DevDeps are limited to TypeScript,
  `@types/bun`, and `@playwright/test`.
- **Tests** use Bun's built-in `bun:test` runner. No vitest, no jest.

## Project structure

```
src/
  server.ts        entry point: env parsing, Bun.serve wiring
  app.ts           createApp(): HTTP routing, dependency-injected
  tankerkoenig.ts  upstream API client (only module that knows about it)
  cache.ts         5-minute disk cache (fair-use enforcement)
  history.ts       append-only JSONL price history with rotation
  alerts.ts        threshold-crossing alerts (webhook + libnotify)
public/
  index.html       single-page UI, no framework, no bundler
tests/             unit tests; all I/O mocked via DI
e2e/               Playwright tests + fixture server
k8s/               reference manifests (NOT the prod source of truth)
.github/workflows/ image build pipeline (push to main triggers it)
```

Module dependency direction: `tankerkoenig.ts` is the leaf (only types
escape). `cache`, `history`, `alerts` each depend only on its types.
`app.ts` composes the three. `server.ts` boots `app.ts`.

## Conventions

### Dependency injection over module-level singletons

`createApp(env, deps)` accepts overrides for `fetch`, `now`, `cache`,
`history`, `alerts`. Tests pass in fakes; production passes nothing and
gets real implementations. New modules follow the same pattern: take
your dependencies as constructor args, never reach for
`globalThis.fetch` or `Date.now()` directly inside business logic.

### Env validation at the boundary, never inside business logic

`parseEnv(process.env, ...)` runs once at startup. Invalid values throw,
and `server.ts` exits with status 1 and a clear message. Inside `app.ts`
and below, env values arrive as a typed `AppEnv` object. No
`process.env.FOO` reads anywhere else.

Request params follow the same shape: `parseNum()` in `app.ts` validates
with explicit min/max and throws `ValidationError` (HTTP 400). Handlers
catch and convert to JSON.

### TypeScript

- Strict mode. No `any`. No `@ts-ignore`. No `@ts-expect-error` without
  a comment explaining the exact failure mode being suppressed.
- `interface` for object shapes, `type` for unions and aliases.
- Imports use the `.ts` extension. Both Bun and our tsconfig require it.

### Tests

- One test file per src module: `tests/<module>.test.ts`.
- Use `bun:test`'s `describe`/`it`/`expect`. No external assertion libs.
- Mock external I/O via the DI seams above. Never touch the real
  Tankerkönig API or the host's notify-send daemon from a unit test.
- 100% coverage is the goal. New function gets a test. Bug fix gets a
  regression test. New conditional gets tests for both branches. Never
  commit code that breaks an existing test.

### Commits

`/ship` (gstack) splits commits along module boundaries. Each commit
should be independently typecheckable. The final commit in a series
carries the `Co-Authored-By` trailer.

## Architecture decisions that matter

1. **Single replica only.** The cache is local disk. Two replicas means
   two caches and twice the upstream API hits. Tankerkönig asks for a
   5-minute cache; violating that risks getting the API key throttled
   or banned. If you ever want HA, you need a shared cache backend
   (Redis or similar) first.

2. **5-minute cache is non-negotiable in production.** Default
   `CACHE_TTL_MS` is 300000 (5 min). The schema allows lower values for
   dev convenience (min 1000ms), but anything below 300000 in prod
   violates Tankerkönig's terms.

3. **No auth on the server.** Designed for private networks (LAN,
   Tailscale, Wireguard). Don't put it on the open internet.

4. **State is ephemeral in containers.** The k8s Deployment uses
   `emptyDir` for both `/cache` and `/data`. Pod restart wipes history
   and alert dedupe state. If you change this, also reconsider the
   single-replica rule: shared-filesystem caches can race on writes.

5. **No bundler for the UI.** `public/index.html` is hand-written HTML
   plus vanilla JS. Adding a build step is a one-way door: once there's
   a bundler, every contributor needs the toolchain. Stay bundler-free
   until there's a real reason.

6. **Bun-native APIs are fine.** This will never run on Node.js, so use
   `Bun.file`, `Bun.write`, `Bun.serve` freely. Don't paper over them
   with cross-runtime shims.

## Deployment workflow

The ship pipeline is split across two repos. This repo owns the
**artifact**; the homelab gitops repo owns the **rollout**.

### 1. Artifact (this repo)

- `/ship` runs typecheck + unit tests, splits commits, pushes to `main`.
- `.github/workflows/build.yml` builds a `linux/amd64` image and
  publishes it to `ghcr.io/nachtschatt3n/gas-price-monitor` with tags
  `latest`, `sha-<short>`, and `v<tag>` (on git tags).
- Manifests in `k8s/` are reference templates for anyone running this
  elsewhere. They are NOT the source of truth for what runs in the
  homelab.

### 2. Rollout (`cberg-home-nextgen` gitops repo)

- The `cluster-ops-agent` (and its sub-agents `health-check-agent`,
  `version-check-agent`, `security-agent`, `doc-agent`) owns every
  cluster-side action: bumping the image tag in the Flux-managed
  kustomization, rollout verification, post-deploy health checks.
- All cluster changes land via git → Flux reconciliation in
  `cberg-home-nextgen`. No direct `kubectl apply` against the prod
  cluster from this repo.

### Rolling out a new version

1. Land changes on `main` here. The build workflow publishes a new
   `:latest` and `:sha-<short>` to GHCR.
2. In `cberg-home-nextgen`, invoke `cluster-ops-agent` with the new
   image tag. Prefer the SHA tag for reproducible deploys, not
   `:latest`. The agent bumps the kustomization, commits, and Flux
   reconciles.
3. `cluster-ops-agent` orchestrates post-deploy verification through
   its sub-agents; no further action needed here.

## Don't

- Don't add an npm runtime dependency. Check Bun or node stdlib first.
- Don't read `process.env` outside `parseEnv`.
- Don't scale `replicas > 1` without a shared cache backend.
- Don't lower `CACHE_TTL_MS` below 300000 in production.
- Don't `kubectl apply` from this repo against the prod cluster.
  Production rollout goes through `cberg-home-nextgen` Flux.
- Don't commit `.env` or `bun.lock` (both gitignored).
- Don't ship a container with `ALERT_DESKTOP_NOTIFY=true`: libnotify
  isn't available in the Alpine image.
- Don't introduce a UI build step without a real reason.

## Skill routing

When the user's request matches an available gstack skill, invoke it
via the Skill tool. When in doubt, invoke the skill.

- Product ideas / brainstorming → `/office-hours`
- Strategy / scope → `/plan-ceo-review`
- Architecture → `/plan-eng-review`
- Full review pipeline → `/autoplan`
- Bugs / errors → `/investigate`
- QA / testing site behavior → `/qa` or `/qa-only`
- Code review on a diff → `/review`
- Ship / deploy / PR → `/ship` (artifact only; rollout is owned by
  `cluster-ops-agent` in `cberg-home-nextgen`)
- Save / resume progress → `/context-save` / `/context-restore`
