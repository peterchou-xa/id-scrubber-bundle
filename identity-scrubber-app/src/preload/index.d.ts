import type { OllamaApi, ScrubberApi } from './index';

declare global {
  interface Window {
    ollama: OllamaApi;
    scrubber: ScrubberApi;
  }
}

export {};
