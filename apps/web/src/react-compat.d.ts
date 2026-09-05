import "react";

declare module "react" {
  /** Compatibility overload for refs whose initial value is intentionally undefined. */
  function useRef<T = undefined>(): { current: T | undefined };
}
