/**
 * How Forge says "not yet".
 *
 * Design §4 is explicit: an unimplemented API **throws** and reports itself,
 * it never returns `undefined`. A silent stub turns one missing method into
 * a `TypeError` three layers below, in extension code we cannot debug; a
 * typed throw names the API, the extension and the milestone that owns it.
 *
 * Every access is also reported through `diagnostics.unsupportedApi`, which
 * is what turns the compatibility report into measured usage instead of
 * guesswork (design §10).
 */

export class UnsupportedApiError extends Error {
  readonly api: string;
  readonly extensionId: string;

  constructor(api: string, extensionId: string) {
    super(
      `"vscode.${api}" todavía no está implementado en Forge `
      + `(solicitado por "${extensionId}").`,
    );
    this.name = 'UnsupportedApiError';
    this.api = api;
    this.extensionId = extensionId;
  }
}

export type UnsupportedApiReporter = (api: string, extensionId: string) => void;

/** Members that must answer without throwing: the JS runtime and every
 *  `console.log`/`util.inspect` of an extension touch them long before any
 *  real call, and throwing there would misreport an inspection as usage. */
const INTROSPECTION_KEYS = new Set<PropertyKey>([
  Symbol.toPrimitive,
  Symbol.toStringTag,
  Symbol.iterator,
  Symbol.asyncIterator,
  'then',
  'inspect',
  'constructor',
  'nodeType',
  '$$typeof',
  Symbol.for('nodejs.util.inspect.custom'),
]);

/**
 * A namespace whose every member throws `UnsupportedApiError` when *used*.
 *
 * Members are reported lazily on access because that is the only moment we
 * control: `const { registerCommand } = vscode.commands` must fail at the
 * call, not at the destructuring, or a guarded `typeof x === 'function'`
 * feature check would explode.
 */
export function createUnsupportedNamespace(
  namespace: string,
  extensionId: string,
  report: UnsupportedApiReporter,
  /** Members that *are* implemented and shadow the throwing default. */
  implemented: Record<string, unknown> = {},
): Record<string, unknown> {
  // Workspace/editor state is exposed through getters. Spreading would
  // evaluate them at activation and freeze textDocuments/focus forever.
  const target: Record<string, unknown> = Object.defineProperties(
    {}, Object.getOwnPropertyDescriptors(implemented),
  );

  return new Proxy(target, {
    get(base, property, receiver) {
      if (property in base) return Reflect.get(base, property, receiver);
      if (INTROSPECTION_KEYS.has(property) || typeof property === 'symbol') return undefined;

      const api = `${namespace}.${String(property)}`;
      // A function, so feature detection (`typeof api.foo === 'function'`)
      // still sees what VS Code would expose; calling it is what fails.
      const stub = (): never => {
        report(api, extensionId);
        throw new UnsupportedApiError(api, extensionId);
      };
      Object.defineProperty(stub, 'name', { value: String(property) });
      return stub;
    },
    set(base, property, value, receiver) {
      // Extensions do patch namespaces (polyfills, test shims). Allowing the
      // write keeps them working; refusing it would break them for no gain.
      return Reflect.set(base, property, value, receiver);
    },
    has(base, property) {
      return property in base || typeof property === 'string';
    },
  });
}
