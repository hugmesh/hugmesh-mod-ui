import { MOD_ROUTES } from './mod.routes';
import { ModHomeComponent } from './mod-home.component';
import { ModerationConsoleComponent } from './moderation-console.component';
import { FindingsPanelComponent } from './findings-panel.component';

/**
 * These specs lock down the federation contract: `./routes` (exposed under the
 * remote name "mod") is the single module the hugmesh.net host mounts at
 * /mod. The host depends on these exact paths and components, so a regression
 * here would silently break the host's moderator console.
 */
describe('MOD_ROUTES (exposed ./routes federation contract)', () => {
  const byPath = (path: string) => MOD_ROUTES.find((r) => r.path === path);

  it('exposes the moderator home at the empty path (default mount point)', () => {
    const root = byPath('');
    expect(root).toBeDefined();
    expect(root!.component).toBe(ModHomeComponent);
  });

  it('wires the console route to the ModerationConsoleComponent', () => {
    expect(byPath('console')!.component).toBe(ModerationConsoleComponent);
  });

  it('wires the findings route to the FindingsPanelComponent', () => {
    expect(byPath('findings')!.component).toBe(FindingsPanelComponent);
  });

  it('exposes exactly the three moderator views the host expects', () => {
    expect(MOD_ROUTES.map((r) => r.path)).toEqual(['', 'console', 'findings']);
  });

  it('declares every route with either a component or children (no dead routes)', () => {
    for (const route of MOD_ROUTES) {
      expect(route.component || route.children).withContext(`route ${route.path}`).toBeTruthy();
    }
  });

  it('contains no duplicate paths', () => {
    const paths = MOD_ROUTES.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
