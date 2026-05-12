/// <reference types="vite/client" />

import type {
  GlinerApi,
  ScrubberApi,
  DialogApi,
  IdentifiersApi,
  BillingApi,
} from '../../preload/index';

declare global {
  interface Window {
    gliner: GlinerApi;
    scrubber: ScrubberApi;
    dialogApi: DialogApi;
    identifiers: IdentifiersApi;
    billing: BillingApi;
  }
}

export {};
