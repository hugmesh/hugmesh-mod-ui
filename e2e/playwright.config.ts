import { defineConfig, devices } from '@playwright/test';
import { defineBddConfig } from 'playwright-bdd';

// Copied from the proven hugmesh.games/e2e pattern. The mod-ui is a
// native-federation REMOTE mounted by the hugmesh.net host at /mod, so
// the e2e baseURL points at the host front door (the federated remote is not
// browsable in isolation in a real stack). Override with E2E_BASE_URL.
const baseURL = process.env.E2E_BASE_URL ?? 'https://host.docker.internal:8443';

// playwright-bdd compiles every .feature under features/ into a generated
// .spec.js (under .features-gen/), discovers them via `testDir`, and wires the
// World fixture from features/support/fixtures.ts. Step definitions live under
// features/steps/ and the hooks/World are imported once per worker via the
// `steps` glob (support/ is included so fixtures.ts — which registers the
// AfterStep screenshot hook — loads).
const bddTestDir = defineBddConfig({
  features: 'features/**/*.feature',
  steps: [
    'features/steps/**/*.ts',
    'features/support/**/*.ts',
  ],
  // Cucumber tag-expression filter. WAVE 2b ships DARK: every scenario that
  // needs a live stack (host shell + mod-bff + Casdoor seed) is tagged
  // `@cluster` at the feature level, and this filter EXCLUDES them — so the
  // DEFAULT run requires no cluster (it generates an empty-but-valid runnable
  // set today). Re-enable a feature by dropping its `@cluster` tag once the
  // env-test-build wiring lands (a later wave).
  //
  // Why `@cluster`, not playwright-bdd's reserved `@skip`: `@skip` removes a
  // scenario from GENERATION entirely (bddgen emits 0 specs for it), so a
  // skip-tagged suite can't be DISCOVERED — `playwright test --list` would
  // return 0 and we couldn't prove the Gherkin compiles. `@cluster` is a plain
  // filter tag: a no-filter `bddgen` + `playwright test --list` (see the
  // README / PR validation) generates + lists every scenario, proving they
  // parse, while this default config keeps them dark.
  tags: 'not @cluster',
});

export default defineConfig({
  // Single-worker. Two workers cause flaky failures: per-role login through
  // Casdoor + native-federation manifest fetches contend on a small dev stack
  // and `waitForURL` after the login click stalls intermittently. Serial
  // execution keeps the cross-user / DENY authz matrix reliable.
  fullyParallel: false,
  workers: 1,
  // One retry catches the rare login-page flake without papering over real
  // regressions — a deterministic authz bug fails twice in a row.
  retries: 1,
  timeout: 180_000,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'results/html', open: 'never' }],
  ],
  outputDir: 'results/artifacts',
  use: {
    baseURL,
    // The whole point — accept the self-signed cert without rejecting.
    ignoreHTTPSErrors: true,
    // Trace + video retention is forced ON for every run so the e2e artefact
    // harvest always has a per-step PNG + a full webm to fall back on. The
    // per-step PNG hook in features/support/fixtures.ts gives granular shots;
    // the video covers everything between steps (federation init, route
    // transitions) so a reviewer can scrub the whole scenario timeline.
    trace: 'retain-on-failure',
    screenshot: 'on',
    video: 'on',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      // BDD project — generated specs from .feature files plus their step
      // definitions. Only meaningful after `npx bddgen` has run
      // (`npm run bdd` / `npm run bdd:gen`).
      name: 'bdd',
      testDir: bddTestDir,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
