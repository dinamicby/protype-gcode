# pcode — Protype toolpath code, format specification v1

`pcode` is a compact, layer-indexed binary container for a 3D-print toolpath:
the move endpoints, per-move attributes, and layer structure needed to render
a print preview, at roughly 1/20th the size of the source G-code.

It is produced by the Rust encoder in `procontrol-core` and consumed by the
TypeScript decoder in this package. This document is normative: a conformant
implementation MUST produce and consume bytes exactly as described here, and
MUST decode the conformance fixtures in `fixtures/pcode/` into structures
identical to what the reference decoder produces.

## Conventions

All integers are little-endian. `u16`/`u32` are unsigned. `f32` is IEEE-754
single precision. A *varint* is an unsigned LEB128 value. A *zigzag varint*
encodes a signed value as `(n << 1) ^ (n >> 31)` then as a varint.

Coordinates X and Y are quantized to 0.01 mm; Z, extrusion width, and height
to 0.001 mm (micrometres).

## Header

| Field | Type | Notes |
|---|---|---|
| `magic` | 4 bytes | ASCII `PCOD` (`0x50 0x43 0x4F 0x44`) |
| `version` | u16 | `1` |
| `flags` | u16 | reserved; `0` in v1 |
| `bounds` | 6× f32 | `minX maxX minY maxY minZ maxZ` (mm) |
| `layer_count` | u32 | number of layer-table entries |
| `point_count` | u32 | total decoded points |
| `layer_z_count` | u32 | number of layer-Z entries |

A decoder MUST reject a buffer whose magic is not `PCOD` or whose version is not
`1`. A decoder MUST ignore any set bits in `flags` it does not recognize (they
are reserved for forward-compatible additions within version 1); it MUST NOT
reject a buffer solely because `flags` is non-zero.

## Layer-Z array

`layer_z_count` × `u32`, each a Z height in micrometres.

This array round-trips the source parser's `layers` list verbatim. On the
`;LAYER_CHANGE` slicer path it lags one layer behind the geometry, because the
slicer emits the layer comment before the Z move that raises the nozzle. It is
**not** an index space: `layer_z_count` does not always equal the number of
distinct point layers, and it MUST NOT be indexed by a point's layer id.

## Layer table

`layer_count` × 16-byte entry:

| Field | Type | Notes |
|---|---|---|
| `layer_id` | u32 | the source parser's actual point-layer value |
| `z_um` | u32 | Z the layer's points sit at, in micrometres |
| `offset` | u32 | byte offset of this layer's first opcode within the instruction stream |
| `count` | u32 | number of points in this layer |

`layer_id` is the parser's own layer number (from `;LAYER:N`, `; layer N`,
`;LAYER_CHANGE` counting, or the Z-change fallback), **not** a 0-based ordinal
and **not** an index into the layer-Z array. A decoded point's layer id MUST
equal exactly what the source parser produced for the same input. `z_um` here is
the Z the points actually sit at, used to reconstruct each point's Z; it is a
different quantity from the layer-Z array (see above) and neither is derivable
from the other.

## Instruction stream

Bytes from the end of the layer table to the end of the buffer. A sequence of
opcodes, decoded per layer starting at that layer's `offset`. Attributes change
rarely, so they are carried by state-setting opcodes rather than repeated per
point.

| Opcode | Byte | Payload | Effect |
|---|---|---|---|
| `SET_FEATURE` | `0x01` | u8 | set current feature type |
| `SET_TOOL` | `0x02` | u8 | set current tool index |
| `SET_FEEDRATE` | `0x03` | varint | set current feedrate (mm/min) |
| `SET_BEAD` | `0x04` | u16 width_um, u16 height_um | set current extrusion width/height |
| `MOVE_TO` | `0x05` | zigzag-varint dx, dy | one travel point (pen up) |
| `POLYLINE` | `0x06` | varint n, then n × (zigzag-varint dx, dy) | n extrusion points (pen down) |

X/Y deltas are relative to the previous point, in units of 0.01 mm. At every
layer boundary the encoder re-emits all four `SET_*` opcodes and writes that
layer's first coordinate as an absolute value (delta from zero), so each layer
decodes independently from its recorded `offset`. A point's Z is that layer's
`z_um`; travel points have "pen up", extrusion points "pen down".

## Feature-type discriminants

`SET_FEATURE`'s byte is one of:

`0` UNKNOWN, `1` OUTER_WALL, `2` INNER_WALL, `3` INFILL, `4` SOLID_INFILL,
`5` TOP_SURFACE, `6` BOTTOM_SURFACE, `7` SUPPORT, `8` BRIDGE, `9` SKIRT_BRIM,
`10` SEAM_START.

These are a wire contract and MUST NOT be renumbered.

## Versioning

`version` starts at 1. Any change to the byte layout increments it. A decoder
accepts exactly its own version and rejects all others; because pcode artifacts
are a regenerable cache and not an archive, there is no multi-version decoding.
`flags` is the only forward-compatibility surface within a version.

## Conformance

The seven fixtures under `fixtures/pcode/` are the conformance vectors. They are
generated only by the Rust encoder (`gen-preview-fixtures` in `procontrol-core`)
from the G-code under `fixtures/gcode/`. Any implementation MUST decode each
`.pcode` fixture into a structure identical to the reference decoder's output;
the golden summaries under `fixtures/parity/` pin the parser that feeds the
encoder. No implementation other than the Rust generator may write these
fixtures.
