import type { OllamaApi, ScrubberApi, DialogApi } from './index';

declare global {
  interface Window {
    ollama: OllamaApi;
    scrubber: ScrubberApi;
    dialogApi: DialogApi;
  }
}

export {};
