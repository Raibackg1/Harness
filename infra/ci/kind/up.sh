#!/usr/bin/env bash
# Disposable Kubernetes for end-to-end validation: kind + gVisor (runsc) in the node, a local
# registry so images are referenced by digest, an in-cluster PostgreSQL, and the control
# plane and worker applied from infra/k8s with only the placeholders substituted.
# NOT a production install: no ingress controller, no TLS, a throwaway database.
set -euo pipefail
cd "$(dirname "$0")/../../.."
CLUSTER=${CLUSTER:-harness-e2e}
REG_PORT=5001
GVISOR_RELEASE=${GVISOR_RELEASE:-latest}
work=$(mktemp -d)

echo "::group::local registry"
if [ "$(docker inspect -f '{{.State.Running}}' kind-registry 2>/dev/null || true)" != "true" ]; then
  docker run -d --restart=always -p "127.0.0.1:${REG_PORT}:5000" --name kind-registry registry:2
fi
echo "::endgroup::"

echo "::group::kind cluster"
cat >"$work/kind.yaml" <<'EOF'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
containerdConfigPatches:
  - |-
    [plugins."io.containerd.grpc.v1.cri".registry]
      config_path = "/etc/containerd/certs.d"
EOF
kind create cluster --name "$CLUSTER" --config "$work/kind.yaml" --wait 180s
node="${CLUSTER}-control-plane"
docker network connect kind kind-registry 2>/dev/null || true
docker exec "$node" mkdir -p "/etc/containerd/certs.d/localhost:${REG_PORT}"
printf '[host."http://kind-registry:5000"]\n' |
  docker exec -i "$node" tee "/etc/containerd/certs.d/localhost:${REG_PORT}/hosts.toml" >/dev/null
echo "::endgroup::"

echo "::group::gVisor in the node"
base="https://storage.googleapis.com/gvisor/releases/release/${GVISOR_RELEASE}/$(uname -m)"
for bin in runsc containerd-shim-runsc-v1; do
  curl -fsSL "$base/$bin" -o "$work/$bin"
  curl -fsSL "$base/$bin.sha512" -o "$work/$bin.sha512"
  (cd "$work" && sha512sum -c "$bin.sha512")
  chmod 0755 "$work/$bin"
  docker cp "$work/$bin" "$node:/usr/local/bin/$bin"
done
# kind's kubelet uses the systemd cgroup driver, so runsc must too.
printf '[runsc_config]\n  systemd-cgroup = "true"\n' |
  docker exec -i "$node" tee /etc/containerd/runsc.toml >/dev/null
if docker exec "$node" grep -q '^version = 3' /etc/containerd/config.toml; then
  section="plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.runsc"
else
  section='plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc'
fi
docker exec -i "$node" tee -a /etc/containerd/config.toml >/dev/null <<EOF

[$section]
  runtime_type = "io.containerd.runsc.v1"
[$section.options]
  TypeUrl = "io.containerd.runsc.v1.options"
  ConfigPath = "/etc/containerd/runsc.toml"
EOF
docker exec "$node" systemctl restart containerd
kubectl wait --for=condition=Ready "node/$node" --timeout=120s
kubectl apply -f - <<'EOF'
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: gvisor
handler: runsc
EOF
echo "::endgroup::"

echo "::group::images by digest"
digest() { docker inspect -f '{{index .RepoDigests 0}}' "$1" | sed 's/.*@//'; }
docker build -q -t "localhost:${REG_PORT}/harness-control:e2e" .
docker build -q -f runtime/Dockerfile -t "localhost:${REG_PORT}/harness-workspace:e2e" .
docker push -q "localhost:${REG_PORT}/harness-control:e2e"
docker push -q "localhost:${REG_PORT}/harness-workspace:e2e"
control_digest=$(digest "localhost:${REG_PORT}/harness-control:e2e")
workspace_digest=$(digest "localhost:${REG_PORT}/harness-workspace:e2e")
echo "control ${control_digest}  workspace ${workspace_digest}"
echo "::endgroup::"

echo "::group::throwaway PostgreSQL"
db_password=$(openssl rand -hex 16)
kubectl create namespace harness-db
kubectl -n harness-db create secret generic postgres --from-literal=password="$db_password"
kubectl -n harness-db apply -f - <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata: { name: postgres }
spec:
  selector: { matchLabels: { app: postgres } }
  template:
    metadata: { labels: { app: postgres } }
    spec:
      containers:
        - name: postgres
          image: postgres:17.6
          env:
            - { name: POSTGRES_USER, value: harness }
            - { name: POSTGRES_DB, value: harness }
            - name: POSTGRES_PASSWORD
              valueFrom: { secretKeyRef: { name: postgres, key: password } }
          ports: [{ containerPort: 5432 }]
          readinessProbe:
            exec: { command: [pg_isready, -U, harness] }
            periodSeconds: 3
---
apiVersion: v1
kind: Service
metadata: { name: postgres }
spec:
  selector: { app: postgres }
  ports: [{ port: 5432 }]
EOF
kubectl -n harness-db rollout status deployment/postgres --timeout=180s
echo "::endgroup::"

echo "::group::control plane from infra/k8s"
overlay="$work/k8s"
cp -r infra/k8s "$overlay"
sed -i \
  -e "s#ghcr.io/YOUR-ORG/harness-workspace@sha256:REPLACE_WITH_VERIFIED_IMAGE_DIGEST#localhost:${REG_PORT}/harness-workspace@${workspace_digest}#" \
  -e "s#REPLACE_WITH_CSI_CLASS#standard#" \
  "$overlay/config.yaml"
sed -i \
  -e "s#ghcr.io/YOUR-ORG/harness-control#localhost:${REG_PORT}/harness-control#" \
  -e "s#sha256:REPLACE_WITH_VERIFIED_IMAGE_DIGEST#${control_digest}#" \
  "$overlay/kustomization.yaml"
# kind: API server behind the node network, pods and services in the default ranges.
sed -i \
  -e "s#- ipBlock: { cidr: REPLACE_WITH_API_SERVER_CIDR }#- ipBlock: { cidr: 172.18.0.0/16 }\n        - ipBlock: { cidr: 10.96.0.0/12 }#" \
  -e "s#- ipBlock: { cidr: REPLACE_WITH_POSTGRES_CIDR }#- ipBlock: { cidr: 10.244.0.0/16 }#" \
  "$overlay/networking.yaml"
if grep -rn "REPLACE_WITH\|YOUR-ORG" "$overlay"; then
  echo "unsubstituted placeholders remain" >&2
  exit 1
fi
kubectl apply -f "$overlay/namespace.yaml"
BOOTSTRAP_TOKEN=$(openssl rand -hex 32)
kubectl -n harness-system create secret generic harness-secrets \
  --from-literal=DATABASE_URL="postgresql://harness:${db_password}@postgres.harness-db.svc.cluster.local:5432/harness" \
  --from-literal=ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  --from-literal=BOOTSTRAP_TOKEN="$BOOTSTRAP_TOKEN"
kubectl apply -k "$overlay"
kubectl -n harness-system rollout status deployment/harness-api --timeout=240s
kubectl -n harness-system rollout status deployment/harness-worker --timeout=240s
echo "::endgroup::"

if [ -n "${GITHUB_ENV:-}" ]; then
  echo "::add-mask::$BOOTSTRAP_TOKEN"
  echo "BOOTSTRAP_TOKEN=$BOOTSTRAP_TOKEN" >>"$GITHUB_ENV"
else
  echo "BOOTSTRAP_TOKEN=$BOOTSTRAP_TOKEN"
fi
