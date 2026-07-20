/**
 * Feature-type discriminants. These values are a wire contract: the `.ptp`
 * format stores them as raw bytes and the Rust generator emits the same
 * numbers. Never renumber them.
 */
export const FEATURE_UNKNOWN = 0;
export const FEATURE_OUTER_WALL = 1;
export const FEATURE_INNER_WALL = 2;
export const FEATURE_INFILL = 3;
export const FEATURE_SOLID_INFILL = 4;
export const FEATURE_TOP_SURFACE = 5;
export const FEATURE_BOTTOM_SURFACE = 6;
export const FEATURE_SUPPORT = 7;
export const FEATURE_BRIDGE = 8;
export const FEATURE_SKIRT_BRIM = 9;
export const FEATURE_SEAM_START = 10;
