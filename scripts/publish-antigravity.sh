#!/usr/bin/env sh
set -eu

VERSION=$(node -p "require('./package.json').version")
if [ -n "${CI_COMMIT_TAG:-}" ] && [ "v${VERSION}" != "${CI_COMMIT_TAG}" ]; then
  echo "Tag/version mismatch: package.json=${VERSION}, CI_COMMIT_TAG=${CI_COMMIT_TAG}"
  exit 1
fi

VSIX_PATH=$(ls -1 loom-*.vsix 2>/dev/null | head -n1 || true)
if [ -z "${VSIX_PATH}" ]; then
  echo "No VSIX artifact found. Building package locally..."
  npm run package
  VSIX_PATH=$(ls -1 loom-*.vsix 2>/dev/null | head -n1 || true)
fi

if [ -z "${VSIX_PATH}" ]; then
  echo "Failed to locate VSIX artifact after packaging."
  exit 1
fi

if [ -n "${ANTIGRAVITY_STORE_UPLOAD_URL:-}" ]; then
  if [ -z "${ANTIGRAVITY_STORE_TOKEN:-}" ]; then
    echo "ANTIGRAVITY_STORE_TOKEN is required when ANTIGRAVITY_STORE_UPLOAD_URL is set."
    exit 1
  fi

  echo "Uploading ${VSIX_PATH} to ${ANTIGRAVITY_STORE_UPLOAD_URL}..."
  curl --fail --show-error --silent \
    -H "Authorization: Bearer ${ANTIGRAVITY_STORE_TOKEN}" \
    -F "file=@${VSIX_PATH}" \
    -F "version=${VERSION}" \
    "${ANTIGRAVITY_STORE_UPLOAD_URL}"
  echo "Upload complete."
  exit 0
fi

if [ -z "${OVSX_PAT:-}" ]; then
  echo "No Antigravity publish credentials found."
  echo "Set OVSX_PAT (Open VSX path) or ANTIGRAVITY_STORE_UPLOAD_URL + ANTIGRAVITY_STORE_TOKEN."
  exit 1
fi

echo "Publishing ${VSIX_PATH} via ovsx..."
if [ -n "${ANTIGRAVITY_REGISTRY_URL:-}" ]; then
  npx --yes ovsx publish "${VSIX_PATH}" --registryUrl "${ANTIGRAVITY_REGISTRY_URL}" -p "${OVSX_PAT}"
else
  npx --yes ovsx publish "${VSIX_PATH}" -p "${OVSX_PAT}"
fi
echo "Publish complete."
