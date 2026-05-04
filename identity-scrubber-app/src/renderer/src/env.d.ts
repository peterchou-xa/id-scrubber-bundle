/// <reference types="vite/client" />

import type { GlinerApi, ScrubberApi, DialogApi } from '../../preload/index';

declare global {
  interface Window {
    gliner: GlinerApi;
    scrubber: ScrubberApi;
    dialogApi: DialogApi;
  }
}

export {};
