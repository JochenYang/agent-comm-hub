import "react"

/**
 * React 18 typings predate the `inert` attribute (React 19 typed and implemented
 * it). beui's registry files are written against React 19, so the attribute is
 * declared here to keep them compiling unchanged.
 *
 * Runtime note: react-dom 18 does not know `inert` either, and silently drops
 * any attribute it receives as a boolean. Passing `""` sets the attribute for
 * real, so SelectContent writes `inert={!open ? "" : undefined}`.
 */
declare module "react" {
  interface HTMLAttributes<T> {
    inert?: "" | undefined
  }
}
