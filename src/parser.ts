/**
 * G-code parser for visualization.
 * Extracts move coordinates, layers, and bounding box from G-code text.
 *
 * This is a line-for-line port of the object-per-move parser at
 * `apps/procontrol/src/utils/gcode-parser.ts` in the ProControlTauri repo.
 * Only the accumulation strategy changed: instead of pushing an object per
 * move onto an array, moves are appended to growable typed arrays via
 * `PointBuilder`. Every branch, its order, and its semantics carry over
 * unchanged — including quirks that look like bugs (see `types.ts` for the
 * `layers` field) — because the Rust preview generator is a line-for-line
 * port of the same original and the two must keep agreeing byte-for-byte.
 *
 * Layer detection strategy:
 * 1. Slicer comments (;LAYER:N, ;LAYER_CHANGE, ; layer N) — most reliable
 * 2. Z-change with extrusion on new Z — fallback for uncommented gcode
 *
 * Z-hop aware: ignores Z changes during travel moves (no extrusion).
 */

import type { Bounds, ParsedGcodeArrays } from "./types";
import {
  FEATURE_UNKNOWN, FEATURE_OUTER_WALL, FEATURE_INNER_WALL, FEATURE_INFILL,
  FEATURE_SOLID_INFILL, FEATURE_TOP_SURFACE, FEATURE_BOTTOM_SURFACE,
  FEATURE_SUPPORT, FEATURE_BRIDGE, FEATURE_SKIRT_BRIM, FEATURE_SEAM_START,
} from "./features";

const INITIAL_CAPACITY = 1024;

/** Grows typed arrays by doubling, then trims them to the exact point count. */
class PointBuilder {
  private cap = INITIAL_CAPACITY;
  count = 0;
  xs = new Float32Array(INITIAL_CAPACITY);
  ys = new Float32Array(INITIAL_CAPACITY);
  zs = new Float32Array(INITIAL_CAPACITY);
  layer = new Uint32Array(INITIAL_CAPACITY);
  featureType = new Uint8Array(INITIAL_CAPACITY);
  tool = new Uint8Array(INITIAL_CAPACITY);
  isTravel = new Uint8Array(INITIAL_CAPACITY);
  feedrate = new Float32Array(INITIAL_CAPACITY);
  width = new Float32Array(INITIAL_CAPACITY);
  height = new Float32Array(INITIAL_CAPACITY);

  private grow(): void {
    const next = this.cap * 2;
    const f32 = (a: Float32Array) => {
      const b = new Float32Array(next);
      b.set(a);
      return b;
    };
    const u32 = (a: Uint32Array) => {
      const b = new Uint32Array(next);
      b.set(a);
      return b;
    };
    const u8 = (a: Uint8Array) => {
      const b = new Uint8Array(next);
      b.set(a);
      return b;
    };
    this.xs = f32(this.xs); this.ys = f32(this.ys); this.zs = f32(this.zs);
    this.feedrate = f32(this.feedrate); this.width = f32(this.width); this.height = f32(this.height);
    this.layer = u32(this.layer);
    this.featureType = u8(this.featureType); this.tool = u8(this.tool); this.isTravel = u8(this.isTravel);
    this.cap = next;
  }

  push(
    x: number, y: number, z: number, isTravel: boolean, layer: number,
    tool: number, feedrate: number, featureType: number, width: number, height: number,
  ): void {
    if (this.count === this.cap) this.grow();
    const i = this.count++;
    this.xs[i] = x; this.ys[i] = y; this.zs[i] = z;
    this.isTravel[i] = isTravel ? 1 : 0;
    this.layer[i] = layer; this.tool[i] = tool; this.feedrate[i] = feedrate;
    this.featureType[i] = featureType; this.width[i] = width; this.height[i] = height;
  }

  /** Trim every array to `count` so `xs.length === count` holds for callers. */
  finish(layers: number[], bounds: Bounds): ParsedGcodeArrays {
    const n = this.count;
    return {
      xs: this.xs.slice(0, n), ys: this.ys.slice(0, n), zs: this.zs.slice(0, n),
      layer: this.layer.slice(0, n),
      featureType: this.featureType.slice(0, n), tool: this.tool.slice(0, n),
      isTravel: this.isTravel.slice(0, n),
      feedrate: this.feedrate.slice(0, n), width: this.width.slice(0, n), height: this.height.slice(0, n),
      count: n, layers, bounds,
    };
  }
}

