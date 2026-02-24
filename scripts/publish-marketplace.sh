#!/usr/bin/env sh
set -eu

if [ -z "${VSCE_PAT:-}" ]; then
  echo "VSCE_PAT is required to publish to the VS Code Marketplace."
  exit 1
fi

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

echo "Publishing ${VSIX_PATH} to VS Code Marketplace..."
npx vsce publish --packagePath "${VSIX_PATH}" -p "${VSCE_PAT}"
echo "Publish complete."
