import { TestBed } from '@angular/core/testing';

import {
  ImportMapLike,
  LOGIN_REMOTE_ENTRY,
  LOGIN_STEP_UP_LOADER,
  LOGIN_STEP_UP_OPTIONS,
  LoginStepUpModule,
  MFA_CHALLENGE_ROUTE,
  ModuleShim,
  RemoteEntryManifest,
  createFederatedLoader,
  createLoginStepUpLoader,
  mfaChallengeHref,
} from './mfa-step-up';

describe('the login-ui step-up remote (decision 35: hardcoded, degraded on failure)', () => {
  it('pins the remoteEntry to the shell manifest row for `login`', () => {
    // hugmesh-host-shell src/assets/federation.manifest.prod.json: "login": "/login/remoteEntry.json".
    // A move there makes the dialog vanish silently (the link takes over), so this fails loudly instead.
    expect(LOGIN_REMOTE_ENTRY).toBe('/login/remoteEntry.json');
  });

  it("loads through the OBJECT overload with login-ui's declared remote name and exposed module", () => {
    expect(LOGIN_STEP_UP_OPTIONS).toEqual({
      remoteEntry: '/login/remoteEntry.json',
      remoteName: 'login',
      exposedModule: './mfa-step-up',
    });
  });

  it('the loader passes exactly those options, once per call, and only when called', async () => {
    const mod = {} as LoginStepUpModule;
    const calls: unknown[] = [];
    const loader = createLoginStepUpLoader(async (options) => {
      calls.push(options);
      return mod;
    });
    expect(calls.length).toBe(0);
    expect(await loader()).toBe(mod);
    expect(calls).toEqual([LOGIN_STEP_UP_OPTIONS]);
  });

  it('is provided by default (the real federation call is only reached when invoked)', () => {
    expect(typeof TestBed.inject(LOGIN_STEP_UP_LOADER)).toBe('function');
  });

  it('builds the decided fallback link: the challenge route with the encoded returnTo', () => {
    expect(MFA_CHALLENGE_ROUTE).toBe('/login/mfa/challenge');
    expect(mfaChallengeHref('/mod/console?x=1&y=2#top')).toBe(
      '/login/mfa/challenge?returnTo=%2Fmod%2Fconsole%3Fx%3D1%26y%3D2%23top',
    );
  });
});

/**
 * The loader over the shell's es-module-shims import map — the mechanism that
 * replaces `loadRemoteModule`, which hangs from inside a remote (see the module
 * doc). Everything the browser would do is a seam here: fetch, the shim, origin.
 */
