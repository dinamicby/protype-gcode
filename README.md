# protype-gcode

Canonical G-code parser and `pcode` decoder shared across the Protype apps
(ProControlTauri today; ProtypeHubTauri and ProtypeHubNative are intended
future adopters — see the design doc referenced below).

## What this is

A dependency-free data layer: parse G-code text or decode a `pcode` artifact
into one typed-array shape, in memory, with no rendering attached. See
`SPEC.md` in this package for the normative `pcode` format specification.

## What this deliberately excludes

**No React. No three.js. No viewer.** This is a hard constraint, not a
style preference: `ProtypeHubNative` (React Native) cannot run this parser
as a normal JS dependency — Hermes strips function bodies from anything it
doesn't compile itself, so RN's existing G-code parser is stored as a
*string* and injected into a WebView, which then executes it as a
self-contained script. Any dependency on React, DOM, or a rendering
library would make the package impossible to inject that way and would
block that adopter permanently. Keep this package's dependency graph at
zero runtime dependencies.

Viewers, scene graphs, and anything that turns points into pixels live in
the consuming app, not here.

## Adopting this package

1. Add the submodule at `vendor/protype-gcode`, the same way
   `protype-printer-sdk` and `protype-ui` are already wired in
   ProControlTauri:

   ```sh
   git submodule add https://github.com/dinamicby/protype-gcode.git vendor/protype-gcode
   ```

2. Add a `vendor/*` (or equivalent) entry to the consumer's
   `pnpm-workspace.yaml` so pnpm links it as a workspace package, and add
   `"protype-gcode": "workspace:*"` to the consuming app's
   `package.json` dependencies.

3. Add a bundler alias so `import ... from "protype-gcode"` resolves to
   this package's `src/`, matching how `apps/procontrol/vite.config.ts`
   and `apps/procontrol/vitest.config.ts` in ProControlTauri do it:

   ```ts
   resolve: {
     alias: {
       "protype-gcode": path.resolve(__dirname, "../../vendor/protype-gcode/src"),
     },
   },
   ```

   Configure the same alias for `vitest.config.ts` (or your test
   runner's module resolution) if the consumer's tests import this
   package directly — otherwise tests resolve a different module graph
   than the app does.

## Public surface

- `parseGcode(text: string): ParsedGcodeArrays` — the canonical parser.
  Struct-of-arrays, one entry per move endpoint: `xs`/`ys`/`zs`
  (`Float32Array`), `layer` (`Uint32Array`), `featureType`/`tool`/`isTravel`
  (`Uint8Array`), `feedrate`/`width`/`height` (`Float32Array`), plus
  `count`, `layers`, and `bounds`. See `src/types.ts` for the full shape
  and its precision notes.
- `toLines(arrays: ParsedGcodeArrays): ParsedGcode` — adapts the array
  shape into the legacy `{ lines: GcodeLine[], layers, bounds }` object
  shape, for viewers that predate the typed-array layout. Allocates one
  object per point; a renderer that can read the arrays directly should
  do that instead.
- `decodePcode(input: ArrayBuffer | ArrayBufferView): ParsedGcodeArrays` —
  decodes the lightweight `pcode` v1 artifact (produced by
  `procontrol-core`'s preview worker for remote clients) into the same
  canonical shape `parseGcode` produces. Throws `PcodeDecodeError` on any
  malformed or hostile input rather than returning partial data.
- `FEATURE_UNKNOWN`, `FEATURE_OUTER_WALL`, `FEATURE_INNER_WALL`,
  `FEATURE_INFILL`, `FEATURE_SOLID_INFILL`, `FEATURE_TOP_SURFACE`,
  `FEATURE_BOTTOM_SURFACE`, `FEATURE_SUPPORT`, `FEATURE_BRIDGE`,
  `FEATURE_SKIRT_BRIM`, `FEATURE_SEAM_START` — feature-type discriminants.
  These are a wire contract with the `pcode` format and with
  `procontrol-core`'s Rust mirror in `services/procontrol-core/src/preview/
  model.rs`. Never renumber them.
- The two output shapes: `ParsedGcodeArrays` (struct-of-arrays, what
  `parseGcode`/`decodePcode` return) and `ParsedGcode`/`GcodeLine` (array-
  of-structs, what `toLines` returns for legacy viewers). See
  `src/types.ts`.

`layers` is **not** a layer index. `layers.length` does not always equal
the number of distinct `layer` values a point can carry, and
`layers[somePoint.layer]` is not a valid lookup — the two are populated by
independent bookkeeping that advances at different points in the parse.
This is verified on the committed goldens (`no-layer-comments` is 3
against 4 distinct point-layer values) and is faithfully preserved, not a
bug to "fix" by deriving one from the other.
See the doc comment on `ParsedGcodeArrays.layers` in `src/types.ts` for
the full mechanism.

## The golden fixtures: read-only, produced only by Rust

`fixtures/gcode/`, `fixtures/parity/`, and `fixtures/pcode/` pin this
package's parser and decoder against the Rust implementation in
`procontrol-core` (ProControlTauri's `services/procontrol-core/src/
preview/`), so the two stay byte-for-byte identical and the remote (`pcode`)
preview never silently diverges from the local one.

**This package's tests read and assert against those fixtures. They never
write them.** There is no fixture-generation code in this repository, and
none should be added — regenerating fixtures requires the Rust parser and
codec, which live only in `procontrol-core`. The one and only generator is
`services/procontrol-core/src/bin/gen-preview-fixtures.rs`, run from the
ProControlTauri repo, which writes into this submodule; the change is then
committed here first and the parent's submodule pointer is bumped
afterward.

**If a parity test in this package fails: fix the parser, never
regenerate the fixture to match.** A failing parity test means this
package's TypeScript output disagrees with the Rust implementation's
output for the same input — that is the exact drift the test exists to
catch. Regenerating goldens from inside this package is not possible (no
generator lives here) and "fixing" the test by hand-editing a fixture
only defeats the guarantee for this repository's own CI; the moment
ProControlTauri bumps its submodule pointer, its Rust-side
`fixtures_match_committed_goldens` test reads the same (now-inconsistent)
goldens and fails there instead. There is no shortcut — a real parser
disagreement must be resolved in the parser (this package's TypeScript
side, or `procontrol-core`'s Rust side, or both), not papered over in the
fixtures.

## Design background

See ProControlTauri's `docs/superpowers/specs/
2026-07-19-protype-gcode-package-design.md` for the full design rationale,
including the four-parsers-three-repos history this package consolidates
and the parity-gate guarantees across the submodule boundary.
