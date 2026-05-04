import type { GlinerApi, ScrubberApi, DialogApi } from './index';

declare global {
  interface Window {
    gliner: GlinerApi;
    scrubber: ScrubberApi;
    dialogApi: DialogApi;
  }
}

export {};
