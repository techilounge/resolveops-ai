/// <reference types="vite/client" />

// Typed deployment config for the live web app. `VITE_API_BASE_URL` points
// the client at the API origin (Vercel preview / split hosting); empty or
// absent means same-origin — the Part A localhost topology.
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
