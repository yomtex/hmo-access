#!/usr/bin/env bash
# Example: sign and send a member push. Fictional values; replace INTEGRATION_ID and the secret.
# The secret is agreed out of band and stored by the platform under an environment variable name.
set -euo pipefail
BASE_URL="${BASE_URL:-https://hmo-access.example}"
INTEGRATION_ID="00000000-0000-0000-0000-000000000000"
SECRET="replace-with-the-shared-webhook-secret"
BODY_FILE="webhook-members-upsert.json"
EVENT_ID="shield-$(date +%Y%m%d%H%M%S)-0001"   # unique per event; reuse it only when retrying the same event

SIGNATURE=$(openssl dgst -sha256 -hmac "$SECRET" -hex < "$BODY_FILE" | sed 's/^.*= //')
curl -sS -X POST "$BASE_URL/v1/integrations/$INTEGRATION_ID/webhook" \
  -H "content-type: application/json" \
  -H "x-hmoa-event-id: $EVENT_ID" \
  -H "x-hmoa-signature: sha256=$SIGNATURE" \
  --data-binary "@$BODY_FILE"