function classifyFeatureType(value: string): number {
  const t = value.toLowerCase();
  if (t.includes("outer") || t.includes("external perimeter")) return FEATURE_OUTER_WALL;
  if (t.includes("inner") || t.includes("perimeter") || t.includes("wall")) return FEATURE_INNER_WALL;
  if (t.includes("top")) return FEATURE_TOP_SURFACE;
  if (t.includes("bottom")) return FEATURE_BOTTOM_SURFACE;
  if (t.includes("solid")) return FEATURE_SOLID_INFILL;
  if (t.includes("bridge")) return FEATURE_BRIDGE;
  if (t.includes("support")) return FEATURE_SUPPORT;
  if (t.includes("infill") || t.includes("fill")) return FEATURE_INFILL;
  if (t.includes("skirt") || t.includes("brim") || t.includes("prime tower")) return FEATURE_SKIRT_BRIM;
  return FEATURE_UNKNOWN;
}

/**
 * Consumes the longest valid numeric prefix of `s`, exactly matching
 * JavaScript's built-in `parseFloat` grammar: leading whitespace, an
 * optional sign, then digits/decimal/exponent or the literal `Infinity`
 * (case-sensitive) — stopping at the first character that doesn't fit
 * (e.g. "10abc" reads as 10; "inf" has no valid prefix and yields NaN).
 *
 * Named explicitly, rather than calling `parseFloat` inline at each call
 * site, because the Rust parser has no equivalent primitive and hand-rolls
 * this exact grammar from scratch — naming it here keeps the two
 * implementations pointing at one spec instead of an implicit JS built-in.
 */
function parseFloatPrefix(s: string): number {
  return parseFloat(s);
}

