/// <reference types="vite/client" />

import type { GlinerApi, ScrubberApi, DialogApi, IdentifiersApi } from '../../preload/index';

declare global {
  interface Window {
    gliner: GlinerApi;
    scrubber: ScrubberApi;
    dialogApi: DialogApi;
    identifiers: IdentifiersApi;
  }
}

export {};
