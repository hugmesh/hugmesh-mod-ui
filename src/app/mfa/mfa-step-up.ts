import { InjectionToken, OutputEmitterRef, Type } from '@angular/core';

/**
 * Where the platform's one MFA step-up dialog comes from (hugmesh-mod-ui#1).
 *
 * hugmesh-login-ui exposes `./mfa-step-up` over native federation (login-ui#24);
 * this remote loads it ON DEMAND, when a step-up refusal needs it, never at
 * bootstrap (loading the module constructs login-ui's own SessionService, which
 * opens a BroadcastChannel and window listeners).
 *
 * DECISION 35 (hugmesh-generator#347, operator 2026-09-17): the remoteEntry URL
 * is HARDCODED, here, as one constant, and a failure to load degrades to the
 * `?returnTo=` link. It is deliberately not configurable and not discovered: no
 * `window.__HUG_*`, no manifest fetch, no BFF endpoint. It is a second copy of
 * the `login` row of hugmesh-host-shell's `federation.manifest.prod.json`; that
 * repo pins its own copy with a spec (host-shell#82), and `mfa-step-up.spec.ts`
 * pins this one. The same module, with the same shape, ships in
 * hugmesh-wiki-ui (`src/app/mfa-step-up.ts`) so the consumers behave identically.
 *
 * Two consequences worth knowing, neither a bug:
 * <ul>
 *   <li>Under `ng serve` the dev manifest serves `login` at
 *       `http://localhost:4203/remoteEntry.json`, so this path does not resolve
 *       and the link is what the developer sees.</li>
 *   <li>A `federation_modules` row in federation-api outranks the shell's file at
 *       runtime, so an operator can move `login` without touching a repo. The
 *       dialog then disappears and the link takes over, with no error.</li>
 * </ul>
 */
export const LOGIN_REMOTE_ENTRY = '/login/remoteEntry.json';

/** The remoteEntry / remoteName / exposedModule triple the canonical recipe
 *  (hugmesh-forum-ui#3) names. Consumed here by {@link createFederatedLoader},
 *  NOT by the package's `loadRemoteModule` — see "HOW THE MODULE IS LOADED"
 *  below for the measurement behind that. The shell parks every remote
 *  (`EAGER_REMOTES = []`), so `login` is never registered until something fetches
 *  this entry on demand. */
export const LOGIN_STEP_UP_OPTIONS = {
  remoteEntry: LOGIN_REMOTE_ENTRY,
  remoteName: 'login',
  exposedModule: './mfa-step-up',
} as const;

/** The platform's step-up challenge page, mounted by the host at `/login`. An
 *  ABSOLUTE host path on purpose (it is the login remote's surface, not a path
 *  inside this one). It navigates back to `returnTo` once the session is stamped. */
export const MFA_CHALLENGE_ROUTE = '/login/mfa/challenge';

/** The `?returnTo=` link: the decided, permanent fallback.
 *
 *  @param returnTo - The in-app URL to come back to (the router's current URL). */
export function mfaChallengeHref(returnTo: string): string {
  return `${MFA_CHALLENGE_ROUTE}?returnTo=${encodeURIComponent(returnTo)}`;
}

/** The slice of login-ui's `MfaChallengeComponent` this remote touches. Typed
 *  here by hand: login-ui is a federated remote, not a dependency. All three
 *  outputs are Angular `output()` refs. */
export interface LoginMfaStepUpComponent {
  readonly satisfied: OutputEmitterRef<void>;
  readonly dismissed: OutputEmitterRef<void>;
  readonly unavailable: OutputEmitterRef<void>;
}

/** What `./mfa-step-up` exposes that this remote uses. */
export interface LoginStepUpModule {
  /** Awaits login-ui's translation catalog, then returns the component class. */
  loadMfaStepUpComponent(): Promise<Type<LoginMfaStepUpComponent>>;
}

/** The loader signature, so a spec can supply a fake one. */
export type LoginStepUpLoader = () => Promise<LoginStepUpModule>;

/** The seam over the federation runtime; an ESM named export cannot be spied on. */
export function createLoginStepUpLoader(
  load: (options: typeof LOGIN_STEP_UP_OPTIONS) => Promise<LoginStepUpModule>,
): LoginStepUpLoader {
  return () => load(LOGIN_STEP_UP_OPTIONS);
}

