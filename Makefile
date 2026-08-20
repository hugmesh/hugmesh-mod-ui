# HugMesh mod-ui — developer convenience targets.
#
# `make pentest` runs the SAME pen-test posture as CI (the centralized OWASP
# stage included by .gitlab-ci.yml), locally:
#   * SCA self-scan: this is an Angular repo, so `npm audit` mirrors the
#     dependency-check SCA gate (CI runs full OWASP Dependency-Check via the
#     owasp/dependency-check image; see note below to run that locally too).
#   * DAST: when DAST_TARGET_URL is set, delegate to the shared generator
#     harness (tests/pentest/run-pentest.sh) — the SAME script the CI
#     .pentest-dast-baseline job drives. Self-contained: never hard-fails when
#     a target or tooling is absent.
#
# Tunables (env):
#   NPM_AUDIT_LEVEL   audit severity gate          (default: high)
#   DAST_TARGET_URL   live target for the DAST run  (default: unset -> skipped)
#   PENTEST_HARNESS_DIR  path to the generator pentest harness
#                        (default: ../hugmesh-generator/tests/pentest)
#   PENTEST_SCAN      baseline | full              (default: baseline)

NPM_AUDIT_LEVEL ?= high
PENTEST_SCAN ?= baseline
PENTEST_HARNESS_DIR ?= ../hugmesh-generator/tests/pentest

.PHONY: pentest pentest-sca pentest-dast

pentest: pentest-sca pentest-dast ## Run the local pen-test posture (SCA + optional DAST)

pentest-sca: ## SCA self-scan (mirrors the CI Dependency-Check gate)
	@echo "==> [pentest] SCA self-scan (npm audit --audit-level=$(NPM_AUDIT_LEVEL))"
	@npm audit --audit-level=$(NPM_AUDIT_LEVEL) || \
		echo "==> [pentest] npm audit reported findings (non-blocking locally; CI gates via OWASP Dependency-Check)"
	@echo "==> [pentest] NOTE: CI runs full OWASP Dependency-Check. To match locally:"
	@echo "    docker run --rm -v \"$$PWD:/src\" owasp/dependency-check:latest \\"
	@echo "      --project $(notdir $(CURDIR)) --scan /src --failOnCVSS 7 --enableExperimental \\"
	@echo "      --format HTML --out /src/reports/sca"

pentest-dast: ## DAST harness against $$DAST_TARGET_URL (delegates to the generator harness)
	@if [ -z "$(DAST_TARGET_URL)" ]; then \
		echo "==> [pentest] DAST skipped: DAST_TARGET_URL not set."; \
		echo "    To run the full authenticated ZAP harness (baseline + probes + nuclei),"; \
		echo "    set DAST_TARGET_URL and ensure the generator harness is available, e.g.:"; \
		echo "    git clone https://github.com/hugmesh/hugmesh-generator.git"; \
		echo "    DAST_TARGET_URL=http://localhost:4200 \\"; \
		echo "      bash $(PENTEST_HARNESS_DIR)/run-pentest.sh --env compose --scan $(PENTEST_SCAN) --pipeline main"; \
	elif [ -x "$(PENTEST_HARNESS_DIR)/run-pentest.sh" ]; then \
		echo "==> [pentest] DAST against $(DAST_TARGET_URL) via $(PENTEST_HARNESS_DIR)/run-pentest.sh"; \
		bash "$(PENTEST_HARNESS_DIR)/run-pentest.sh" --env compose --scan $(PENTEST_SCAN) --pipeline main || \
			echo "==> [pentest] DAST harness reported findings/errors (non-blocking locally)"; \
	else \
		echo "==> [pentest] DAST_TARGET_URL=$(DAST_TARGET_URL) but harness not found at $(PENTEST_HARNESS_DIR)/run-pentest.sh"; \
		echo "    Clone it: git clone https://github.com/hugmesh/hugmesh-generator.git"; \
		echo "    then re-run, or set PENTEST_HARNESS_DIR to the harness path."; \
	fi
