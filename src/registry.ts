/**
 * Composition helpers for the panel extension contract.
 *
 * These run at BUILD time in the host (`core-frontend`): the product's
 * config imports each extension's {@link ExtensionManifest}, and
 * {@link composeExtensions} resolves dependency order, catches conflicts, and
 * flattens the contributions into one {@link ComposedRegistry} the shell +
 * Astro integration consume. Pure + dependency-free so it is trivially unit
 * tested (see `__tests__/registry.test.ts`).
 */

import type { ComposedRegistry, ExtensionManifest, I18nStrings } from "./types.js";

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * Identity helper an extension's entry uses to export its manifest, e.g.
 * `export default defineExtension({ id: "time-tracker", ... })`. Validates
 * eagerly so a malformed manifest fails at the extension's own build/test,
 * not deep inside a product build. Throws on the first error.
 */
export function defineExtension(manifest: ExtensionManifest): ExtensionManifest {
  const errors = validateManifest(manifest);
  if (errors.length > 0) {
    throw new Error(
      `Invalid extension manifest "${manifest.id ?? "<no id>"}":\n  - ${errors.join("\n  - ")}`,
    );
  }
  return manifest;
}

/**
 * Structural validation of a single manifest. Returns a list of human-readable
 * problems (empty = valid). Kept separate from {@link defineExtension} so tests
 * and tooling can report all issues at once.
 */
export function validateManifest(manifest: ExtensionManifest): string[] {
  const errors: string[] = [];
  if (!manifest.id || !KEBAB.test(manifest.id)) {
    errors.push(`id must be kebab-case (got ${JSON.stringify(manifest.id)})`);
  }
  if (!manifest.name) errors.push("name is required");
  if (!manifest.version) errors.push("version is required");

  const dupWithin = (items: { id: string }[] | undefined, kind: string) => {
    if (!items) return;
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.id)) errors.push(`duplicate ${kind} id "${item.id}"`);
      seen.add(item.id);
    }
  };
  dupWithin(manifest.permissions, "permission");
  dupWithin(manifest.nav, "nav");
  dupWithin(manifest.widgets, "widget");
  dupWithin(manifest.settings, "settings");

  for (const route of manifest.routes ?? []) {
    if (!route.pattern?.startsWith("/")) {
      errors.push(`route pattern must start with "/" (got ${JSON.stringify(route.pattern)})`);
    }
    if (!route.entrypoint) errors.push(`route "${route.pattern}" is missing an entrypoint`);
  }
  return errors;
}

/**
 * Compose a set of extensions into one flattened registry for a product build.
 *
 * - Resolves load order by `dependsOn` (topological); throws on a missing
 *   dependency or a dependency cycle.
 * - Throws on a duplicate id **across** extensions for any contribution kind
 *   (permission / nav / widget / settings / route pattern) — the base's
 *   in-one-build model has no namespacing, so collisions are hard errors, the
 *   frontend twin of the Phinx "unique migration class name" rule.
 * - Merges i18n; on a key collision the later (dependency-wise) extension wins.
 * - Sorts nav / widgets / settings by `order` (default 100), stable within ties.
 *
 * @param manifests the enabled extensions, in any order.
 */
export function composeExtensions(manifests: ExtensionManifest[]): ComposedRegistry {
  const byId = new Map<string, ExtensionManifest>();
  for (const m of manifests) {
    if (byId.has(m.id)) throw new Error(`Duplicate extension id "${m.id}"`);
    byId.set(m.id, m);
  }

  const order = topoSort(manifests, byId);
  const ordered = order.map((id) => byId.get(id)!);

  const i18n: I18nStrings = { de: {}, en: {} };
  for (const ext of ordered) {
    Object.assign(i18n.de, ext.i18n?.de);
    Object.assign(i18n.en, ext.i18n?.en);
  }

  return {
    order,
    permissions: collect(ordered, "permission", (ext) => ext.permissions, (p) => p.id),
    nav: byOrder(collect(ordered, "nav", (ext) => ext.nav, (n) => n.id)),
    widgets: byOrder(collect(ordered, "widget", (ext) => ext.widgets, (w) => w.id)),
    settings: byOrder(collect(ordered, "settings", (ext) => ext.settings, (s) => s.id)),
    routes: collect(ordered, "route", (ext) => ext.routes, (r) => r.pattern),
    i18n,
  };
}

/**
 * Flatten one contribution kind across extensions in load order. There is no
 * namespacing, so the same key from two extensions is a hard error.
 */
function collect<T>(
  extensions: ExtensionManifest[],
  kind: string,
  items: (ext: ExtensionManifest) => T[] | undefined,
  key: (item: T) => string,
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const ext of extensions) {
    for (const item of items(ext) ?? []) {
      const id = key(item);
      if (seen.has(id)) {
        throw new Error(`Conflicting ${kind} id "${id}" (from extension "${ext.id}")`);
      }
      seen.add(id);
      out.push(item);
    }
  }
  return out;
}

const DEFAULT_ORDER = 100;

/** Sort by `order` (default 100); `Array.prototype.sort` is stable, so ties keep load order. */
function byOrder<T extends { order?: number }>(items: T[]): T[] {
  return items.sort((a, b) => (a.order ?? DEFAULT_ORDER) - (b.order ?? DEFAULT_ORDER));
}

/** Kahn-style topological sort by `dependsOn`; throws on missing dep / cycle. */
function topoSort(
  manifests: ExtensionManifest[],
  byId: Map<string, ExtensionManifest>,
): string[] {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const m of manifests) {
    indegree.set(m.id, indegree.get(m.id) ?? 0);
    for (const dep of m.dependsOn ?? []) {
      if (!byId.has(dep)) {
        throw new Error(`Extension "${m.id}" depends on "${dep}", which is not enabled`);
      }
      indegree.set(m.id, (indegree.get(m.id) ?? 0) + 1);
      dependents.set(dep, [...(dependents.get(dep) ?? []), m.id]);
    }
  }

  // Seed with dependency-free extensions in declaration order for determinism.
  const queue = manifests.filter((m) => (indegree.get(m.id) ?? 0) === 0).map((m) => m.id);
  const result: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    result.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) queue.push(dependent);
    }
  }

  if (result.length !== manifests.length) {
    const resolved = new Set(result);
    const cyclic = manifests.map((m) => m.id).filter((id) => !resolved.has(id));
    throw new Error(`Dependency cycle among extensions: ${cyclic.join(", ")}`);
  }
  return result;
}
