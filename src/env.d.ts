/** package.json's version, as build.mjs puts it in: 0.1.0, or 0.1.0+1a2b3c4 off a release. */
declare const __APP_VERSION__: string;
/** src/plugin-runtime/runtime.ts, bundled: the code every plugin worker starts with. */
declare const __WORKER_RUNTIME__: string;
/** plugins/builtin/<id>/index.ts, each bundled into an ES module. */
declare const __BUILTIN_PLUGINS__: { id: string; code: string }[];
/**
 * A distribution (build.mjs): the studio built as one application — its
 * starter templates only, the designer hidden until asked for. null in bap.html.
 */
declare const __DISTRIBUTION__: { id: string; templates: string[] } | null;
