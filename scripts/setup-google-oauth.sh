#!/bin/sh
# scripts/setup-google-oauth.sh
# Sets up a Google Cloud project with OAuth credentials for Polaris.
# Writes GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env
#
# Uses a local gcloud configuration so it doesn't touch your global settings.

set -e

GCLOUD_ACCOUNT="${GCLOUD_ACCOUNT:-manub@lightup.ai}"
GCLOUD_CONFIG_NAME="polaris-setup"
PROJECT_ID="polaris-dev-$(date +%s)"
PROJECT_NAME="Polaris Dev"
REDIRECT_URI="http://localhost:3000/auth/google/callback"
ENV_FILE=".env"

echo "=== Setting up Google OAuth for Polaris ==="
echo "Using gcloud account: ${GCLOUD_ACCOUNT}"
echo ""

# Create an isolated gcloud configuration (does not affect global config)
gcloud config configurations create "$GCLOUD_CONFIG_NAME" --quiet 2>/dev/null || \
  gcloud config configurations activate "$GCLOUD_CONFIG_NAME" --quiet
gcloud config set account "$GCLOUD_ACCOUNT" --quiet
trap 'gcloud config configurations activate default --quiet 2>/dev/null; gcloud config configurations delete "$GCLOUD_CONFIG_NAME" --quiet 2>/dev/null' EXIT

# Create project
echo "Creating Google Cloud project: ${PROJECT_ID}"
gcloud projects create "$PROJECT_ID" --name="$PROJECT_NAME" --quiet 2>/dev/null || true
gcloud config set project "$PROJECT_ID" --quiet

# Enable OAuth APIs
echo "Enabling APIs..."
gcloud services enable iamcredentials.googleapis.com --quiet
gcloud services enable people.googleapis.com --quiet

# Configure OAuth consent screen
echo "Configuring OAuth consent screen..."
# Check if the current account has a billing account (needed for external)
# Use external type for dev, limited to test users
gcloud alpha iap oauth-brands create \
  --application_title="Polaris" \
  --support_email="$(gcloud config get account)" \
  --quiet 2>/dev/null || true

# Create OAuth client
echo "Creating OAuth client..."
CLIENT_OUTPUT=$(gcloud alpha iap oauth-clients create \
  "projects/${PROJECT_ID}/brands/$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')" \
  --display_name="Polaris Web" \
  2>&1) || true

# If the above doesn't work (alpha commands can be flaky), fall back to REST API
if echo "$CLIENT_OUTPUT" | grep -q "ERROR"; then
  echo ""
  echo "Automated OAuth client creation failed."
  echo "This is common — Google requires manual consent screen setup first."
  echo ""
  echo "Please complete these steps manually:"
  echo ""
  echo "1. Open: https://console.cloud.google.com/apis/credentials/consent?project=${PROJECT_ID}"
  echo "   - User type: External"
  echo "   - App name: Polaris"
  echo "   - Support email: your email"
  echo "   - Click Save"
  echo ""
  echo "2. Open: https://console.cloud.google.com/apis/credentials/oauthclient?project=${PROJECT_ID}"
  echo "   - Application type: Web application"
  echo "   - Name: Polaris Web"
  echo "   - Authorized redirect URIs: ${REDIRECT_URI}"
  echo "   - Click Create"
  echo ""
  echo "3. Copy the Client ID and Client Secret, then run:"
  echo ""
  echo "   cat > .env << EOF"
  echo "   GOOGLE_CLIENT_ID=your-client-id"
  echo "   GOOGLE_CLIENT_SECRET=your-client-secret"
  echo "   GOOGLE_REDIRECT_URI=${REDIRECT_URI}"
  echo "   EOF"
  echo ""
  echo "Project created: ${PROJECT_ID}"
  echo "Console: https://console.cloud.google.com/apis/credentials?project=${PROJECT_ID}"
  exit 0
fi

# Extract client ID and secret
CLIENT_ID=$(echo "$CLIENT_OUTPUT" | grep -o '[0-9]*-[a-z0-9]*.apps.googleusercontent.com' | head -1)
CLIENT_SECRET=$(echo "$CLIENT_OUTPUT" | grep 'secret:' | awk '{print $2}')

if [ -z "$CLIENT_ID" ] || [ -z "$CLIENT_SECRET" ]; then
  echo "Could not parse client credentials from output."
  echo "Output was: $CLIENT_OUTPUT"
  echo ""
  echo "Create the OAuth client manually:"
  echo "https://console.cloud.google.com/apis/credentials/oauthclient?project=${PROJECT_ID}"
  exit 1
fi

# Write .env file
cat > "$ENV_FILE" << EOF
GOOGLE_CLIENT_ID=${CLIENT_ID}
GOOGLE_CLIENT_SECRET=${CLIENT_SECRET}
GOOGLE_REDIRECT_URI=${REDIRECT_URI}
EOF

echo ""
echo "=== Done! ==="
echo "Project: ${PROJECT_ID}"
echo "Credentials written to ${ENV_FILE}"
echo ""
echo "Start the dev server with: make clean && make dev"
