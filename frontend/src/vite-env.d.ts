/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

// Injected at build time by `define` in vite.config.ts.
declare const __BUILD_COMMIT__: string
declare const __BUILD_TIME__: string
