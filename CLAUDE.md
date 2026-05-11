# CLAUDE.md

Project conventions for gas-price-monitor.

## Deployment workflow

The ship pipeline is split across two repos. This repo owns the
**artifact**; the homelab gitops repo owns the **rollout**.

### 1. Artifact (this repo)

- `/ship` (gstack skill) runs typecheck + unit tests, splits commits,
  pushes to `main`.
- `.github/workflows/build.yml` builds a linux/amd64 image and publishes
  it to `ghcr.io/nachtschatt3n/gas-price-monitor` with tags `latest`,
  `sha-<short>`, and `v<tag>` (on git tags).
- The manifests in [`k8s/`](k8s/) are **reference templates** for anyone
  running this elsewhere. They are NOT the source of truth for what runs
  in this homelab.

### 2. Rollout (`cberg-home-nextgen` gitops repo)

- The `cluster-ops-agent` (and its sub-agents: `health-check-agent`,
  `version-check-agent`, `security-agent`, `doc-agent`) owns every
  cluster-side action: bumping the image tag in the Flux-managed
  kustomization, rollout verification, post-deploy health checks.
- All cluster changes land via **git → Flux reconciliation** in
  `cberg-home-nextgen`. No direct `kubectl apply` against the prod
  cluster from this repo.

### Rolling out a new version

1. Land changes on `main` here. The build workflow publishes a new
   `:latest` and a `:sha-<short>` to GHCR.
2. In `cberg-home-nextgen`, invoke `cluster-ops-agent` with the new
   image tag (prefer the SHA tag for reproducible deploys, not
   `:latest`). The agent bumps the kustomization, commits, and Flux
   reconciles.
3. `cluster-ops-agent` orchestrates post-deploy verification through
   its sub-agents; no further action needed here.

## Testing

- `bun run typecheck` — strict TS, no emit.
- `bun test tests/` — Bun built-in runner; covers all `src/` modules.
- `bun test:e2e` — Playwright; needs browsers installed and the
  fixture server from `e2e/test-server.ts`.
- 100% coverage is the goal. New function → test. Bug fix → regression
  test. New conditional → tests for both branches.
