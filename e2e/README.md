# hugmesh-mod-ui — e2e (Playwright + playwright-bdd)

Gherkin-driven end-to-end harness for the mod-ui federated remote, copied from
the proven `hugmesh-games/e2e` pattern (`@playwright/test` +
`playwright-bdd`, single-worker serial, `screenshot:'on'`/`video:'on'`, HTML
reporter, the per-step PNG `AfterStep` hook in
`features/support/fixtures.ts`). Mirrors the merged wave-2b PRs admin-ui#39,
superadmin-appstore-ui#2, login-ui#19.

The mod-ui is the **moderation keystone**, whose load-bearing rule is that a
**MOD acts over USERs but is NOT a superset of ADMIN**: refer / recommend / ban
/ domain-lock / block are wired; DECIDE / role-grant / external-client have no
mod-bff endpoint and are rendered `aria-disabled` with a WHY-helptext. The suite
leads with the cross-user / DENY coverage that boundary demands:

| Class | Feature file | What it asserts |
| --- | --- | --- |
| USER-SITUATIONAL | `features/moderation/mod-surfaces.feature` | modGuard ALLOW (mod *or* admin, superadmin via the folded admin role) + DENY (plain user → /login, signed-out visitor bounce); the admin-only DECIDE / role-grant / external-client controls **disabled + helptext**; required-field validation alert; the API **honest-envelope** contract (ban/lift always 202 pending-reconcile; the /bff/mod/block Matrix leg stubbed **never OK**, the Mastodon leg pending/degraded never a fake OK) |
| USER-SITUATIONAL | `features/moderation/findings-panel.feature` | the system-findings panel's own modGuard ALLOW (mod *or* admin, per-tenant parallel ALLOW) + DENY floor (plain user / signed-out visitor → /login), backed by the mod-bff's own filter-chain role gate on `GET /bff/mod/findings` (mod ALLOW 200, plain-user 403, anonymous 401) |
| USER-SITUATIONAL | `features/moderation/findings-triage.feature` | the findings-panel VIEW (triage columns, closed disposition vocab, empty-queue message), FILTER (captured `GET /bff/mod/findings?status=` reload per disposition), and RESOLVE — both the id-independent 403/401 role gate and, via the `POST /bff/mod/findings/test-seed` fixture, a real victim-creates-first Confirm/Dismiss round-trip (outbound request, server-side status change, accessible outcome note) |
| MULTIUSER | `features/multiuser/mod-over-user.feature` | a mod acting over a user — recommend/refer (escalate to admin), ban (timed **TTL** + **permanent** + **lift**, matrix **and mastodon** platforms; the TTL semantics pinned on the **captured `/bff/mod/ban` request body** — `ttlSeconds` present = timed, omitted = permanent — because both variants render the same accepted note), domain-lock, server-wide block, and a **profile**-platform ban+lift; an **admin performing** the same writes (not just viewing); refer wired but decide disabled on the same row; the queue status filter and the audit-trail **"only my own actions"** toggle each pinned on their captured scoped-GET reload (`?status=` / `?mine=true`) |
| CROSS-USER | `features/cross-user/mod-isolation.feature` | mod DENIED on a privileged target (admin / another mod), on **self**, and **cross-tenant** (domain-A mod on domain-B); UI role=alert announcement + mod-bff 403/404 + anonymous 401 |
| CROSS-USER (consequences) | `features/cross-user/mod-consequences.feature` | the TARGET **observes** the mod's action in their own context at the shared front door: a matrix ban gates (and a lift restores) the target's hsproxy access + matrix UI identity; a mastodon domain-lock coerces (and an unlock re-enables) the target's composer federated-reach options; a matrix **domain-lock** marker on the target side (the form's default platform); a **timed ban TTL auto-restores** without a lift; a mod's **refer** arrives in an admin's queue view; a user's `recommend-instance-block` submission lands in the mod queue |
| CROSS-USER (decide) | `features/cross-user/admin-decide.feature` | the ADMIN approve/deny DECIDE round-trip this console actually wires (`data-approve`/`data-deny` → `AdminBffService.decide`): approve and deny each flip the ONE unique row and both the deciding admin and the **referring mod** observe the new status; the honest `mc-decide-error` failure surface (transport-500 injection leaves the row at `referred`, never fabricated); two-admin double-decide settling to exactly ONE server-authoritative terminal status |
| CROSS-USER (contention) | `features/cross-user/mod-refer-contention.feature` | after mod A refers a per-scenario unique row, a second SAME-tenant mod's reloaded queue shows that row `referred` with its refer control **disabled** — no double-refer |
| CROSS-USER (contention) | `features/cross-user/findings-contention.feature` | two same-tenant mods race ONE seeded held finding — A confirms (`actioned`), B's stale dismiss is **rejected** honestly, and a reload proves A's server-authoritative outcome stands |
| CROSS-USER (tenant) | `features/cross-user/findings-tenant-isolation.feature` | victim-creates-first: a domain-B mod (who PASSES the role gate) can neither SEE a REAL domain-A seeded finding in their own domain-scoped queue nor RESOLVE it (404) — the DOMAIN boundary, distinct from the plain-user 403 ROLE gate |
| CROSS-USER (audit) | `features/cross-user/audit-trail.feature` | "always locally audited" proven for real: a mod's block on a per-scenario unique target produces a visible `mc-audit` row, and a second SAME-tenant mod sees the SAME row with the SAME actor — a shared server record, not a per-browser echo |
| A11Y | `features/a11y/accessibility.feature` | skip-link → focus `#main`, named landmarks, **focusable aria-disabled** admin-only controls announcing their reason, labelled forms, assertive error regions, focus restore |

