// Mirror baser/index.html's import map, using only the checked-in vendor code.
const root = new URL('../baser/', import.meta.url);
const aliases = {
    three: 'vendor/three/three.module.js',
    'three-bvh-csg': 'vendor/three-bvh-csg/index.module.js',
    'three-mesh-bvh': 'vendor/three-mesh-bvh/index.module.js'
};
export async function resolve(specifier, context, nextResolve) {
    const path = aliases[specifier] ?? (specifier.startsWith('three/addons/')
        ? `vendor/three/addons/${specifier.slice('three/addons/'.length)}` : null);
    if (path) return { url: new URL(path, root).href, shortCircuit: true };
    return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
    if (url.startsWith(root.href) && url.endsWith('.js')) {
        return nextLoad(url, { ...context, format: 'module' });
    }
    return nextLoad(url, context);
}
