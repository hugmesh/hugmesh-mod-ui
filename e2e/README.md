# hugmesh-mod-ui — e2e (Playwright + playwright-bdd)

Gherkin-driven end-to-end tests for the mod-ui federated remote. The setup is copied from the
`hugmesh-games/e2e` pattern: `@playwright/test` with `playwright-bdd`, one worker running serially,
`screenshot:'on'` and `video:'on'`, an HTML reporter, and a per-step PNG `AfterStep` hook in
`features/support/fixtures.ts`. It mirrors the wave-2b PRs admin-ui#39,
superadmin-appstore-ui#2 and login-ui#19.

The mod-ui is the **moderation keystone**. Its one rule: a **MOD acts over USERs but is NOT a
superset of ADMIN**. Refer, recommend, ban, domain-lock and block are wired. DECIDE, role-grant and
external-client have no mod-bff endpoint, so they render `aria-disabled` with helptext that says
why. The suite leads with the cross-user and DENY coverage that rule demands:

| Class | Feature file | What it asserts |
| --- | --- | --- |
| USER-SITUATIONAL | `features/moderation/mod-surfaces.feature` | modGuard ALLOW (mod *or* admin; the seeded superadmin persona carries both `superadmin` and `admin`) and DENY (plain user → /login, signed-out visitor bounced). The admin-only DECIDE / role-grant / external-client controls are **disabled + helptext**. Required-field validation alert. The API **honest-envelope** contract: ban/lift always 202 pending-reconcile; the /bff/mod/block Matrix-user row expects `external: stubbed` and the Mastodon row `stubbed`/`degraded`, never a fake OK (see the note below the table on the Matrix row) |
| USER-SITUATIONAL | `features/moderation/findings-panel.feature` | The findings panel's own modGuard ALLOW (mod *or* admin, per-tenant parallel ALLOW) and DENY floor (plain user / signed-out visitor → /login). Behind it, mod-bff's own filter-chain role gate on `GET /bff/mod/findings`: mod 200, plain user 403, anonymous 401 |
| USER-SITUATIONAL | `features/moderation/findings-triage.feature` | The findings-panel VIEW (triage columns, closed disposition vocabulary, empty-queue message). FILTER: a captured `GET /bff/mod/findings?status=` reload per disposition. RESOLVE: the id-independent 403/401 role gate, and, through the `POST /bff/mod/findings/test-seed` fixture, a real victim-creates-first Confirm/Dismiss round-trip (outbound request, server-side status change, accessible outcome note) |
| MULTIUSER | `features/multiuser/mod-over-user.feature` | A mod acting over a user: recommend and refer (escalate to admin); ban (timed **TTL**, **permanent** and **lift**, on matrix **and mastodon**); domain-lock; server-wide block; a **profile**-platform ban + lift. TTL semantics are pinned on the **captured `/bff/mod/ban` request body** (`ttlSeconds` present = timed, omitted = permanent) because both variants render the same accepted note. An **admin performs** the same writes, not just views them. Refer is wired but decide is disabled on the same row. The queue status filter and the audit-trail **"only my own actions"** toggle are each pinned on their captured scoped-GET reload (`?status=` / `?mine=true`) |
| CROSS-USER | `features/cross-user/mod-isolation.feature` | A mod is DENIED on a privileged target (admin or another mod), on **self**, and **cross-tenant** (domain-A mod on domain-B). The UI announces a role=alert; mod-bff answers 403/404; anonymous gets 401 |
| CROSS-USER (consequences) | `features/cross-user/mod-consequences.feature` | The TARGET **sees** the mod's action in their own context at the shared front door. A matrix ban gates the target's hsproxy access and matrix UI identity, and a lift restores them. A mastodon domain-lock coerces the target's composer federated-reach options, and an unlock re-enables them. A matrix **domain-lock** marker shows on the target side (the form's default platform). A **timed ban auto-restores** at TTL without a lift. A mod's **refer** arrives in an admin's queue view. A user's `recommend-instance-block` submission lands in the mod queue |
| CROSS-USER (decide) | `features/cross-user/admin-decide.feature` | The ADMIN approve/deny DECIDE round-trip this console wires (`data-approve`/`data-deny` → `AdminBffService.decide`). Approve and deny each flip the ONE unique row, and both the deciding admin and the **referring mod** see the new status. The `mc-decide-error` failure surface: a transport-500 injection leaves the row at `referred`, nothing fabricated. Two admins deciding the same row settle to exactly ONE server-authoritative terminal status |
| CROSS-USER (contention) | `features/cross-user/mod-refer-contention.feature` | Mod A refers a per-scenario unique row. A second SAME-tenant mod's reloaded queue shows it `referred` with the refer control **disabled**, so no double-refer |
| CROSS-USER (contention) | `features/cross-user/findings-contention.feature` | Two same-tenant mods race ONE seeded held finding. A confirms (`actioned`); B's stale dismiss is **rejected**; a reload shows A's server-authoritative outcome stands |
| CROSS-USER (tenant) | `features/cross-user/findings-tenant-isolation.feature` | Victim-creates-first: a domain-B mod, who PASSES the role gate, can neither SEE a REAL domain-A seeded finding in their own domain-scoped queue nor RESOLVE it (404). This is the DOMAIN boundary, distinct from the plain-user 403 ROLE gate |
| CROSS-USER (audit) | `features/cross-user/audit-trail.feature` | "Always locally audited", proven: a mod's block on a per-scenario unique target produces a visible `mc-audit` row, and a second SAME-tenant mod sees the SAME row with the SAME actor. It is a shared server record, not a per-browser echo |
| STEP-UP (mocked) | `features/moderation/mfa-step-up-mocked.feature` | The step-up loop on ban, domain-lock and block against a MOCKED mod-bff (`page.route()` answers the three writes and `/bff/mfa/challenge` with the documented wire shapes). The signal pauses the write. A satisfied challenge re-issues the identical request once. Declining says nothing was applied. A dark MFA surface is reported, not retried. A bare 403 never opens the challenge. Two `@fixme` rows pin the open box on hugmesh-mod-ui#1: load login-ui's federated challenge, and degrade to a `returnTo` link when that load fails |
| A11Y | `features/a11y/accessibility.feature` | Skip-link moves focus to `#main`; named landmarks; **focusable aria-disabled** admin-only controls that announce their reason; labelled forms; assertive error regions; focus restore |

