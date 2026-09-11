// Twin of the curve helpers in src-tauri/src/color.rs.

/** DaVinci Intermediate log encoding (scene-linear -> log). */
export function davinciIntermediateEncode(l: number): number {
  return l <= 0.00262409 ? l * 10.44426855 : (Math.log2(l + 0.0075) + 7) * 0.07329248;
}