describe('createFederatedLoader (login-ui over the shell\'s import map)', () => {
  const ORIGIN = 'https://mesh.example';
  /** The shape login-ui's build emits: name, exposes, shared (packages + chunks). */
  const MANIFEST: RemoteEntryManifest = {
    name: 'login',
    exposes: [
      { key: './routes', outFileName: 'routes-AAAA.js' },
      { key: './mfa-step-up', outFileName: 'mfa-step-up-BBBB.js' },
    ],
    shared: [
      { packageName: '@angular/core', outFileName: '_angular_core.login.js' },
      { packageName: 'rxjs', outFileName: 'rxjs.login.js' },
      { packageName: '@nf-internal/chunk-X', outFileName: 'chunk-X.js' },
    ],
  };
  const MODULE = { loadMfaStepUpComponent: () => Promise.reject(new Error('unused')) } as LoginStepUpModule;

  let fetched: Array<{ url: string; init?: RequestInit }>;
  let imported: string[];
  let added: ImportMapLike[];
  let manifest: unknown;
  let status: number;
  let shimPresent: boolean;
  let importFails: boolean;

  function fakeFetch(url: string, init?: RequestInit): Promise<Response> {
    fetched.push({ url, init });
    return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(manifest) } as Response);
  }

  function fakeShim(): ModuleShim | undefined {
    if (!shimPresent) return undefined;
    const shim = ((url: string) => {
      imported.push(url);
      return importFails ? Promise.reject(new Error('chunk 404')) : Promise.resolve(MODULE);
    }) as ModuleShim;
    // The shell's map: Angular and RxJS already mapped to ITS chunks.
    shim.getImportMap = () => ({
      imports: { '@angular/core': `${ORIGIN}/_angular_core.shell.js`, rxjs: `${ORIGIN}/rxjs.shell.js` },
      scopes: {},
    });
    shim.addImportMap = (map) => {
      added.push(map);
    };
    return shim;
  }

  function loader() {
    return createFederatedLoader({ fetchImpl: fakeFetch as typeof fetch, shim: fakeShim, origin: () => ORIGIN });
  }

  beforeEach(() => {
    fetched = [];
    imported = [];
    added = [];
    manifest = MANIFEST;
    status = 200;
    shimPresent = true;
    importFails = false;
  });

  it('fetches exactly the hardcoded remoteEntry, scopes only what the shell has not mapped, and imports the exposed file', async () => {
    expect(await loader()()).toBe(MODULE);
    expect(fetched.map((f) => f.url)).toEqual([LOGIN_REMOTE_ENTRY]);
    // One scoped map, under the remote's directory, carrying ONLY the specifiers
    // the shell's map lacks: the singletons stay the shell's copies.
    expect(added).toEqual([{ imports: {}, scopes: { [`${ORIGIN}/login/`]: { '@nf-internal/chunk-X': `${ORIGIN}/login/chunk-X.js` } } }]);
    expect(imported).toEqual([`${ORIGIN}/login/mfa-step-up-BBBB.js`]);
  });

  it('adds no map at all when the shell already maps everything the remote shares', async () => {
    manifest = { ...MANIFEST, shared: MANIFEST.shared!.slice(0, 2) };
    await loader()();
    expect(added).toEqual([]);
  });

  it('memoises the module per page: a second refusal neither re-fetches nor re-maps', async () => {
    const l = loader();
    expect(await l()).toBe(MODULE);
    expect(await l()).toBe(MODULE);
    expect(fetched.length).toBe(1);
    expect(added.length).toBe(1);
    expect(imported.length).toBe(1);
  });

  it('rejects without a shim (the standalone dev shell, Karma): the console degrades to the link', async () => {
    shimPresent = false;
    await expectAsync(loader()()).toBeRejectedWithError(/es-module-shims/);
    expect(fetched).toEqual([]);
  });

  it('rejects on a non-OK manifest (a moved `login` row: decision 35\'s accepted cost)', async () => {
    status = 404;
    await expectAsync(loader()()).toBeRejectedWithError(/HTTP 404/);
    expect(added).toEqual([]);
    expect(imported).toEqual([]);
  });

  it('rejects when the manifest is not the `login` remote, instead of importing a stranger\'s module', async () => {
    manifest = { ...MANIFEST, name: 'forum' };
    await expectAsync(loader()()).toBeRejectedWithError(/declares remote 'forum', expected 'login'/);
    expect(imported).toEqual([]);
  });

  it('rejects when the remote no longer exposes ./mfa-step-up', async () => {
    manifest = { ...MANIFEST, exposes: MANIFEST.exposes!.slice(0, 1) };
    await expectAsync(loader()()).toBeRejectedWithError(/does not expose \.\/mfa-step-up/);
    expect(imported).toEqual([]);
  });

  it('forgets a rejected attempt, so the next refusal tries again rather than inheriting a dead promise', async () => {
    const l = loader();
    importFails = true;
    await expectAsync(l()).toBeRejectedWithError(/chunk 404/);
    importFails = false;
    expect(await l()).toBe(MODULE);
    expect(fetched.length).toBe(2);
    expect(imported.length).toBe(2);
  });

  it('passes the options the spec above pins, through the same seam the token uses', async () => {
    await loader()();
    expect(fetched[0].url).toBe(LOGIN_STEP_UP_OPTIONS.remoteEntry);
    expect(imported[0]).toContain('/login/');
  });
});
