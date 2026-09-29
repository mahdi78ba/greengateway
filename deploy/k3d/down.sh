#!/usr/bin/env bash
# deploy/k3d/down.sh — delete the local cluster and its kubeconfig.
set -euo pipefail
cd "$(dirname "$0")/../.."
k3d cluster delete ggw || true
rm -f .k3d/kubeconfig.yaml
echo "cluster ggw deleted (the k3s and greengateway images stay in Docker)"