Cross-user waits are `expect.poll` helpers in `tests/helpers/waits.ts` (never a
bare `waitForTimeout`): every mod-bff write is an honest async **202
pending-reconcile**, so the target-side observation polls the target's OWN
oracle — the ROLE_MATRIX-gated hsproxy `whoami` status, the `GET /bff/session`
server-truth `roles[]` (domain-lock markers), or the re-applied moderation-queue
filter — with an explicit budget. Consequence scenarios open by resetting the
target to the un-acted state through the same real controls and PROVING the
pre-state, so the gated state is a genuine transition and retries stay green;
queue chains create their row with a per-scenario unique target and the other
persona asserts exactly that row.

Session priming comes in two honest flavours. `has a seeded session` writes
`hug.session` into localStorage only — it mints **no** HttpOnly `bff_` cookie
(only the real login flow does, via the gateway), so it primes exclusively the
client-side assertions: modGuard ALLOW/DENY redirects, disabled+helptext
rendering, required-field validation. Any scenario whose steps touch `/bff/*` —
console writes and their accepted notes, the honest-envelope POSTs, the
`GET /bff/session` server-truth reads, hsproxy `whoami` probes, queue reloads —
uses `is logged in` (or `is logged in in their own context` for the per-persona
cross-user contexts), because a seeded session would fire every one of those
requests anonymously and 401.

## Ships dark (wave 2b)

Every scenario that needs a live stack (host shell serving the remote + mod-bff
+ Casdoor seed) is tagged **`@cluster`** at the feature level. The default
config filters them out (`tags: 'not @cluster'`), so the default run needs **no
cluster** and the GitLab `e2e:bdd` job is `allow_failure: true`.

`@cluster` is used deliberately instead of playwright-bdd's reserved `@skip`:
`@skip` drops a scenario from generation entirely (`bddgen` emits 0 specs for
it), so a `@skip`-tagged suite cannot be *discovered*. `@cluster` is a plain
filter tag — the no-filter validation below generates and lists every scenario,
proving the Gherkin compiles, while the default config keeps them dark.

## Offline validation (no cluster)

```sh
npm install
npx bddgen            # default: 'not @cluster' → 0 specs (ships dark, intended)

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

Drop the `@cluster` tag from a feature (or run with an override config that
omits the `not @cluster` filter), export `E2E_BASE_URL` + the per-role
`E2E_*_PASSWORD` vars, then `npm run bdd`.
