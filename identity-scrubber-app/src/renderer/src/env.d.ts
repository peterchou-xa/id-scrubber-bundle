/// <reference types="vite/client" />

import type { OllamaApi, ScrubberApi, DialogApi } from '../../preload/index';

declare global {
  interface Window {
    ollama: OllamaApi;
    scrubber: ScrubberApi;
    dialogApi: DialogApi;
  }
}

export {};
