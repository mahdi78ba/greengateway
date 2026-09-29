#!/usr/bin/env bash
# deploy/k3d/up.sh — the whole local cluster in one command:
#   1. create the k3d cluster "ggw" (once), host port 8090 -> gateway Service
#   2. build greengateway:dev and import it (and redis) into the cluster:
#      no registry, and no slow in-cluster pulls
#   3. helm upgrade --install the chart with config/tenants.yaml
#
# The cluster's kubeconfig lives in .k3d/kubeconfig.yaml (git-ignored) and is
# NEVER merged into ~/.kube: a lab tool must not touch files that may hold real
# cluster credentials. Every kubectl/helm call sets KUBECONFIG explicitly.
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p .k3d
export KUBECONFIG="$PWD/.k3d/kubeconfig.yaml"
CLUSTER=ggw
RELEASE=ggw

if ! k3d cluster list -o json | grep -q "\"name\":\"$CLUSTER\""; then
  echo "== creating cluster $CLUSTER (first time: k3s pulls its own add-ons, a few minutes on a slow link)"
  k3d cluster create "$CLUSTER" \
    --port "8090:8080@loadbalancer" \
    --k3s-arg "--disable=traefik@server:0" \
    --kubeconfig-update-default=false --kubeconfig-switch-context=false \
    --wait
fi
k3d kubeconfig get "$CLUSTER" > "$KUBECONFIG"
kubectl wait --for=condition=Ready node --all --timeout=180s >/dev/null

# Import ONE platform of an image, and verify it really reached the node.
# `docker save` of a multi-platform image (e.g. redis:8-alpine pulled from
# Docker Hub) writes an index whose other platforms have no content; containerd
# then imports nothing usable while k3d still prints "Successfully imported".
PLATFORM="linux/$(docker version --format '{{.Server.Arch}}')"
import_image() {
  local img=$1 ref="docker.io/library/$1" tar=".k3d/$(echo "$1" | tr '/:' '__').tar"
  docker save --platform "$PLATFORM" "$img" -o "$tar"
  for attempt in 1 2 3; do
    k3d image import "$tar" -c "$CLUSTER" >/dev/null 2>&1 || true
    if docker exec "k3d-$CLUSTER-server-0" ctr -n k8s.io images ls -q | grep -qx "$ref"; then
      rm -f "$tar"; echo "   imported $img ($PLATFORM)"; return 0
    fi
    echo "   $img not visible in the node yet (attempt $attempt), retrying"; sleep 3
  done
  rm -f "$tar"; echo "!! could not import $img into the cluster"; return 1
}

echo "== building greengateway:dev, importing it and redis into the cluster"
docker build -q -t greengateway:dev .
docker image inspect redis:8-alpine >/dev/null 2>&1 || docker pull -q redis:8-alpine
import_image greengateway:dev
import_image redis:8-alpine

# A first install that never completed (e.g. a timeout) leaves a release with
# no deployed revision, which `helm upgrade --install` refuses to touch.
if helm status "$RELEASE" >/dev/null 2>&1 && ! helm history "$RELEASE" | grep -q deployed; then
  echo "== previous install never completed; removing it first"
  helm uninstall "$RELEASE" --wait
fi

echo "== deploying the chart"
helm upgrade --install "$RELEASE" deploy/helm/greengateway \
  --set-file tenantsYaml=config/tenants.yaml \
  --wait --timeout 10m
# A re-imported image keeps the same tag, so make the pods pick it up.
kubectl rollout restart deployment -l app.kubernetes.io/instance="$RELEASE" >/dev/null
kubectl rollout status deployment/ggw-greengateway --timeout=3m

echo
kubectl get pods,svc,hpa -l app.kubernetes.io/instance="$RELEASE"
echo
echo "gateway: http://localhost:8090   (export KUBECONFIG=$KUBECONFIG for kubectl)"
