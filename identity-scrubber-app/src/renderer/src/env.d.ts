/// <reference types="vite/client" />

import type { OllamaApi, ScrubberApi } from '../../preload/index';

declare global {
  interface Window {
    ollama: OllamaApi;
    scrubber: ScrubberApi;
  }
}

export {};
