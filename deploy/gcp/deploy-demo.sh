#!/bin/sh
# Reproducible deploy of the PUBLIC demo dashboard (service: memoria-demo).
# Throwaway fake data, ephemeral (regenerated on every cold start), running under
# a ZERO-privilege service account (no Secret Manager, no real bucket) so a demo
# compromise cannot reach the real "memoria" service's secrets or data.
#
# One-time setup (zero-priv SA):
#   gcloud iam service-accounts create memoria-demo-runtime \
#     --display-name="Memoria demo (zero-priv)" --project "$PROJECT"
#   # grant it NOTHING.
#
# Usage: PROJECT=your-gcp-project ./deploy/gcp/deploy-demo.sh
# Run from the repo root (gcloud builds submit . uses the root Dockerfile).
set -eu

PROJECT="${PROJECT:?Set PROJECT to your GCP project id}"
REGION="${REGION:-us-central1}"
IMAGE="${IMAGE:-${REGION}-docker.pkg.dev/${PROJECT}/memoria/memoria:demo}"
SA="memoria-demo-runtime@${PROJECT}.iam.gserviceaccount.com"
DEMO_KEY="${DEMO_KEY:-memoria-demo}"

# BIND_ALL=true makes the server refuse to start without a distinct OAuth
# secret, a pinned encryption key and its public URL (see prodPostureFatal in
# http.ts). The demo's data is throwaway, so fresh random values per deploy
# are right: nothing encrypted needs to outlive the instance. The public URL
# is the service's deterministic Cloud Run URL; override with
# DEMO_PUBLIC_URL (e.g. a custom domain).
OAUTH_SECRET="$(openssl rand -hex 32)"
ENCRYPTION_KEY="$(openssl rand -hex 32)"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
PUBLIC_URL="${DEMO_PUBLIC_URL:-https://memoria-demo-${PROJECT_NUMBER}.${REGION}.run.app}"

# Build the demo image (includes mcp-server/scripts for the data generator).
# Build-only (--tag), so the real "memoria" service is never touched.
gcloud builds submit . --project "$PROJECT" --tag "$IMAGE" --timeout=20m

# Deploy. The container generates fake data into /tmp at startup, then serves.
# One instance: MCP sessions, dashboard logins and OAuth tokens live in the
# process, so a second instance fails requests that land on it at random.
gcloud run deploy memoria-demo \
  --project "$PROJECT" --region "$REGION" --platform managed --port 3100 \
  --image "$IMAGE" \
  --memory 512Mi --cpu 1 --min-instances 0 --max-instances 1 \
  --set-env-vars "BIND_ALL=true,DOCKER=true,MEMORIA_EMBEDDINGS=hash,MEMORIA_API_KEY=${DEMO_KEY},MEMORIA_OAUTH_CLIENT_SECRET=${OAUTH_SECRET},MEMORIA_ENCRYPTION_KEY=${ENCRYPTION_KEY},MEMORIA_PUBLIC_URL=${PUBLIC_URL}" \
  --args="sh,-c,node scripts/generate-demo-data.mjs --out /tmp/demo && MEMORIA_DIR=/tmp/demo node dist/http.js" \
  --service-account "$SA" \
  --allow-unauthenticated

echo "Demo deployed at ${PUBLIC_URL}. Dashboard key: ${DEMO_KEY}"
