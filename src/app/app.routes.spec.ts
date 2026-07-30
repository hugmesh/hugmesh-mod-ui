import { routes } from './app.routes';
import { MOD_ROUTES } from './mod.routes';

/**
 * The dev-shell routes (used only by `ng serve mod` standalone) must mount the
 * exact same MOD_ROUTES the host federates, so standalone behaviour matches the
 * federated behaviour.
 */
describe('app.routes (standalone dev shell)', () => {
  it('mounts the exposed MOD_ROUTES as children of the root path', () => {
    expect(routes.length).toBe(1);
    expect(routes[0].path).toBe('');
    expect(routes[0].children).toBe(MOD_ROUTES);
  });
});