/**
 * HOW THE MODULE IS LOADED — and why not `loadRemoteModule`.
 *
 * The canonical consumer recipe (hugmesh-forum-ui#3, decision 35) says
 * `loadRemoteModule({ remoteEntry, remoteName, exposedModule })`. MEASURED
 * 2026-11-04 under the host shell (host-shell on native-federation 22.2.4, this
 * remote on 22.0.1): that call HANGS silently from inside a remote — no request
 * for the remoteEntry, no rejection, no fallback. The package's top-level helper
 * awaits a MODULE-SCOPED `federationPromise` that only its own copy's
 * `initFederation()` resolves; the runtime is on native-federation's own skip
 * list, so every remote bundles its own copy, and under the shell this remote's
 * `main.ts` (the only caller of its `initFederation`) never runs. The package's
 * typings deprecate the helper for exactly this ("relies on a module-scoped
 * federation instance ... brittle in multi-host setups").
 *
 * Calling this copy's own `initFederation({})` lazily was tried next and
 * crashes: the orchestrator keeps its state in `globalThis.__NATIVE_FEDERATION__`,
 * and the shell's orchestrator (4.9.0) writes a storage schema this remote's
 * copy (4.3.0) cannot read (`TypeError ... reading 'startsWith'` in its
 * import-map step: it expects `version.file`, the shell wrote `remotes[].entries`).
 * Matching the shell's version would mean a build-toolchain upgrade here and
 * would re-open on the shell's next bump.
 *
 * So the dialog is loaded through what the shell has ALREADY committed: the
 * es-module-shims loader it installs (shim mode) and its import map, in which
 * every singleton this remote and login-ui share (Angular, RxJS) is mapped to
 * the shell's copy. This function fetches {@link LOGIN_REMOTE_ENTRY}, checks the
 * manifest really is the `login` remote and exposes the module, adds ONE
 * `/login/`-scoped import map for the specifiers the shell's map lacks (in
 * practice login-ui's own `@nf-internal/chunk-*` rows), and imports the exposed
 * file. Measured: `@angular/core` then resolves to the same shell chunk from the
 * login scope as from the host, so login-ui's component renders with the
 * shell's Angular, not a second one.
 *
 * What is deliberately NOT done here: `requiredVersion` is not re-negotiated.
 * A globally mapped singleton always resolves to the shell's copy. If the
 * shell's Angular did not satisfy login-ui's range, the shell's own `/login`
 * mount would already be broken — that is the shell's invariant, not this
 * consumer's.
 *
 * Any failure — no shim (the standalone dev shell, Karma), a non-OK or
 * malformed manifest, a name or expose mismatch, a failed import — rejects, and
 * {@code mod-step-up.component.ts} degrades to the `?returnTo=` link. The
 * module promise is memoised per page so the scoped map is added once; a
 * rejected attempt is forgotten so the next refusal tries again.
 */

/** The native-federation manifest fields this loader reads. */
export interface RemoteEntryManifest {
  readonly name?: string;
  readonly exposes?: ReadonlyArray<{ readonly key: string; readonly outFileName: string }>;
  readonly shared?: ReadonlyArray<{ readonly packageName: string; readonly outFileName: string }>;
}

export interface ImportMapLike {
  imports?: Record<string, string>;
  scopes?: Record<string, Record<string, string>>;
}

/** The slice of es-module-shims' `importShim` this loader uses (v2 API). */
export interface ModuleShim {
  (url: string): Promise<unknown>;
  getImportMap(): ImportMapLike;
  addImportMap(map: ImportMapLike): void;
}

/** Seams, each with its real default, so a spec can drive the loader without a network. */
export interface FederatedLoaderDeps {
  readonly fetchImpl?: typeof fetch;
  /** The shim the shell installed, or undefined where there is none. */
  readonly shim?: () => ModuleShim | undefined;
  /** The page origin the root-relative remoteEntry resolves against. */
  readonly origin?: () => string;
}

function defaultShim(): ModuleShim | undefined {
  return (globalThis as { importShim?: ModuleShim }).importShim;
}

/** Build the loader over the shell's es-module-shims import map. Exported for its spec. */
export function createFederatedLoader(deps: FederatedLoaderDeps = {}): LoginStepUpLoader {
  const fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const shim = deps.shim ?? defaultShim;
  const origin = deps.origin ?? (() => globalThis.location.origin);
  let pending: Promise<LoginStepUpModule> | undefined;

  async function load(options: typeof LOGIN_STEP_UP_OPTIONS): Promise<LoginStepUpModule> {
    const importShim = shim();
    if (typeof importShim !== 'function') {
      throw new Error('no es-module-shims loader on this page (not under the host shell)');
    }
    const res = await fetchImpl(options.remoteEntry, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${options.remoteEntry}: HTTP ${res.status}`);
    const entry = (await res.json()) as RemoteEntryManifest;
    if (entry.name !== options.remoteName) {
      throw new Error(`${options.remoteEntry} declares remote '${entry.name}', expected '${options.remoteName}'`);
    }
    const exposed = entry.exposes?.find((e) => e.key === options.exposedModule);
    if (!exposed) throw new Error(`remote '${options.remoteName}' does not expose ${options.exposedModule}`);

    const entryUrl = new URL(options.remoteEntry, origin()).href;
    const scope = entryUrl.slice(0, entryUrl.lastIndexOf('/') + 1);
    const mapped = importShim.getImportMap().imports ?? {};
    const scoped: Record<string, string> = {};
    for (const s of entry.shared ?? []) {
      if (!(s.packageName in mapped)) scoped[s.packageName] = scope + s.outFileName;
    }
    if (Object.keys(scoped).length > 0) importShim.addImportMap({ imports: {}, scopes: { [scope]: scoped } });

    return (await importShim(scope + exposed.outFileName)) as LoginStepUpModule;
  }

  return createLoginStepUpLoader((options) => {
    pending ??= load(options).catch((e: unknown) => {
      pending = undefined;
      throw e;
    });
    return pending;
  });
}

export const LOGIN_STEP_UP_LOADER = new InjectionToken<LoginStepUpLoader>('LOGIN_STEP_UP_LOADER', {
  providedIn: 'root',
  factory: () => createFederatedLoader(),
});