The Matrix row needs a note. Since decision 51, mod-bff answers a Matrix **user** block with
`external: domain-locked` (a reversible domain-lock) and a Matrix **instance** block with
`requested:no-tuwunel-verb` (`BlockOutcome.java`, `ModService.java:516-520` in
`hugmesh-mod-bff-api`). The step `the response reports the Matrix block leg as stubbed and pending`
(`features/steps/session-steps.ts:215-223`) still expects `stubbed`, so that scenario fails against
a current live mod-bff until the step is updated.

Cross-user waits are `expect.poll` helpers in `tests/helpers/waits.ts`, never a bare
`waitForTimeout`. Every mod-bff write is an async **202 pending-reconcile**, so the target-side
check polls the target's OWN oracle, with an explicit budget:

- the ROLE_MATRIX-gated hsproxy `whoami` status;
- the `GET /bff/session` server-truth `roles[]` (domain-lock markers);
- or the re-applied moderation-queue filter.

Consequence scenarios start by resetting the target to the un-acted state through the same real
controls and PROVING that state, so the gated state is a real transition and retries stay green.
Queue chains create their row with a per-scenario unique target, and the other persona asserts
exactly that row.

Session priming comes in two kinds. `has a seeded session` writes `hug.session` into localStorage
only. It mints **no** HttpOnly `bff_` cookie (only the real login flow does, through the gateway),
so it primes only client-side assertions: modGuard ALLOW/DENY redirects, disabled + helptext
rendering, required-field validation. Any scenario whose steps touch `/bff/*` uses `is logged in`
(or `is logged in in their own context` for the per-persona cross-user contexts). That covers
console writes and their accepted notes, the honest-envelope POSTs, the `GET /bff/session` reads,
hsproxy `whoami` probes and queue reloads. A seeded session would fire every one of those requests
anonymously and get 401. The one exception is `mfa-step-up-mocked.feature`: it uses a seeded
session because `page.route()` answers its `/bff/*` calls, so no cookie is needed.

## Ships dark (wave 2b)

Every scenario that needs a live stack (host shell serving the remote, mod-bff, Casdoor seed) is
tagged **`@cluster`** at feature level. The default config filters them out
(`tags: 'not @cluster'`), so the default run needs **no cluster**, and the GitLab `e2e:bdd` job is
`allow_failure: true`.

The tag is `@cluster` and not playwright-bdd's reserved `@skip` on purpose. `@skip` drops a
scenario from generation (`bddgen` emits 0 specs for it), so a `@skip` suite cannot be
*discovered*. `@cluster` is a plain filter tag: the no-filter validation below generates and lists
every scenario, which proves the Gherkin compiles, while the default config keeps them dark.

## Offline validation (no cluster)

Run from `e2e/`. This finds all 13 feature files and 88 scenarios.

```sh
npm install
npx bddgen            # default: 'not @cluster' → 0 specs (ships dark, intended)
                      # (`npx playwright test --list` then prints "No tests found")

# Prove every feature compiles + all scenarios are discovered (no filter):
cat > pw-validate.config.ts <<'EOF'
import { defineConfig, devices } from '@playwright/test';
import { defineBddConfig } from 'playwright-bdd';
const d = defineBddConfig({ features: 'features/**/*.feature',
  steps: ['features/steps/**/*.ts', 'features/support/**/*.ts'] });
export default defineConfig({ reporter: [['list']],
  use: { ignoreHTTPSErrors: true, screenshot: 'on', video: 'on' },
  projects: [{ name: 'bdd', testDir: d, use: { ...devices['Desktop Chrome'] } }] });
EOF
npx bddgen -c pw-validate.config.ts
npx playwright test --list -c pw-validate.config.ts
rm pw-validate.config.ts
```

## Running against a live stack (later wave)

Drop the `@cluster` tag from a feature (or run with an override config that omits the
`not @cluster` filter). Export `E2E_BASE_URL` (default `https://host.docker.internal:8443`) and the
per-role `E2E_*_PASSWORD` vars, then run `npm run bdd` (`bddgen && playwright test`).

The per-user `E2E_<ROLE>_PASSWORD` and shared `E2E_PASSWORD` vars are optional overrides. If they
are unset, `passwordFor()` in `tests/helpers/roles.ts` reads the run-state `.e2e-credentials` file
that hugmesh-generator's `make stack-seed` writes (`$E2E_CREDENTIALS_FILE`, or a
`.e2e-credentials` found by walking up from the working directory). There is no built-in literal
password. If nothing resolves, the suite throws and names `make stack-seed` instead of logging in
with a guessable default.

The findings **resolve** rows that run a real round-trip seed a held finding through
`POST /bff/mod/findings/test-seed`. mod-bff ships that endpoint dark (`app.test-seed.enabled`, env
`APP_TEST_SEED_ENABLED`, default false: every call is a `503`), so enable it in the e2e/dev
profile first.
