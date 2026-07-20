import type { GcodeLine, ParsedGcode, ParsedGcodeArrays } from "./types";

/**
 * Materialize the typed-array parse into the legacy `GcodeLine[]` shape.
 *
 * This is a compatibility layer for viewers that predate the array layout. It
 * allocates one object per point — the exact cost the array layout exists to
 * avoid — so a renderer that can read the arrays directly should do that
 * instead. Kept because migrating the viewers is a separate project.
 *
 * `e` is filled with 0: the field is absent from the canonical form because no
 * renderer reads it, and the `.ptp` decoder has always done the same.
 */
export function toLines(arrays: ParsedGcodeArrays): ParsedGcode {
  const lines: GcodeLine[] = new Array(arrays.count);
  for (let i = 0; i < arrays.count; i++) {
    lines[i] = {
      x: arrays.xs[i],
      y: arrays.ys[i],
      z: arrays.zs[i],
      e: 0,
      isTravel: arrays.isTravel[i] === 1,
      layer: arrays.layer[i],
      tool: arrays.tool[i],
      feedrate: arrays.feedrate[i],
      featureType: arrays.featureType[i],
      width: arrays.width[i],
      height: arrays.height[i],
    };
  }
  return { lines, layers: arrays.layers, bounds: arrays.bounds };
}
