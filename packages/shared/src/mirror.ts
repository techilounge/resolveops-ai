// Compile-time mirror assertion: A and B must be mutually assignable — the
// same shape in both directions. Shared DTOs use this to prove they stay
// compatible with the domain contracts they mirror; if a domain type drifts,
// the mirror line stops compiling.
export type MirrorWith<A, B> = A extends B ? (B extends A ? true : never) : never;
