# Loom VS Code Extension Makefile
# Wraps npm scripts to match loom-core patterns

.PHONY: all build test lint format check ci package watch clean setup help dev-install

# Default target
all: check build

# Build the extension
build:
	npm run compile

# Run tests
test:
	npm run test

# Run tests in watch mode
test-watch:
	npm run test:watch

# Run tests with coverage
coverage:
	npm run test:coverage

# Run linter
lint:
	npm run lint

# Run linter with auto-fix
lint-fix:
	npm run lint:fix

# Format code with prettier
format:
	npm run format

# Check formatting without modifying files
format-check:
	npm run format:check

# Run all checks (lint + format check + typecheck)
check:
	npm run check

# CI target: full check + coverage
ci: check coverage

# Package extension as .vsix
package:
	npm run package

# Build, package, and install in VS Code + Antigravity
dev-install: build package
	@set -e; \
	VSIX="$$(ls -t loom-*.vsix 2>/dev/null | head -n1)"; \
	if [ -z "$$VSIX" ]; then \
		echo "No VSIX package found. Run 'make package' first."; \
		exit 1; \
	fi; \
	if ! command -v code >/dev/null 2>&1; then \
		echo "'code' CLI not found. Install VS Code shell command first."; \
		exit 1; \
	fi; \
	echo "Installing $$VSIX into VS Code..."; \
	code --install-extension "$$VSIX" --force; \
	if command -v antigravity >/dev/null 2>&1; then \
		echo "Installing $$VSIX into Antigravity..."; \
		if ! antigravity --install-extension "$$VSIX"; then \
			echo "Warning: Antigravity install failed (exit $$?)."; \
			echo "VS Code install succeeded. You can retry Antigravity manually:"; \
			echo "  antigravity --install-extension $$VSIX"; \
			if [ "$${STRICT_ANTIGRAVITY_INSTALL:-0}" = "1" ]; then \
				echo "STRICT_ANTIGRAVITY_INSTALL=1 set, failing dev-install."; \
				exit 1; \
			fi; \
		fi; \
	else \
		echo "Warning: 'antigravity' CLI not found. Skipping Antigravity install."; \
	fi; \
	echo "Installed $$VSIX in VS Code (Antigravity best-effort)."

# Watch mode for development
watch:
	npm run watch

# Clean build artifacts
clean:
	rm -rf out/
	rm -rf *.vsix

# Install dependencies
setup:
	npm install

# Reinstall dependencies from scratch
setup-clean:
	rm -rf node_modules/
	npm install

# Prepare for publishing (runs prepublish hook)
prepublish:
	npm run vscode:prepublish

# Show help
help:
	@echo "Loom VS Code Extension - Available targets:"
	@echo ""
	@echo "  make build         - Compile TypeScript"
	@echo "  make test          - Run tests"
	@echo "  make test-watch    - Run tests in watch mode"
	@echo "  make coverage      - Run tests with coverage"
	@echo "  make lint          - Run ESLint"
	@echo "  make lint-fix      - Run ESLint with auto-fix"
	@echo "  make format        - Format code with Prettier"
	@echo "  make format-check  - Check formatting"
	@echo "  make check         - Run all checks (lint + format + typecheck)"
	@echo "  make package       - Package as .vsix"
	@echo "  make dev-install   - Build/package, install in VS Code, then best-effort Antigravity"
	@echo "  make watch         - Watch mode for development"
	@echo "  make clean         - Remove build artifacts"
	@echo "  make setup         - Install dependencies"
	@echo "  make setup-clean   - Clean reinstall dependencies"
	@echo "  make prepublish    - Run prepublish hook"
	@echo "  make help          - Show this help"
