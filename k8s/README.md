# Kubernetes deployment

> **Note:** for the `cberg-home-nextgen` homelab, these files are reference
> templates only. Production rollout is owned by the `cluster-ops-agent` in
> the `cberg-home-nextgen` gitops repo and lands via Flux reconciliation —
> not via `kubectl apply` from here. See [`../CLAUDE.md`](../CLAUDE.md) for
> the full deployment workflow.
>
> The instructions below apply if you're standing this up on a different
> cluster (or for a one-off test deploy).

Manifests for running gas-price-monitor on a Kubernetes cluster. Image is
built by `.github/workflows/build.yml` and published to
`ghcr.io/nachtschatt3n/gas-price-monitor` on every push to `main` (tagged
`latest`, `sha-<short>`) and on `v*` tags (also tagged `v<version>`).

## Prerequisites

1. The GitHub Actions workflow has run at least once and pushed an image
   to GHCR. Check at <https://github.com/nachtschatt3n/gas-price-monitor/pkgs/container/gas-price-monitor>.

2. **Image visibility.** GHCR images are private by default. Pick one:
   - Make the image public: GitHub → your profile → Packages →
     `gas-price-monitor` → Package settings → Change visibility →
     Public. Now any cluster can pull it without credentials.
   - Keep it private: create an image pull secret in the cluster:
     ```sh
     kubectl create secret docker-registry ghcr-pull \
       --docker-server=ghcr.io \
       --docker-username=<github-username> \
       --docker-password=<github-PAT-with-read:packages>
     ```
     Then add `imagePullSecrets: [{name: ghcr-pull}]` to the Deployment
     spec.

## Deploy

```sh
# 1. API key as a secret (one-time)
kubectl create secret generic gas-price-monitor \
  --from-literal=api-key=YOUR_TANKERKOENIG_KEY

# 2. Workload
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml

# 3. Verify
kubectl rollout status deploy/gas-price-monitor
kubectl get pods -l app=gas-price-monitor
```

## Reach it

The Service is `ClusterIP` only. Pick how you want to expose it:

```sh
# Port-forward (quick test from your workstation)
kubectl port-forward svc/gas-price-monitor 3000:80
# → http://localhost:3000

# Or expose via your cluster's Ingress / Traefik / Tailscale Operator /
# whatever you already run. There is no Ingress manifest here on purpose;
# every cluster does this differently.
```

## Update to a new image

The workflow tags `:latest` on every `main` push and the Deployment uses
`imagePullPolicy: Always`, so a rollout restart pulls the newest:

```sh
kubectl rollout restart deploy/gas-price-monitor
```

For reproducible deploys, pin to a SHA tag instead of `:latest`:

```sh
kubectl set image deploy/gas-price-monitor app=ghcr.io/nachtschatt3n/gas-price-monitor:sha-abc1234
```

## Notes

- **No persistence.** History and alert state live in `emptyDir` volumes
  and reset on every pod restart. If you start caring about that, swap
  one or both `emptyDir: {}` entries for a `persistentVolumeClaim`.
- **No auth on the app.** The README is explicit: don't put this on the
  open internet. Inside a private cluster (or behind Tailscale) it's
  fine.
- **Tankerkönig fair-use.** The container honors the 5-minute cache, so
  one replica is correct. Do not scale `replicas` above 1 unless you
  also add a shared cache backend, or you'll multiply API hits and risk
  getting your key banned upstream.