export function parseGcode(text: string): ParsedGcodeArrays {
  const builder = new PointBuilder();
  let x = 0, y = 0, z = 0, e = 0, feedrate = 1500;
  let layer = -1;
  let tool = 0; // current tool (T0, T1, ...)
  let featureType = FEATURE_UNKNOWN;
  // Absent means absent: a fabricated default reads downstream as a measured
  // value the file never stated. The viewer's legend has a path for a range
  // with no variation; it has none for a plausible lie.
  let width = 0;
  let height = 0;
  let isRelative = false;
  let isRelativeE = false;
  const layerZs: number[] = [];
  let lastTravelHadLift = false;
  let lastTravelWasRetract = false;

  // Track Z for layer detection (ignoring Z-hop)
  let layerZ = 0;        // Z height of current layer (ignoring hops)
  let hasSlicerLayers = false; // true if we found slicer layer comments
  // Set when `; CHANGE_LAYER` has advanced `layer` but its Z is not yet
  // known. Cleared either by the `; Z_HEIGHT:` that should follow, or, if
  // that never comes, by the new layer's first extruding move (see both
  // sites below). Deliberately state-then-record rather than guess-then-
  // correct: guessing a Z at `; CHANGE_LAYER` time and overwriting it once
  // the real value is known means pushing a value into `layerZs` before it
  // is known, and `pushLayerZ`'s dedup silently drops that guess whenever it
  // collides with a value already in the list — which, for consecutive
  // layers, it always eventually does, collapsing every layer down to one
  // shared entry.
  let awaitingLayerZ = false;

  const pushLayerZ = (v: number): void => {
    if (!layerZs.includes(v)) layerZs.push(v);
  };

  // First pass: check if file has slicer layer markers
  const hasLayerComments =
    /;(?:LAYER:|LAYER_CHANGE| layer \d)/im.test(text)
    // Protype's slicer (an Orca fork) writes `; CHANGE_LAYER`. Anchored to
    // the whole line so an Orca `change_layer_gcode` setting — written into
    // the file's header as a `key = value` comment — cannot match.
    || /^;\s*CHANGE_LAYER\s*$/im.test(text);

  const gcodeLines = text.split('\n');
  for (const rawLine of gcodeLines) {
    const commentIdx = rawLine.indexOf(';');
    const comment = commentIdx >= 0 ? rawLine.substring(commentIdx) : '';
    const line = (commentIdx >= 0 ? rawLine.substring(0, commentIdx) : rawLine).trim();

    if (comment) {
      const tail = comment.slice(1).trim();
      const lower = tail.toLowerCase();
      if (lower.startsWith("type:")) {
        featureType = classifyFeatureType(tail.slice(5).trim());
      } else if (lower.startsWith("feature:")) {
        // Protype's slicer spells the same thing `; FEATURE: Outer wall`.
        featureType = classifyFeatureType(tail.slice(8).trim());
      } else if (lower.startsWith("width:")) {
        const nextWidth = parseFloatPrefix(tail.slice(6).trim());
        if (!Number.isNaN(nextWidth) && nextWidth > 0) width = nextWidth;
      } else if (lower.startsWith("layer_height:")) {
        const nextHeight = parseFloatPrefix(tail.slice(13).trim());
        if (!Number.isNaN(nextHeight) && nextHeight > 0) height = nextHeight;
      } else if (lower.startsWith("height:")) {
        const nextHeight = parseFloatPrefix(tail.slice(7).trim());
        if (!Number.isNaN(nextHeight) && nextHeight > 0) height = nextHeight;
      } else if (lower.startsWith("z_height:")) {
        // `; Z_HEIGHT:` arrives on the line after `; CHANGE_LAYER` and states
        // the new layer's Z exactly — record it now, rather than guessing at
        // `; CHANGE_LAYER` time and fixing the guess up later (see
        // `awaitingLayerZ`'s doc comment for why that failed). A
        // `; Z_HEIGHT:` with no pending layer change is stray — Orca's
        // config block can carry arbitrary key/value comments — so ignore it
        // rather than recording a Z for a layer transition that never
        // happened.
        const nextZ = parseFloatPrefix(tail.slice(9).trim());
        if (!Number.isNaN(nextZ) && awaitingLayerZ) {
          pushLayerZ(nextZ);
          awaitingLayerZ = false;
        }
      }
    }

    // ─── Slicer layer comments ───
    if (hasLayerComments) {
      // PrusaSlicer/SuperSlicer: ;LAYER_CHANGE
      // Cura: ;LAYER:0, ;LAYER:1
      // Simplify3D: ; layer 1, z = 0.300
      // OrcaSlicer: ;LAYER_CHANGE then ; Z_HEIGHT:0.3

      const layerMatch = comment.match(/;LAYER:(\d+)/i)
        || comment.match(/; layer (\d+)/i);
      if (layerMatch) {
        layer = parseInt(layerMatch[1], 10);
        hasSlicerLayers = true;
        pushLayerZ(z);
        continue;
      }

      if (/;LAYER_CHANGE/i.test(comment)) {
        layer++;
        hasSlicerLayers = true;
        pushLayerZ(z);
        continue;
      }

      // Protype's slicer (an Orca fork) writes `; CHANGE_LAYER` — the words
      // the other way round from PrusaSlicer's `;LAYER_CHANGE` above, so the
      // two never collide. Matched on the whole trimmed comment body being
      // exactly this word, not a substring: an Orca profile can carry a
      // `change_layer_gcode` setting, and the config block is written into
      // the file as comments.
      //
      // Unlike the `;LAYER_CHANGE` branch above, this does NOT push a Z
      // here. `;LAYER_CHANGE`-style slicers give no other signal, so that
      // branch pushes the current (pre-transition) `z` as its best guess —
      // which is why `pcode-decoder.ts` documents the `;LAYER_CHANGE` path
      // as disagreeing with point Z by one layer, and that disagreement is
      // preserved end-to-end deliberately. Protype's slicer gives strictly
      // more signal — an explicit `; Z_HEIGHT:` right after this comment —
      // so this path can and does record the exact value instead of
      // guessing one (see `awaitingLayerZ` and its two consumers). That the
      // two marker styles now disagree in accuracy is intentional, not a
      // regression to reconcile: `;LAYER_CHANGE` files must keep parsing
      // exactly as they do today.
      if (comment.slice(1).trim().toLowerCase() === "change_layer") {
        layer++;
        hasSlicerLayers = true;
        awaitingLayerZ = true;
        continue;
      }
    }

    if (!line) continue;

    // ─── Tool change (IDEX / multi-extruder) ───
    const toolMatch = line.match(/^T(\d+)/);
    if (toolMatch) {
      tool = parseInt(toolMatch[1], 10);
      continue;
    }

    // ─── Mode switches ───
    if (line === 'G91') { isRelative = true; continue; }
    if (line === 'G90') { isRelative = false; continue; }
    if (line === 'M82') { isRelativeE = false; continue; }
    if (line === 'M83') { isRelativeE = true; continue; }
    // G28 — home, reset position
    if (line.startsWith('G28')) { x = 0; y = 0; z = 0; continue; }
    // G92 — set position (without moving)
    if (line.startsWith('G92')) {
      const parts = line.split(/\s+/);
      for (const p of parts) {
        const val = parseFloatPrefix(p.slice(1));
        if (isNaN(val)) continue;
        switch (p[0]) {
          case 'X': x = val; break;
          case 'Y': y = val; break;
          case 'Z': z = val; break;
          case 'E': e = val; break;
        }
      }
      continue;
    }

    // ─── Movement commands ───
    if (/^G[01]\s/.test(line) || line === 'G0' || line === 'G1') {
      let newX = x, newY = y, newZ = z, newE = e;
      let hasE = false;

      const parts = line.split(/\s+/);
      for (const p of parts) {
        const val = parseFloatPrefix(p.slice(1));
        if (isNaN(val)) continue;
        switch (p[0]) {
          case 'X': newX = isRelative ? x + val : val; break;
          case 'Y': newY = isRelative ? y + val : val; break;
          case 'Z': newZ = isRelative ? z + val : val; break;
          case 'E': newE = isRelativeE ? e + val : val; hasE = true; break;
          case 'F': feedrate = val; break;
        }
      }

      const isTravel = !hasE || (isRelativeE ? newE <= 0 : newE <= e);
      const isExtrusion = !isTravel;

      // ─── Fallback layer detection (no slicer comments) ───
      // Only count a new layer when:
      // 1. Z changed upward from the last known layer Z
      // 2. This move or a nearby move extrudes (not just Z-hop for travel)
      if (!hasSlicerLayers && newZ > layerZ + 0.01) {
        if (isExtrusion) {
          // Extrusion at new Z height — definitely a new layer
          layer++;
          layerZ = newZ;
          pushLayerZ(newZ);
        }
        // If travel at new Z — might be Z-hop, don't count yet.
        // The layer will be counted when we extrude at this Z.
      }
      if (awaitingLayerZ && isExtrusion) {
        // `; CHANGE_LAYER` fired but no `; Z_HEIGHT:` followed — not every
        // Orca-derived profile is guaranteed to emit one. Fall back to the
        // new layer's first extruding move for its Z, the same shape the
        // no-marker heuristic just above already uses.
        pushLayerZ(newZ);
        awaitingLayerZ = false;
      }

      // If we haven't assigned any layer yet, start at 0
      if (layer < 0) layer = 0;

      const lineFeatureType = isExtrusion && featureType === FEATURE_OUTER_WALL && (lastTravelHadLift || lastTravelWasRetract)
        ? FEATURE_SEAM_START
        : featureType;
      builder.push(newX, newY, newZ, isTravel, layer, tool, feedrate, lineFeatureType, width, height);
      if (isExtrusion) {
        lastTravelHadLift = false;
        lastTravelWasRetract = false;
      } else {
        if (newZ > z + 1e-6) lastTravelHadLift = true;
        if (hasE && (isRelativeE ? newE : newE - e) < -1e-6) lastTravelWasRetract = true;
      }
      x = newX; y = newY; z = newZ; e = newE;
    }
  }

  // ─── Compute bounds ───
  // Iterates `builder.xs/ys/zs`, which are already float32-precision (the
  // typed arrays narrow on write in `PointBuilder.push`), whereas the
  // original iterated full-precision doubles. This is a deliberate deviation
  // from the original port: it mirrors the Rust implementation, whose
  // `PreviewModel::compute_bounds` (services/procontrol-core/src/preview/
  // model.rs) also runs over `f32` fields, and it is the only sensible choice
  // given this struct-of-arrays layout — there is no full-precision source
  // left to iterate once points are written into typed-array storage.
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < builder.count; i++) {
    const px = builder.xs[i], py = builder.ys[i], pz = builder.zs[i];
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
    if (pz < minZ) minZ = pz;
    if (pz > maxZ) maxZ = pz;
  }

  const bounds: Bounds = {
    minX: isFinite(minX) ? minX : 0,
    maxX: isFinite(maxX) ? maxX : 220,
    minY: isFinite(minY) ? minY : 0,
    maxY: isFinite(maxY) ? maxY : 220,
    minZ: isFinite(minZ) ? minZ : 0,
    maxZ: isFinite(maxZ) ? maxZ : 100,
  };

  // `layerZs` accumulates the same raw-double `z`/`newZ` values the original
  // parser used; sort ascending exactly as the original does, with no
  // precision narrowing — this field is a straight, faithful port.
  const layers = [...layerZs].sort((a, b) => a - b);

  return builder.finish(layers, bounds);
}
