/**
 * Bounding box of all parsed points. Computed from `ParsedGcodeArrays`'s
 * typed-array storage, so each field is float32-precision (narrowed on
 * write into `xs`/`ys`/`zs`) even though the type is `number` — this
 * matches the Rust side's `f32` bounds fields.
 */
export interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

/**
 * The canonical parse result: struct-of-arrays, one entry per move endpoint.
 *
 * `isTravel` is a pen-up marker — consecutive non-travel entries form one
 * polyline. There is deliberately no `e` field: no renderer reads it, and at
 * 200k points it would cost 800 KB for nothing.
 *
 * All typed arrays are exactly `count` long — the builder trims them — so
 * `xs.length === count` holds and callers can iterate either way.
 *
 * `xs`, `ys`, `zs`, `feedrate`, `width`, and `height` are `Float32Array`s, so
 * every value they hold is float32-precision. `layers` and `bounds` are
 * plain `number`/`number[]`, but `bounds` is derived from this same
 * float32-precision storage (see `parser.ts`'s bounds computation) — only
 * `layers` retains full f64 precision, carried over unchanged from the
 * original parser's raw `z` tracking.
 */
export interface ParsedGcodeArrays {
  xs: Float32Array;
  ys: Float32Array;
  zs: Float32Array;
  layer: Uint32Array;
  featureType: Uint8Array;
  tool: Uint8Array;
  /** 1 = travel (pen up), 0 = extrusion. */
  isTravel: Uint8Array;
  feedrate: Float32Array;
  width: Float32Array;
  height: Float32Array;
  count: number;
  /**
   * Distinct layer Z heights the parser recorded, ascending.
   *
   * NOT a layer index: `layers.length` does not always equal the number of
   * distinct `layer` values, and `layers[layer]` is not a valid lookup.
   * Verified on the goldens — `no-layer-comments` is 3 against 4, `simplify3d`
   * is 1 against 2. The counts diverge because the bookkeeping that fills
   * `layers` and the counter that assigns `layer` advance at different points
   * in the parse loop. Pre-existing behaviour, faithfully ported; do not
   * "fix" it by deriving one from the other.
   */
  layers: number[];
  bounds: Bounds;
}

/** One move endpoint in the legacy object form. `e` is always 0. */
export interface GcodeLine {
  x: number;
  y: number;
  z: number;
  e: number;
  isTravel: boolean;
  layer: number;
  tool: number;
  feedrate: number;
  featureType: number;
  width: number;
  height: number;
}

export interface ParsedGcode {
  lines: GcodeLine[];
  layers: number[];
  bounds: Bounds;
}
